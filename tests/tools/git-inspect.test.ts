import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { gitInspect } from "../../src/tools/git";
import { createLocalToolRegistry } from "../../src/tools/local";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "forge-git-safe-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: "pipe",
    });
  git("init", "-q");
  await writeFile(join(root, "safe.txt"), "old\n");
  await writeFile(join(root, ".env"), "private-before\n");
  git("add", "--", "safe.txt", ".env");
  git(
    "-c",
    "user.name=Tester",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  return { root, git };
}
function call(
  root: string,
  name: string,
  redactValues: string[] = [],
  signal = new AbortController().signal,
) {
  return createLocalToolRegistry(root, { redactValues }).then(
    async (registry) => {
      try {
        const context: ToolContext = {
          sessionId: parseSessionId(randomUUID()),
          toolCallId: "c",
          workspace: root,
          permission: "readonly",
          signal,
          approve: async () => {
            throw Error("git should not ask approval");
          },
          onEvent: () => {},
        };
        return await registry.execute(
          { id: "c", type: "function", function: { name, arguments: "{}" } },
          context,
        );
      } finally {
        await registry.dispose();
      }
    },
  );
}
it("registers read-only git status/diff/log and omits forbidden tracked files and secrets", async () => {
  const { root } = await repo();
  await writeFile(join(root, "safe.txt"), "new TOKEN_CANARY_123\n");
  await writeFile(join(root, ".env"), "private-after\n");
  const status = await call(root, "git_status");
  expect(status.isError).toBe(false);
  expect(JSON.parse(status.content)).toMatchObject({
    source: "git",
    omitted: 1,
  });
  expect(status.content).toContain("safe.txt");
  expect(status.content).not.toContain(".env");
  const diff = await call(root, "git_diff", ["TOKEN_CANARY_123"]);
  expect(diff.isError).toBe(false);
  expect(diff.content).toContain("[REDACTED]");
  expect(diff.content).not.toContain("TOKEN_CANARY_123");
  expect(diff.content).not.toContain("private-before");
  expect(diff.content).not.toContain("private-after");
  expect(JSON.parse(diff.content)).toMatchObject({ source: "git", omitted: 1 });
  const log = await call(root, "git_log");
  expect(log.isError).toBe(false);
  expect(log.content).toContain("initial");
});
it("treats Git pathspec-magic filenames literally without exposing forbidden tracked blobs", async () => {
  const { root, git } = await repo();
  const magic = ":(glob)*";
  const dashed = "-leading.txt";
  const multiline = "line\nbreak.txt";
  await writeFile(join(root, magic), "magic-old\n");
  await writeFile(join(root, dashed), "dash-old\n");
  await writeFile(join(root, multiline), "multiline-old\n");
  git("--literal-pathspecs", "add", "--", magic, dashed, multiline);
  git(
    "-c",
    "user.name=Tester",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "literal filenames",
  );
  await writeFile(join(root, magic), "magic-new\n");
  await writeFile(join(root, dashed), "dash-new\n");
  await writeFile(join(root, multiline), "multiline-new\n");
  await writeFile(join(root, ".env"), "private-after\n");
  const inspection = await gitInspect(root, "diff");
  expect(inspection.omitted).toBe(1);
  expect(inspection.output).toContain("magic-new");
  expect(inspection.output).toContain("dash-new");
  expect(inspection.output).toContain("multiline-new");
  expect(inspection.output).not.toContain("private-before");
  expect(inspection.output).not.toContain("private-after");
  expect(inspection.output).not.toContain(".env");
  const native = await call(root, "git_diff");
  expect(native.isError).toBe(false);
  expect(JSON.parse(native.content)).toMatchObject({
    source: "git",
    omitted: 1,
  });
  expect(native.content).not.toContain("private-before");
  expect(native.content).not.toContain("private-after");
});
it("never executes configured fsmonitor or repository diff drivers", async () => {
  const { root, git } = await repo();
  const marker = join(root, "executed-marker");
  const hook = join(root, "hook.sh");
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  await chmod(hook, 0o755);
  git("config", "core.fsmonitor", hook);
  git("config", "diff.external", hook);
  await writeFile(join(root, "safe.txt"), "changed\n");
  expect((await call(root, "git_status")).isError).toBe(false);
  expect((await call(root, "git_diff")).isError).toBe(false);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses cancelled git observation and does not run a command through readonly", async () => {
  const { root } = await repo();
  const abort = new AbortController();
  abort.abort();
  await expect(gitInspect(root, "status", abort.signal)).rejects.toThrow();
  await expect(call(root, "git_status", [], abort.signal)).rejects.toThrow();
  const bad = await call(root, "run_command");
  expect(bad.isError).toBe(true);
});

