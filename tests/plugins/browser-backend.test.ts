import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentBrowserBackend,
  createAgentBrowserBackend,
} from "../../src/plugins/builtin/browser/backend";
import { browserPluginConfigSchema } from "../../src/shared/plugins";

const fixture = fileURLToPath(
  new URL("../fixtures/agent-browser-mcp.mjs", import.meta.url),
);

interface Start {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

interface Harness {
  readonly root: string;
  readonly home: string;
  readonly record: string;
  readonly backend: AgentBrowserBackend;
  start(): Promise<Start>;
  calls(): Promise<readonly { name: string; args: Record<string, unknown> }[]>;
  cleanup(): Promise<
    | { readonly args: readonly string[]; readonly env: Record<string, string> }
    | undefined
  >;
  read(name: string): Promise<Record<string, unknown> | undefined>;
}

const active: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of active.splice(0))
    await dispose().catch(() => undefined);
});

async function harness(
  options: {
    readonly mode?: string;
    readonly domains?: readonly string[];
    readonly browserExecutablePath?: string;
    readonly redactValues?: readonly string[];
    readonly cleanupExit?: number;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "forge-ab-test-"));
  const record = join(root, "record");
  const home = join(root, "forge-home");
  await mkdir(record, { recursive: true });
  await mkdir(home, { recursive: true });
  const outside = join(root, "outside.png");
  const executable = join(root, "agent-browser");
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      `export FORGE_AB_FIXTURE_RECORD=${JSON.stringify(record)}`,
      `export FORGE_AB_FIXTURE_MODE=${JSON.stringify(options.mode ?? "normal")}`,
      `export FORGE_AB_FIXTURE_CLEANUP_EXIT=${JSON.stringify(String(options.cleanupExit ?? 0))}`,
      `export FORGE_AB_FIXTURE_OUTSIDE=${JSON.stringify(outside)}`,
      // The backend probes for this private socket path as daemon evidence.
      `export FORGE_AB_FIXTURE_DAEMON_PID="$AGENT_BROWSER_SOCKET_DIR/namespaces/$AGENT_BROWSER_NAMESPACE/run/$AGENT_BROWSER_SESSION.sock"`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const config = browserPluginConfigSchema.parse({
    executablePath: executable,
    browserExecutablePath: options.browserExecutablePath ?? "",
    allowedDomains: [...(options.domains ?? ["127.0.0.1", "localhost"])],
  });
  const backend = await createAgentBrowserBackend(config, {
    home,
    ...(options.redactValues ? { redactValues: options.redactValues } : {}),
  });
  let disposed = false;
  active.push(async () => {
    await backend.dispose().catch(() => undefined);
    if (disposed) return;
    disposed = true;
    // Failure fixtures intentionally retain daemon evidence. Their mock process
    // has exited, so also remove only the external temp paths it recorded.
    const start = await read("start.json");
    const env = start?.env as Record<string, unknown> | undefined;
    for (const path of [env?.TMPDIR, env?.AGENT_BROWSER_SOCKET_DIR]) {
      if (
        typeof path === "string" &&
        [tmpdir(), "/tmp"].includes(dirname(path)) &&
        /^forge-ab-credentials-(?:tmp|sock)-[A-Za-z0-9]{6}$/.test(
          basename(path),
        )
      )
        await rm(path, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  });
  const read = async (name: string) => {
    try {
      return JSON.parse(await readFile(join(record, name), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return undefined;
    }
  };
  return {
    root,
    home,
    record,
    backend,
    async start() {
      const value = await read("start.json");
      if (!value) throw new Error("fixture did not start");
      const args = value.args;
      const cwd = value.cwd;
      const env = value.env;
      if (
        !Array.isArray(args) ||
        typeof cwd !== "string" ||
        typeof env !== "object" ||
        env === null
      )
        throw new Error("fixture start record is malformed");
      return {
        args: args as string[],
        cwd,
        env: env as Record<string, string>,
      };
    },
    async calls() {
      const value = await read("calls.json");
      return (value ?? []) as unknown as readonly {
        name: string;
        args: Record<string, unknown>;
      }[];
    },
    async cleanup() {
      const value = await read("cleanup.json");
      if (!value) return undefined;
      return {
        args: value.args as string[],
        env: value.env as Record<string, string>,
      };
    },
    read,
  };
}

describe("agent-browser backend", () => {
  it("checks the core MCP toolset without launching a browser, in a private run directory", async () => {
    const previous = process.env.FORGE_BACKEND_TEST_SECRET;
    const previousProfile = process.env.AGENT_BROWSER_PROFILE;
    process.env.FORGE_BACKEND_TEST_SECRET = "must-not-be-inherited";
    process.env.AGENT_BROWSER_PROFILE = "/must-not-import-personal-profile";
    const test = await harness({ browserExecutablePath: "/opt/chrome" });
    try {
      await test.backend.check();
      const start = await test.start();
      expect(start.args.slice(0, 2)).toEqual(["mcp", "--tools"]);
      expect(start.args).toContain("core");
      expect(start.cwd).not.toBe(process.cwd());
      expect(start.cwd.startsWith(test.home)).toBe(true);
      expect(start.cwd.endsWith("/work")).toBe(true);
      const run = start.cwd.slice(0, -"/work".length);
      const env = start.env;
      expect(env.HOME).toBe(join(run, "home"));
      expect(env.USERPROFILE).toBe(env.HOME);
      expect(env.TMP).toBe(env.TMPDIR);
      expect(env.TEMP).toBe(env.TMPDIR);
      expect(env.APPDATA).toBe(join(run, "config"));
      expect(env.LOCALAPPDATA).toBe(join(run, "data"));
      expect(env.AGENT_BROWSER_PROFILE).toBeUndefined();
      // An explicit persistent profile is incompatible with allowed-domains.
      // Protect the ephemeral profile through TMPDIR's reserved sensitive name.
      expect(env.TMPDIR).toContain("credentials");
      // TMPDIR holds Chrome's ephemeral profile/SingletonSocket. It stays under home
      // when the path fits the Unix socket limit; otherwise a short private
      // temp directory is used instead (never a shared unmeasured tmpdir).
      const tempDir = env.TMPDIR ?? "";
      if (tempDir !== join(run, "credentials-tmp")) {
        expect(tempDir).toContain("forge-ab-credentials-tmp-");
        expect(tempDir.startsWith(test.home)).toBe(false);
      }
      expect(env.AGENT_BROWSER_CONFIG).toBe(join(run, "agent-browser.json"));
      expect(env.AGENT_BROWSER_ALLOWED_DOMAINS).toBe("127.0.0.1,localhost");
      expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/opt/chrome");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.FORGE_BACKEND_TEST_SECRET).toBeUndefined();
      expect(env.HOME).not.toBe(process.env.HOME);
      // Both kinds of relocated directory retain sensitive-path protection;
      // the ordinary run state still lives beneath the caller's protected home.
      const socket = env.AGENT_BROWSER_SOCKET_DIR;
      expect(socket).toBeDefined();
      if (!socket?.startsWith(run))
        expect(socket).toContain("forge-ab-credentials-sock-");
      expect(await test.calls()).toEqual([]);
      // check() is a protocol/tool discovery probe only.
      expect(await test.cleanup()).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.FORGE_BACKEND_TEST_SECRET;
      else process.env.FORGE_BACKEND_TEST_SECRET = previous;
      if (previousProfile === undefined)
        delete process.env.AGENT_BROWSER_PROFILE;
      else process.env.AGENT_BROWSER_PROFILE = previousProfile;
    }
  });

  it("fails check when the native core profile is missing a required tool", async () => {
    const test = await harness({ mode: "missing-tool" });
    await expect(test.backend.check()).rejects.toThrow(
      /missing required core tools/,
    );
    // Construction/check errors release the private run directory under home.
    const runs = await readdir(join(test.home, "browser-plugin")).catch(
      () => [],
    );
    expect(runs).toEqual([]);
  });

  it("maps every shared action onto the native tool with a stable private session", async () => {
    const test = await harness();
    const [open, snapshot, read, click, fill, press, scroll] = [
      { action: "navigate", url: "http://127.0.0.1:8080/page" },
      { action: "snapshot" },
      { action: "read" },
      { action: "click", selector: "#go" },
      { action: "fill", selector: "#name", text: "Forge" },
      { action: "press", key: "Enter" },
      { action: "scroll", direction: "down", pixels: 420 },
    ] as const;
    expect((await test.backend.execute(open)).text).toBe(
      "http://127.0.0.1/fixture",
    );
    expect((await test.backend.execute(snapshot)).text).toContain(
      'button "Go"',
    );
    expect((await test.backend.execute(read)).text).toBe(
      "# Fixture\n\ncontent",
    );
    expect((await test.backend.execute(click)).text).toBe("Clicked #go.");
    expect((await test.backend.execute(fill)).text).toBe("Filled #name.");
    expect((await test.backend.execute(press)).text).toBe("Pressed Enter.");
    expect((await test.backend.execute(scroll)).text).toBe("Scrolled.");

    const calls = await test.calls();
    expect(calls.map((call) => call.name)).toEqual([
      "agent_browser_open",
      "agent_browser_snapshot",
      "agent_browser_read",
      "agent_browser_click",
      "agent_browser_fill",
      "agent_browser_press",
      "agent_browser_scroll",
    ]);
    const session = calls[0]?.args.session;
    expect(typeof session).toBe("string");
    expect(session).toMatch(/^f[0-9a-f]{16}$/);
    for (const call of calls) expect(call.args.session).toBe(session);
    expect(calls[0]?.args).toMatchObject({
      url: "http://127.0.0.1:8080/page",
      headed: false,
      webmcp: false,
    });
    expect(calls[1]?.args).toMatchObject({ interactive: true });
    expect(calls[3]?.args).toMatchObject({ selector: "#go" });
    expect(calls[4]?.args).toMatchObject({ selector: "#name", text: "Forge" });
    expect(calls[5]?.args).toMatchObject({ key: "Enter" });
    expect(calls[6]?.args).toMatchObject({ direction: "down", amount: 420 });
    const namespace = calls[0]?.args.namespace;
    expect(typeof namespace).toBe("string");
    for (const call of calls) expect(call.args.namespace).toBe(namespace);
    // No arbitrary extraArgs / eval / upload / session escape hatch is sent.
    for (const call of calls) {
      expect(call.args).not.toHaveProperty("extraArgs");
      expect(call.args).not.toHaveProperty("eval");
      expect(call.args).not.toHaveProperty("file");
      expect(call.args).not.toHaveProperty("all");
    }
  });

  it("rejects empty or non-matching allowlists before starting the MCP server", async () => {
    const empty = await harness({ domains: [] });
    await expect(empty.backend.execute({ action: "snapshot" })).rejects.toThrow(
      /at least one allowed domain/,
    );
    expect(await empty.read("start.json")).toBeUndefined();

    const test = await harness({ domains: ["example.com", "*.allowed.test"] });
    await expect(
      test.backend.execute({ action: "navigate", url: "https://evil.test/" }),
    ).rejects.toThrow(/configured allowed hostname/);
    await expect(
      test.backend.execute({ action: "navigate", url: "file:///etc/passwd" }),
    ).rejects.toThrow(/HTTP\(S\) URL/);
    await expect(
      test.backend.execute({
        action: "navigate",
        url: "https://user:pass@example.com/",
      }),
    ).rejects.toThrow(/credential-free/);
    await expect(
      test.backend.execute({
        action: "navigate",
        url: "https://allowed.test/",
      }),
    ).resolves.toMatchObject({ isError: false });
    const calls = await test.calls();
    expect(calls.map((call) => call.name)).toEqual(["agent_browser_open"]);
  });

  it("returns bounded PNG image data and only reads its own private screenshot file", async () => {
    const test = await harness();
    const result = await test.backend.execute({ action: "screenshot" });
    expect(result.isError).toBe(false);
    expect(result.image?.mimeType).toBe("image/png");
    const bytes = Buffer.from(result.image?.data ?? "", "base64");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect((result.image?.data.length ?? 0) <= 700_000).toBe(true);
    const call = (await test.calls()).find(
      (entry) => entry.name === "agent_browser_screenshot",
    );
    const path = String(call?.args.path);
    expect(path.startsWith(test.home)).toBe(true);
    expect(path).toContain("/screens/shot-");
    expect(path.endsWith(".png")).toBe(true);
    // The captured file is private scratch data and is removed afterwards.
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("refuses oversized or non-image screenshot bytes instead of truncating success", async () => {
    const oversize = await harness({ mode: "oversize" });
    const big = await oversize.backend.execute({ action: "screenshot" });
    expect(big.isError).toBe(true);
    expect(big.image).toBeUndefined();
    expect(big.text).toMatch(/700,000-character image limit/);

    const bad = await harness({ mode: "bad-image" });
    const invalid = await bad.backend.execute({ action: "screenshot" });
    expect(invalid.isError).toBe(true);
    expect(invalid.image).toBeUndefined();
    expect(invalid.text).toMatch(/not a supported PNG\/JPEG/);
  });

  it("never follows a screenshot symlink outside its private directory", async () => {
    const test = await harness({ mode: "symlink" });
    const result = await test.backend.execute({ action: "screenshot" });
    expect(result.isError).toBe(true);
    expect(result.image).toBeUndefined();
    expect(result.text).not.toContain("external file");
  });

  it("redacts configured private values from browser output", async () => {
    const test = await harness({
      mode: "leak",
      redactValues: ["fixture-secret"],
    });
    const result = await test.backend.execute({ action: "read" });
    expect(result.text).toBe("[REDACTED]");
  });

  it("reports an upstream tool error without inventing success or replaying", async () => {
    const test = await harness({ mode: "error" });
    const result = await test.backend.execute({
      action: "click",
      selector: "#go",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Blocked by fixture.");
    const calls = await test.calls();
    expect(
      calls.filter((call) => call.name === "agent_browser_click"),
    ).toHaveLength(1);
  });

  it("treats close as cleanup of this session only and never uses --all", async () => {
    const test = await harness();
    await test.backend.execute({
      action: "navigate",
      url: "http://127.0.0.1/",
    });
    await expect(
      test.backend.execute({ action: "close" }),
    ).resolves.toMatchObject({
      isError: false,
    });
    await test.backend.dispose();
    const calls = await test.calls();
    expect(calls.at(-1)?.name).toBe("agent_browser_close");
    expect(calls.at(-1)?.args).not.toHaveProperty("all");
    // A confirmed in-band close already shut the session down; dispose does
    // not spawn a second close.
    expect(await test.cleanup()).toBeUndefined();
  });

  it("refuses further actions after a confirmed close", async () => {
    const test = await harness();
    await test.backend.execute({
      action: "navigate",
      url: "http://127.0.0.1/",
    });
    await test.backend.execute({ action: "close" });
    await expect(test.backend.execute({ action: "snapshot" })).rejects.toThrow(
      /This browser is closed/,
    );
  });

  it("confirms cleanup through a fresh CLI close, without --all", async () => {
    // "stale-daemon" leaves the session artifact behind after the in-band
    // MCP close, so the backend must confirm via its own CLI process.
    const test = await harness({ mode: "stale-daemon" });
    await test.backend.execute({
      action: "navigate",
      url: "http://127.0.0.1/",
    });
    await test.backend.dispose();
    const cleanup = await test.cleanup();
    expect(cleanup).toBeDefined();
    expect(cleanup?.args).toContain("--session");
    expect(cleanup?.args).toContain("--namespace");
    expect(cleanup?.args).toContain("close");
    expect(cleanup?.args).toContain("--json");
    expect(cleanup?.args).not.toContain("--all");
    expect(cleanup?.env.HOME).not.toBe(process.env.HOME);
    // Confirmed cleanup removes both the private home run and the socket dir.
    const runs = await readdir(join(test.home, "browser-plugin")).catch(
      () => [],
    );
    expect(runs).toEqual([]);
  });

  it("cancels an in-flight command, closes the owned browser and rejects without replay", async () => {
    const test = await harness({ mode: "cancel" });
    const controller = new AbortController();
    const pending = test.backend.execute(
      { action: "click", selector: "#slow" },
      controller.signal,
    );
    // Wait until the fixture has received the click, then cancel it.
    for (let index = 0; index < 200; index += 1) {
      if ((await test.calls()).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    const cleanup = await test.cleanup();
    expect(cleanup).toBeDefined();
    expect(cleanup?.args).not.toContain("--all");
    const calls = await test.calls();
    expect(
      calls.filter((call) => call.name === "agent_browser_click"),
    ).toHaveLength(1);
    // Backend refuses new work after an uncertain failure.
    await expect(
      test.backend.execute({ action: "snapshot" }),
    ).rejects.toMatchObject({
      code: "tool",
    });
  });

  it("returns a clear failure when an explicit CLI path cannot be started", async () => {
    const test = await harness();
    const missing = browserPluginConfigSchema.parse({
      executablePath: join(test.root, "does-not-exist"),
      allowedDomains: ["example.com"],
    });
    const backend = await createAgentBrowserBackend(missing, {
      home: test.home,
    });
    await expect(backend.check()).rejects.toThrow();
    await backend.dispose().catch(() => undefined);
  });

  it("never falls back to an unvetted PATH agent-browser for the default executable", async () => {
    const test = await harness();
    let resolvable = true;
    try {
      createRequire(import.meta.url).resolve(
        "agent-browser/bin/agent-browser.js",
      );
    } catch {
      resolvable = false;
    }
    const def = browserPluginConfigSchema.parse({
      allowedDomains: ["example.com"],
    });
    // Only assert the failure mode when the pinned optional dependency is
    // genuinely absent; otherwise the default must resolve the local package.
    if (!resolvable) {
      await expect(
        createAgentBrowserBackend(def, { home: test.home }),
      ).rejects.toThrow(/pinned optional dependency/);
    }
  });

  it("retains private state and reports failure when cleanup cannot be confirmed", async () => {
    // Cleanup must actually run and fail: keep the daemon artifact so the CLI
    // confirmation path executes, and make that CLI exit nonzero.
    const test = await harness({ mode: "stale-daemon", cleanupExit: 1 });
    await test.backend.execute({
      action: "navigate",
      url: "http://127.0.0.1/",
    });
    const start = await test.start();
    await expect(test.backend.dispose()).rejects.toThrow(/cleanup failed/);
    // The daemon could not be confirmed dead, so its state directory is kept.
    const runs = await readdir(join(test.home, "browser-plugin")).catch(
      () => [],
    );
    expect(runs).toHaveLength(1);
    // Test-owned cleanup of the short temp socket dir this fixture forced.
    const socket = start.env.AGENT_BROWSER_SOCKET_DIR ?? "";
    if (
      !socket.startsWith(test.home) &&
      socket.includes("forge-ab-credentials-sock-")
    )
      await rm(socket, { recursive: true, force: true }).catch(() => undefined);
  });

  it("disposes idempotently and keeps a private HOME for each backend", async () => {
    const first = await harness();
    const second = await harness();
    await first.backend.check();
    await second.backend.check();
    const firstStart = await first.start();
    const secondStart = await second.start();
    expect(firstStart.env.HOME).not.toBe(secondStart.env.HOME);
    expect(firstStart.env.AGENT_BROWSER_SOCKET_DIR).not.toBe(
      secondStart.env.AGENT_BROWSER_SOCKET_DIR,
    );
    await Promise.all([first.backend.dispose(), first.backend.dispose()]);
  });
});
