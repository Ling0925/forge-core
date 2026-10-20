import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type AgentWorktreeService,
  createAgentWorktreeService,
} from "../../src/core/agent-worktrees";
import { ForgeError } from "../../src/shared/errors";

// Every directory below is created by this test file; cleanup removes only
// these recorded roots and never a pre-existing user directory.
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function gitEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `forge-${label}-`));
  roots.push(root);
  return root;
}

function insideGitWorktree(path: string, home: string): boolean {
  try {
    execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      env: gitEnvironment(home),
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A temporary directory that is not itself inside any Git worktree. The test
 * host may set TMPDIR to a repository root, so plain `mkdtemp` is not enough.
 */
async function nonRepositoryRoot(): Promise<string> {
  const gitHome = await tempRoot("worktree-git-home");
  for (const base of [tmpdir(), "/tmp", "/var/tmp"]) {
    let candidate: string;
    try {
      candidate = await mkdtemp(join(base, "forge-worktree-plain-"));
    } catch {
      continue;
    }
    roots.push(candidate);
    if (!insideGitWorktree(candidate, gitHome)) return candidate;
  }
  throw new Error("no temporary directory outside a Git worktree is available");
}

async function repository() {
  const root = await tempRoot("worktree-repo");
  const home = await tempRoot("worktree-git-home");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: gitEnvironment(home),
      stdio: "pipe",
    }).toString();
  // Identity is repository-local; the suite never depends on user Git config.
  git("init", "-q");
  git("config", "user.name", "Forge Tester");
  git("config", "user.email", "forge@example.invalid");
  await writeFile(join(root, "tracked.txt"), "committed\n");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "nested.txt"), "nested\n");
  git("add", "--", "tracked.txt", "sub/nested.txt");
  git("commit", "-qm", "initial");
  return { root, home, git };
}

function service(home: string): AgentWorktreeService {
  return createAgentWorktreeService(join(home, "forge-home"));
}

async function failure(promise: Promise<unknown>): Promise<ForgeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeError);
    return error as ForgeError;
  }
  throw new Error("expected the worktree service to reject");
}