it("omits deleted credential blobs and symlinked tracked paths rather than exposing old contents", async () => {
  const { root } = await repo();
  await rm(join(root, ".env"));
  await rm(join(root, "safe.txt"));
  await symlink(join(root, ".env"), join(root, "safe.txt"));
  const diff = await call(root, "git_diff");
  expect(diff.isError).toBe(false);
  const data = JSON.parse(diff.content) as { output: string; omitted: number };
  expect(data.omitted).toBe(2);
  expect(data.output).not.toContain("private-before");
  expect(data.output).not.toContain("old");
});

it("redacts configured values in commit subjects and rejects nested workspaces", async () => {
  const { root, git } = await repo();
  await writeFile(join(root, "safe.txt"), "second\n");
  git("add", "safe.txt");
  git(
    "-c",
    "user.name=Tester",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "change SECRET_SENTINEL",
  );
  const log = await call(root, "git_log", ["SECRET_SENTINEL"]);
  expect(log.content).toContain("[REDACTED]");
  expect(log.content).not.toContain("SECRET_SENTINEL");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "nested"));
  const nested = await call(join(root, "nested"), "git_status");
  expect(nested.isError).toBe(true);
});

it("omits managed state from status and diff, including deleted tracked state", async () => {
  const { root, git } = await repo();
  const state = join(root, "managed");
  await mkdir(state);
  await writeFile(join(state, "session.json"), "PRIVATE_STATE_BEFORE\n");
  git("add", "managed/session.json");
  git(
    "-c",
    "user.name=Tester",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture state",
  );
  await writeFile(join(state, "session.json"), "PRIVATE_STATE_AFTER\n");
  await writeFile(join(root, "safe.txt"), "public change\n");
  for (const action of ["status", "diff"] as const) {
    const result = await gitInspect(root, action, undefined, [], [state]);
    expect(result.output).toContain("safe.txt");
    expect(result.output).not.toContain("managed");
    expect(result.output).not.toContain("PRIVATE_STATE");
  }
  const registry = await createLocalToolRegistry(root, {
    protectedRoots: [state],
  });
  try {
    const result = await registry.execute(
      {
        id: "fixture",
        type: "function",
        function: { name: "git_diff", arguments: "{}" },
      },
      {
        sessionId: parseSessionId(randomUUID()),
        toolCallId: "fixture",
        workspace: root,
        permission: "readonly",
        signal: new AbortController().signal,
        onEvent: () => {},
        approve: async () => false,
      },
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain("PRIVATE_STATE");
    expect(result.content).not.toContain("managed");
  } finally {
    await registry.dispose();
  }
  await rm(join(state, "session.json"));
  expect(
    (await gitInspect(root, "diff", undefined, [], [state])).output,
  ).not.toContain("PRIVATE_STATE");
});

it("refuses git log when the workspace is at or under a protected state root", async () => {
  const { root, git } = await repo();
  const state = join(root, "managed");
  const under = join(state, "nested");
  await mkdir(under, { recursive: true });
  git("init", "-q", state);
  await writeFile(join(state, "benign.txt"), "public text\n");
  git("-C", state, "add", "--", "benign.txt");
  git(
    "-C",
    state,
    "-c",
    "user.name=Tester",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "BENIGN_SENTINEL_SUBJECT",
  );
  // Control marker: without the protected roots, the same inspection succeeds
  // and returns the deliberately committed subject, so removing the root guard
  // in gitInspect would make the checks below fail.
  expect((await gitInspect(state, "log", undefined, [], [])).output).toContain(
    "BENIGN_SENTINEL_SUBJECT",
  );
  for (const workspace of [state, under]) {
    const failure = await gitInspect(
      workspace,
      "log",
      undefined,
      [],
      [state],
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure).toMatchObject({ code: "PROTECTED_PATH" });
    expect(String(failure)).not.toContain("BENIGN_SENTINEL_SUBJECT");
  }
});
