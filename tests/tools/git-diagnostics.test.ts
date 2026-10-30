import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import {
  DEFAULT_GIT_STATUS_TIMEOUT_MS,
  DEFAULT_GIT_TIMEOUT_MS,
  type GitInspectionOutcome,
  gitFailure,
  gitInspect,
  gitNotApplicableNote,
} from "../../src/tools/git";
import { createLocalToolRegistry } from "../../src/tools/local";
import { testScratch } from "../fixtures/scratch";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const probeEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
/** Git's own view of a directory, so fixtures do not race the surrounding checkout. */
function isRepository(path: string): boolean {
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    env: probeEnv,
    encoding: "utf8",
  });
  return probe.status === 0;
}
/**
 * A directory that Git resolves to no work tree. `tmpdir()` can itself sit inside a
 * checkout (as it does under the Forge harness), so candidates are probed instead of
 * assumed; the classifier's other categories stay covered by direct unit tests.
 */
async function nonRepositoryRoot(): Promise<string | undefined> {
  // Read-only repository detection in an existing OS temp directory; never create
  // or remove fixtures outside the test scratch root (tests/fixtures/scratch.ts).
  for (const base of [tmpdir(), "/tmp", "/var/tmp"]) {
    if (
      (await lstat(base).catch(() => undefined))?.isDirectory() &&
      !isRepository(base)
    )
      return base;
  }
  return undefined;
}
async function newDirectory(name: string): Promise<string> {
  const base = testScratch("cross-provider-fixes", "tools");
  await mkdir(base, { recursive: true });
  const parent = await mkdtemp(join(base, "git-diagnostics-"));
  roots.push(parent);
  const root = join(parent, name);
  await mkdir(root);
  return root;
}
async function repo() {
  const root = await newDirectory("repo");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: { ...probeEnv, HOME: root },
      stdio: "pipe",
    });
  git("init", "-q");
  return { root, git };
}
function context(
  root: string,
  signal = new AbortController().signal,
): ToolContext {
  return {
    sessionId: parseSessionId(randomUUID()),
    toolCallId: "diagnostics",
    workspace: root,
    permission: "readonly",
    signal,
    onEvent: () => {},
    approve: async () => {
      throw Error("git inspection must not ask approval");
    },
  };
}
async function call(root: string, name: string, signal?: AbortSignal) {
  const registry = await createLocalToolRegistry(root);
  try {
    return await registry.execute(
      {
        id: "diagnostics",
        type: "function",
        function: { name, arguments: "{}" },
      },
      context(root, signal),
    );
  } finally {
    await registry.dispose();
  }
}

it.each(["git_status", "git_diff", "git_log"] as const)(
  "reports %s as not applicable outside a Git work tree instead of a generic failure",
  async (name) => {
    const root = await nonRepositoryRoot();
    if (root === undefined)
      throw new Error(
        "No non-repository fixture root available; every candidate temp base sits inside a checkout.",
      );
    const result = await call(root, name);
    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content) as Record<string, unknown>;
    // Legacy shape stays intact for callers that only read output/truncated/omitted.
    expect(data).toMatchObject({
      source: "git",
      output: "",
      truncated: false,
      omitted: 0,
      repository: false,
    });
    const note = String(data.note);
    expect(note).toContain("not inside a Git work tree");
    // Classification is authored text: no paths, no raw git diagnostics.
    expect(note).not.toContain(root);
    expect(note.toLowerCase()).not.toContain("not a git repository");
    expect(result.content).not.toContain(root);
    expect(result.content).not.toContain("unavailable or timed out");
  },
);

it("treats a workspace root with an unusable .git entry as not applicable without leaking it", async () => {
  const root = await newDirectory("broken-gitfile");
  await writeFile(join(root, ".git"), "this is not a gitdir\n");
  const rejected = await gitInspect(root, "status").then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejected).toBeNull();
  const inspection = await gitInspect(root, "status");
  expect(inspection).toMatchObject({
    output: "",
    truncated: false,
    omitted: 0,
    repository: false,
  });
  expect(inspection.note).toContain("unusable .git entry");
  expect(inspection.note).not.toContain(root);
  expect(String(inspection.note)).not.toContain("invalid gitfile format");
  const result = await call(root, "git_status");
  expect(result.isError).toBe(false);
  expect(result.content).not.toContain(root);
});

it("keeps a nested subdirectory a clear error that names the missing root", async () => {
  const { root } = await repo();
  const nested = join(root, "nested");
  await mkdir(nested);
  for (const name of ["git_status", "git_diff", "git_log"] as const) {
    const result = await call(nested, name);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content) as { error: string };
    expect(data.error).toContain("not its root");
    expect(data.error).not.toContain("unavailable or timed out");
    expect(data.error).not.toContain(nested);
    expect(result.content).not.toContain(nested);
  }
});

it("returns an empty log for a repository whose branch has no commits yet", async () => {
  const { root } = await repo();
  const inspection = await gitInspect(root, "log");
  expect(inspection).toMatchObject({
    output: "",
    truncated: false,
    omitted: 0,
    repository: true,
  });
  expect(inspection.note).toContain("no commits yet");
  const result = await call(root, "git_log");
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content)).toMatchObject({
    source: "git",
    output: "",
    repository: true,
  });
});

