import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type OfficeCliBackend,
  createOfficeCliBackend,
} from "../../src/plugins/builtin/officecli/backend";
import { ForgeError } from "../../src/shared/errors";

const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const qaRoot = join(projectRoot, ".forge", "tmp", "officecli", "backend-tests");
const fixturePath = fileURLToPath(
  new URL("../fixtures/officecli-process.mjs", import.meta.url),
);
const posix = process.platform !== "win32";
const describeBackend = posix ? describe : describe.skip;

interface FixtureRecord {
  readonly pid: number;
  readonly mode: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly childPid?: number;
}

interface Harness {
  readonly caseDir: string;
  readonly workspace: string;
  readonly home: string;
  readonly executable: string;
  readonly recordPath: string;
  readonly backend: OfficeCliBackend;
  readRecord(): Promise<FixtureRecord>;
  waitForRecord(timeoutMs?: number): Promise<FixtureRecord>;
}

interface HarnessOptions {
  readonly executablePath?: string;
  readonly resolveBare?: boolean;
}

let suiteRoot = "";
const cleanups: (() => Promise<void>)[] = [];
const envRestores: (() => void)[] = [];

beforeAll(async () => {
  await mkdir(qaRoot, { recursive: true });
  suiteRoot = await mkdtemp(join(qaRoot, "run-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => undefined);
  for (const restore of envRestores.splice(0).reverse()) restore();
});

afterAll(async () => {
  if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
});

function setEnv(key: string, value: string): void {
  const previous = process.env[key];
  process.env[key] = value;
  envRestores.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

const signal = (): AbortSignal => new AbortController().signal;

const options = (
  overrides: Partial<{
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  }> = {},
) => ({
  signal: signal(),
  timeoutMs: 5_000,
  ...overrides,
});

async function harness(input: HarnessOptions = {}): Promise<Harness> {
  const caseDir = await mkdtemp(join(suiteRoot, "case-"));
  const workspace = join(caseDir, "workspace");
  const home = join(caseDir, "home");
  const binDir = join(workspace, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "officecli");
  await copyFile(fixturePath, executable);
  await chmod(executable, 0o755);

  if (input.resolveBare) {
    setEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
  }
  const executablePath = input.resolveBare
    ? "officecli"
    : (input.executablePath ?? executable);
  const backend = await createOfficeCliBackend(
    { executablePath },
    { home, workspace },
  );
  cleanups.push(async () => {
    await backend.dispose().catch(() => undefined);
    await rm(caseDir, { recursive: true, force: true });
  });

  const recordPath = join(workspace, ".officecli-fixture.json");
  const readRecord = async (): Promise<FixtureRecord> => {
    return JSON.parse(await readFile(recordPath, "utf8")) as FixtureRecord;
  };
  return {
    caseDir,
    workspace,
    home,
    executable,
    recordPath,
    backend,
    readRecord,
    async waitForRecord(timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          return await readRecord();
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        }
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describeBackend("stateless OfficeCLI process backend", () => {
  it("does not launch on creation and passes explicit argv, workspace cwd and a clean private environment", async () => {
    setEnv("FORGE_OFFICECLI_TEST_TOKEN", "must-not-leak");
    setEnv("NODE_OPTIONS", "--no-warnings");
    const h = await harness();
    await expect(access(h.recordPath)).rejects.toThrow();

    const args = [
      "view",
      "my report.docx",
      "text",
      "--prop",
      "note=$(touch should-not-exist) && echo 'x' | cat; *",
      "semi;colon",
      "--literal",
      "$HOME",
      "`id`",
    ];
    const result = await h.backend.execute(args, options());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fixture-ok");
    expect(result.stdout).toContain(JSON.stringify(args));
    expect(result.stderr).toBe("fixture-stderr\n");
    expect(result.truncated).toBe(false);

    const record = await h.readRecord();
    expect(record.args).toEqual(args);
    expect(record.cwd).toBe(h.workspace);
    await expect(
      access(join(h.workspace, "should-not-exist")),
    ).rejects.toThrow();

    const env = record.env;
    const privateRoot = dirname(env.HOME ?? "");
    expect(env.HOME).toBeDefined();
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(resolve(env.HOME ?? "")).toContain(resolve(h.home));
    expect(privateRoot).toContain(resolve(h.home));
    expect(privateRoot.split(/[\\/]/).at(-1)).toMatch(/^officecli-/);
    expect(env.XDG_CACHE_HOME).toBe(join(privateRoot, "cache"));
    expect(env.XDG_CONFIG_HOME).toBe(join(privateRoot, "config"));
    expect(env.XDG_DATA_HOME).toBe(join(privateRoot, "data"));
    expect(env.APPDATA).toBe(join(privateRoot, "config"));
    expect(env.LOCALAPPDATA).toBe(join(privateRoot, "data"));
    expect(env.TMPDIR).toBe(join(privateRoot, "tmp"));
    expect(env.TMP).toBe(env.TMPDIR);
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.OFFICECLI_NO_AUTO_RESIDENT).toBe("1");
    expect(env.OFFICECLI_SKIP_UPDATE).toBe("1");
    expect(env.FORGE_OFFICECLI_TEST_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    for (const directory of [
      env.HOME,
      env.XDG_CACHE_HOME,
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.TMPDIR,
    ]) {
      if (!directory) throw new Error("fixture environment is incomplete");
      expect((await stat(directory)).isDirectory()).toBe(true);
    }

    await h.backend.dispose();
    await expect(access(privateRoot)).rejects.toThrow();
    const afterDispose = await errorOf(
      h.backend.execute(["--mode", "normal"], options()),
    );
    expect(afterDispose).toBeInstanceOf(ForgeError);
    expect((afterDispose as ForgeError).code).toBe("cancelled");
  });

  it("resolves a bare executable through PATH and a slash-relative path against the workspace", async () => {
    const bare = await harness({ resolveBare: true });
    const bareResult = await bare.backend.execute(
      ["--mode", "normal"],
      options(),
    );
    expect(bareResult.exitCode).toBe(0);
    expect((await bare.readRecord()).args).toEqual(["--mode", "normal"]);

    const relative = await harness({ executablePath: "bin/officecli" });
    const relativeResult = await relative.backend.execute(
      ["--mode", "normal"],
      options(),
    );
    expect(relativeResult.exitCode).toBe(0);
    expect((await relative.readRecord()).cwd).toBe(relative.workspace);
  });

  it("bounds output in memory, consumes the remainder, and never kills an ordinary command", async () => {
    const h = await harness();
    const result = await h.backend.execute(
      ["--mode", "truncate", "--bytes", "200000"],
      options({ maxOutputBytes: 256 }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(256);
    expect(result.stdout).toBe("A".repeat(256));
    expect(
      await readFile(join(h.workspace, ".officecli-fixture-done"), "utf8"),
    ).toBe("done\n");

    const logPath = join(h.workspace, ".officecli-fixture.log");
    const launches = (text: string) => text.trim().split("\n").length;
    const before = launches(await readFile(logPath, "utf8"));
    const tooLarge = await errorOf(
      h.backend.execute([], {
        signal: signal(),
        timeoutMs: 100,
        maxOutputBytes: 8 * 1024 * 1024 + 1,
      }),
    );
    expect(tooLarge).toBeInstanceOf(ForgeError);
    expect((tooLarge as ForgeError).code).toBe("invalid_input");
    // An invalid cap is rejected before executable resolution or spawn.
    expect(launches(await readFile(logPath, "utf8"))).toBe(before);
  });

  it("decodes UTF-8 safely, including invalid trailing bytes", async () => {
    const h = await harness();
    const result = await h.backend.execute(["--mode", "utf8"], options());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("héllo 世界 🚀");
    expect(result.stdout).toContain("\uFFFD");
    expect(result.truncated).toBe(false);
  });

  it("reports a nonzero exit without throwing and preserves both streams", async () => {
    const h = await harness();
    const result = await h.backend.execute(["--mode", "exit"], options());
    expect(result).toEqual({
      stdout: "before-exit\n",
      stderr: "fixture-failure\n",
      exitCode: 7,
      truncated: false,
    });
  });

  it("fails with a static tool error for a missing absolute or bare program", async () => {
    const h = await harness({ executablePath: "missing/officecli" });
    await expect(access(h.recordPath)).rejects.toThrow();
    const missing = await errorOf(
      h.backend.execute(["--mode", "normal"], options()),
    );
    expect(missing).toBeInstanceOf(ForgeError);
    expect(missing).toMatchObject({ code: "tool", retryable: false });
    expect((missing as ForgeError).message).toContain("not found");
    expect((missing as ForgeError).message).not.toContain(h.caseDir);

    const bare = await harness({ executablePath: "forge-no-such-officecli" });
    const bareMissing = await errorOf(
      bare.backend.execute(["--mode", "normal"], options()),
    );
    expect(bareMissing).toBeInstanceOf(ForgeError);
    expect((bareMissing as ForgeError).code).toBe("tool");
    expect((bareMissing as ForgeError).message).toContain("not found");
  });

  it("times out with an actionable no-retry tool error and joins the process", async () => {
    const h = await harness();
    const started = Date.now();
    const error = await errorOf(
      h.backend.execute(["--mode", "hang"], {
        signal: signal(),
        timeoutMs: 1_000,
      }),
    );
    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ code: "tool", retryable: false });
    expect((error as ForgeError).message).toContain("timed out");
    expect((error as ForgeError).message).toContain("not retried");
    expect((error as ForgeError).message).toContain("uncertain");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    const record = await h.waitForRecord();
    expect(isAlive(record.pid)).toBe(false);
  });

  it("throws cancellation, joins the process, and leaves no private directory on dispose", async () => {
    const h = await harness();
    const pending = h.backend.execute(["--mode", "hang"], options());
    const outcome = errorOf(pending);
    const record = await h.waitForRecord();
    h.backend.dispose();
    const error = await outcome;
    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ code: "cancelled", retryable: false });
    expect((error as ForgeError).message).toContain("not replayed");
    await h.backend.dispose();
    expect(isAlive(record.pid)).toBe(false);
    await expect(access(dirname(record.env.HOME ?? ""))).rejects.toThrow();
    const afterDispose = await errorOf(
      h.backend.execute(["--mode", "normal"], options()),
    );
    expect(afterDispose).toBeInstanceOf(ForgeError);
    expect((afterDispose as ForgeError).code).toBe("cancelled");
  });

  it("throws cancellation when the caller aborts, and joins the process", async () => {
    const h = await harness();
    const controller = new AbortController();
    const pending = h.backend.execute(
      ["--mode", "hang"],
      options({ signal: controller.signal }),
    );
    const outcome = errorOf(pending);
    const record = await h.waitForRecord();
    controller.abort();
    const error = await outcome;
    expect(error).toBeInstanceOf(ForgeError);
    expect(error).toMatchObject({ code: "cancelled", retryable: false });
    expect((error as ForgeError).message).toContain("not retried");
    expect(isAlive(record.pid)).toBe(false);
  });

  it("escalates to SIGKILL for an owned descendant after the leader has closed", async () => {
    const h = await harness();
    const started = Date.now();
    const error = await errorOf(
      h.backend.execute(["--mode", "termination-tree"], {
        signal: signal(),
        timeoutMs: 500,
      }),
    );
    expect(error).toBeInstanceOf(ForgeError);
    expect((error as ForgeError).code).toBe("tool");
    expect((error as ForgeError).message).toContain("timed out");
    // The leader exits on SIGTERM; only the 1s group escalation can remove the
    // SIGTERM-ignoring grandchild, so the backend must not settle before then.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    const record = await h.waitForRecord();
    expect(record.childPid).toBeTypeOf("number");
    expect(isAlive(record.pid)).toBe(false);
    expect(isAlive(record.childPid ?? 0)).toBe(false);
  });

  it("rejects invalid arguments and invalid limits before launching", async () => {
    const h = await harness();
    await expect(
      h.backend.execute(["--prop", "bad\0arg"], options()),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      h.backend.execute([], { signal: signal(), timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      h.backend.execute([], {
        signal: signal(),
        timeoutMs: 100,
        maxOutputBytes: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      createOfficeCliBackend(
        { executablePath: "" },
        { home: join(h.caseDir, "other-home"), workspace: h.workspace },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(access(h.recordPath)).rejects.toThrow();
    await expect(
      readFile(join(h.workspace, ".officecli-fixture.log"), "utf8"),
    ).rejects.toThrow();
  });
});