it("creates a detached worktree at the committed HEAD and leaves dirty parent files untouched", async () => {
  const { root, home, git } = await repository();
  // A repository hook must never run during worktree creation.
  const hookMarker = join(root, "hook-ran.txt");
  const hooks = join(root, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(
    join(hooks, "post-checkout"),
    `#!/bin/sh\necho ran > ${JSON.stringify(hookMarker)}\n`,
    { mode: 0o755 },
  );
  // Dirty tracked content plus an untracked file: neither is copied nor changed.
  await writeFile(join(root, "tracked.txt"), "dirty parent\n");
  await writeFile(join(root, "untracked.txt"), "parent only\n");
  const head = git("rev-parse", "HEAD").trim();
  const sessionId = randomUUID();

  const result = await service(home).create({
    workspace: root,
    sessionId,
    signal: new AbortController().signal,
  });

  expect(result.baseRevision).toBe(head);
  expect(result.worktree).toBe(
    join(home, "forge-home-worktrees", sessionId),
  );
  expect(result.workspace).toBe(result.worktree);
  expect(git("-C", result.worktree, "rev-parse", "HEAD").trim()).toBe(head);
  // Detached, not a branch checkout.
  let symbolic = "";
  try {
    symbolic = git("-C", result.worktree, "symbolic-ref", "-q", "HEAD").trim();
  } catch {
    // symbolic-ref exits nonzero for a detached HEAD, which is expected.
  }
  expect(symbolic).toBe("");
  expect(await readFile(join(result.worktree, "tracked.txt"), "utf8")).toBe(
    "committed\n",
  );
  await expect(
    stat(join(result.worktree, "untracked.txt")),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  // Parent is exactly as dirty as before.
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe(
    "dirty parent\n",
  );
  expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe(
    "parent only\n",
  );
  await expect(stat(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns the same relative subdirectory for a workspace nested in the repository", async () => {
  const { root, home } = await repository();
  const nested = join(root, "sub");

  const result = await service(home).create({
    workspace: nested,
    sessionId: randomUUID(),
    signal: new AbortController().signal,
  });

  expect(result.repository).toBe(root);
  expect(result.workspace).toBe(join(result.worktree, "sub"));
  expect(await readFile(join(result.workspace, "nested.txt"), "utf8")).toBe(
    "nested\n",
  );
});

it("keeps parallel worktrees independent", async () => {
  const { root, home, git } = await repository();
  const base = git("rev-parse", "HEAD").trim();
  const firstId = randomUUID();
  const secondId = randomUUID();
  const worktrees = service(home);

  const [first, second] = await Promise.all([
    worktrees.create({
      workspace: root,
      sessionId: firstId,
      signal: new AbortController().signal,
    }),
    worktrees.create({
      workspace: root,
      sessionId: secondId,
      signal: new AbortController().signal,
    }),
  ]);

  expect(first.worktree).not.toBe(second.worktree);
  expect(first.baseRevision).toBe(base);
  expect(second.baseRevision).toBe(base);
  await writeFile(join(first.workspace, "only-first.txt"), "first\n");
  await writeFile(join(second.workspace, "only-second.txt"), "second\n");
  await expect(
    stat(join(second.worktree, "only-first.txt")),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    stat(join(first.worktree, "only-second.txt")),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(stat(join(root, "only-first.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  // Writing inside one worktree never changes the other's tracked content.
  expect(await readFile(join(second.workspace, "tracked.txt"), "utf8")).toBe(
    "committed\n",
  );
});

it("rejects an invalid session id without creating a destination", async () => {
  const { root, home } = await repository();
  const error = await failure(
    service(home).create({
      workspace: root,
      sessionId: "../escape",
      signal: new AbortController().signal,
    }),
  );
  expect(error.code).toBe("invalid_input");
  await expect(
    stat(join(home, "forge-home-worktrees", "../escape")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a non-Git workspace", async () => {
  const plain = await nonRepositoryRoot();
  const home = await tempRoot("worktree-home");
  await writeFile(join(plain, "file.txt"), "plain\n");

  const error = await failure(
    createAgentWorktreeService(home).create({
      workspace: plain,
      sessionId: randomUUID(),
      signal: new AbortController().signal,
    }),
  );
  expect(error.code).toBe("invalid_input");
  expect(error.message).toContain("not inside a Git worktree");
});

it("rejects a bare repository", async () => {
  const bare = await tempRoot("worktree-bare");
  const home = await tempRoot("worktree-home");
  const gitHome = await tempRoot("worktree-git-home");
  execFileSync("git", ["init", "--bare", "-q"], {
    cwd: bare,
    env: gitEnvironment(gitHome),
    stdio: "pipe",
  });

  const error = await failure(
    createAgentWorktreeService(home).create({
      workspace: bare,
      sessionId: randomUUID(),
      signal: new AbortController().signal,
    }),
  );
  expect(error.code).toBe("invalid_input");
  expect(error.message).toContain("Bare Git repositories");
});

it("rejects a repository with no committed HEAD", async () => {
  const root = await tempRoot("worktree-empty-repo");
  const home = await tempRoot("worktree-home");
  execFileSync("git", ["init", "-q"], {
    cwd: root,
    env: gitEnvironment(home),
    stdio: "pipe",
  });

  const error = await failure(
    createAgentWorktreeService(home).create({
      workspace: root,
      sessionId: randomUUID(),
      signal: new AbortController().signal,
    }),
  );
  expect(error.code).toBe("invalid_input");
  expect(error.message).toContain("no committed HEAD");
});

it("rejects an existing destination and reports it", async () => {
  const { root, home } = await repository();
  const sessionId = randomUUID();
  const destination = join(home, "forge-home-worktrees", sessionId);
  await mkdir(destination, { recursive: true });

  const error = await failure(
    service(home).create({
      workspace: root,
      sessionId,
      signal: new AbortController().signal,
    }),
  );
  expect(error.code).toBe("busy");
  expect(error.message).toContain(destination);
  // The pre-existing destination is retained, not removed.
  expect((await stat(destination)).isDirectory()).toBe(true);
});

it("cancels before creating a destination and retains nothing it did not create", async () => {
  const { root, home } = await repository();
  const sessionId = randomUUID();
  const controller = new AbortController();
  controller.abort();

  const error = await failure(
    service(home).create({
      workspace: root,
      sessionId,
      signal: controller.signal,
    }),
  );
  expect(error.code).toBe("cancelled");
  await expect(
    stat(join(home, "forge-home-worktrees", sessionId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("cancels an in-flight Git command and inherits no destination", async () => {
  const { root, home } = await repository();
  const sessionId = randomUUID();
  // A structural signal that aborts as soon as the service subscribes. This
  // deterministically exercises cancellation after the child Git process was
  // spawned, instead of relying on scheduler timing.
  const listeners: (() => void)[] = [];
  let aborted = false;
  const signal = {
    get aborted() {
      return aborted;
    },
    reason: undefined,
    throwIfAborted: () => {
      if (aborted) throw new Error("aborted");
    },
    addEventListener: (_type: string, listener: () => void) => {
      listeners.push(listener);
      setTimeout(() => {
        aborted = true;
        listener();
      }, 0);
    },
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as AbortSignal;

  const error = await failure(
    service(home).create({ workspace: root, sessionId, signal }),
  );
  expect(error.code).toBe("cancelled");
  // The first Git command was cancelled before any worktree destination was
  // created, so the service removed nothing and left no partial tree behind.
  await expect(
    stat(join(home, "forge-home-worktrees", sessionId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains a created worktree after success for manual recovery", async () => {
  const { root, home } = await repository();
  const controller = new AbortController();
  const result = await service(home).create({
    workspace: root,
    sessionId: randomUUID(),
    signal: controller.signal,
  });
  controller.abort();
  // Cancellation after creation must never auto-remove the worktree.
  expect((await stat(result.worktree)).isDirectory()).toBe(true);
  await writeFile(join(result.workspace, "dirty-in-child.txt"), "keep me\n");
  expect(
    await readFile(join(result.workspace, "dirty-in-child.txt"), "utf8"),
  ).toBe("keep me\n");
});

it("rejects a workspace that is not a directory", async () => {
  const { root, home } = await repository();
  const file = join(root, "tracked.txt");

  const error = await failure(
    service(home).create({
      workspace: file,
      sessionId: randomUUID(),
      signal: new AbortController().signal,
    }),
  );
  expect(error.code).toBe("invalid_input");
});