it("still reports a real repository with the legacy fields and repository:true", async () => {
  const { root, git } = await repo();
  await writeFile(join(root, "tracked.txt"), "one\n");
  git("add", "--", "tracked.txt");
  git(
    "-c",
    "user.name=Tester",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "diagnostics fixture",
  );
  await writeFile(join(root, "tracked.txt"), "two\n");
  const status = await call(root, "git_status");
  expect(status.isError).toBe(false);
  expect(JSON.parse(status.content)).toMatchObject({
    source: "git",
    truncated: false,
    omitted: 0,
    repository: true,
  });
  expect(status.content).toContain("tracked.txt");
  expect(JSON.parse(status.content)).not.toHaveProperty("note");
  const log = await call(root, "git_log");
  expect(log.isError).toBe(false);
  expect(log.content).toContain("diagnostics fixture");
});

// Deliberately not shaped like a real credential: this asserts redaction of raw git text.
const privateDiagnostic =
  "fatal: cannot open /home/private-user/private-store/entry-token canary-9f3a2b";

it.each([
  "fatal: not a git repository (or any parent up to mount point /)\n",
  "fatal: invalid gitfile format: /tmp/x/.git\n",
  "fatal: gitfile does not point to a valid repository: /tmp/x/.git\n",
  "fatal: this operation must be run in a work tree\n",
] as const)(
  "classifies %j as not applicable without echoing it",
  (diagnostic) => {
    const note = gitNotApplicableNote({ kind: "exit", code: 128, diagnostic });
    expect(note).toBeDefined();
    expect(note).not.toContain("/tmp/x");
    expect(note).not.toContain("fatal:");
    expect(note).not.toContain("gitfile");
  },
);

it.each([
  "fatal: authentication failed for 'https://user@example.invalid/repo'",
  "error: object file .git/objects/ab/cdef is empty",
  "fatal: detected dubious ownership in repository at '/tmp/x'",
  "",
] as const)("does not treat %j as a not-applicable workspace", (diagnostic) => {
  expect(
    gitNotApplicableNote({ kind: "exit", code: 128, diagnostic }),
  ).toBeUndefined();
});

it.each([
  [
    "cancelled",
    { kind: "cancelled" },
    "cancelled",
    "Git inspection cancelled.",
  ],
  ["timeout", { kind: "timeout" }, "tool", "timed out after 10 seconds"],
  ["output_limit", { kind: "output_limit" }, "tool", "64 KiB ceiling"],
  ["unavailable", { kind: "unavailable" }, "tool", "could not start"],
] as const)(
  "classifies a %s outcome distinctly and without diagnostics",
  (_label, outcome, code, expected) => {
    const error = gitFailure(outcome as GitInspectionOutcome);
    expect(error.code).toBe(code);
    expect(error.message).toContain(expected);
    expect(error.message).not.toContain("unavailable or timed out");
  },
);

it("reports non-zero exits by safe exit code only", () => {
  const error = gitFailure({
    kind: "exit",
    code: 128,
    diagnostic: privateDiagnostic,
  });
  expect(error.code).toBe("tool");
  expect(error.message).toContain("exit code 128");
  expect(error.message).toContain("withheld");
  expect(error.message).not.toContain("canary-9f3a2b");
  expect(error.message).not.toContain("/home/private-user");
  const killed = gitFailure({
    kind: "exit",
    code: null,
    diagnostic: privateDiagnostic,
  });
  expect(killed.message).toContain("terminated by a signal");
  expect(killed.message).not.toContain("canary-9f3a2b");
});

it("does not create repository metadata when reporting a non-repository workspace", async () => {
  const root = await nonRepositoryRoot();
  if (root === undefined)
    throw new Error(
      "No non-repository fixture root available for the side-effect check.",
    );
  await expect(lstat(join(root, ".git"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect((await call(root, "git_status")).isError).toBe(false);
  // This probe is entirely read-only, including its assertions.
  await expect(lstat(join(root, ".git"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("reports the deadline that actually applied to a timed-out inspection", () => {
  expect(gitFailure({ kind: "timeout", timeoutMs: 30000 }).message).toContain(
    "timed out after 30 seconds",
  );
  expect(DEFAULT_GIT_TIMEOUT_MS).toBe(10000);
  expect(DEFAULT_GIT_STATUS_TIMEOUT_MS).toBe(30000);
});

it("applies a configured git inspection deadline", async () => {
  const { root } = await repo();
  // 1 ms cannot fit a git process spawn, so the configured deadline must fire.
  await expect(
    gitInspect(root, "status", undefined, [], [], { timeoutMs: 1 }),
  ).rejects.toMatchObject({ code: "tool", message: /timed out after/ });
  // The default deadlines are generous enough for a small repository.
  await expect(gitInspect(root, "status")).resolves.toMatchObject({
    repository: true,
  });
});
