import type {
  AgentWorktree,
  AgentWorktreeCreateInput,
  AgentWorktreeService,
} from "../shared/agent-worktrees";
export type {
  AgentWorktreeCreateInput,
  AgentWorktree,
  AgentWorktreeService,
} from "../shared/agent-worktrees";
import { type ChildProcess, spawn } from "node:child_process";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ForgeError } from "../shared/errors";
import { sessionIdSchema } from "../shared/schemas";

/**
 * Opt-in Git worktree isolation for child agents.
 *
 * The runtime applies its existing permissions. Worktrees live beside the
 * private state root, not inside it, so workspace tools need no exception to
 * credential-directory protection. Destinations are keyed by session UUID.
 *
 * Guarantees:
 * - The worktree is detached at the parent's current committed HEAD. Dirty and
 *   untracked parent files are not copied and are never touched.
 * - Git runs as an explicit argv child process without a shell. Repository
 *   hooks are disabled and the child environment contains no provider keys,
 *   tokens or proxy variables.
 * - Output and elapsed time are bounded. Cancellation terminates and joins the
 *   owned process group before the promise settles.
 * - Nothing is committed, merged, removed, reset or retried automatically. A
 *   created or partially created destination is retained for inspection.
 */

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_CAP = 64 * 1024;

interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
}

type KillReason = "cancelled" | "timeout" | "output" | "spawn";

function invalid(message: string): ForgeError {
  return new ForgeError("invalid_input", message);
}

function cancelled(destination?: string): ForgeError {
  if (!destination)
    return new ForgeError(
      "cancelled",
      "Agent worktree creation was cancelled.",
    );
  return new ForgeError(
    "cancelled",
    `Agent worktree creation was cancelled; any partial worktree at ${destination} was retained for inspection.`,
  );
}

/** Minimal environment: no provider credentials, tokens or proxy settings. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
  if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR;
  if (process.platform === "win32" && process.env.SYSTEMROOT)
    environment.SYSTEMROOT = process.env.SYSTEMROOT;
  return environment;
}

function terminate(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to a direct child signal.
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may already be gone; close settling decides the outcome.
  }
}

function forceKill(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to a direct child signal.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The child may already be gone.
  }
}

function gitFailure(reason: KillReason): ForgeError {
  if (reason === "cancelled")
    return new ForgeError(
      "cancelled",
      "Agent worktree Git command was cancelled.",
    );
  if (reason === "timeout")
    return new ForgeError("tool", "Agent worktree Git command timed out.");
  if (reason === "spawn")
    return new ForgeError("tool", "Git could not be started.");
  return new ForgeError(
    "tool",
    "Agent worktree Git output exceeded its bound.",
  );
}

/**
 * Run one Git command with explicit argv and no shell. The returned promise
 * settles only after the child (and, on POSIX, its process group) has closed.
 */
function runGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<GitResult> {
  return new Promise((promiseResolve, promiseReject) => {
    if (signal.aborted) {
      promiseReject(cancelled());
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(
        "git",
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.pager=cat",
          "-c",
          "advice.detachedHead=false",
          "-C",
          cwd,
          ...args,
        ],
        {
          env: gitEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
    } catch {
      promiseReject(new ForgeError("tool", "Git could not be started."));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let reason: KillReason | null = null;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) promiseReject(gitFailure(reason));
      else
        promiseResolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
    };
    const stop = (why: KillReason): void => {
      if (reason) return;
      reason = why;
      terminate(child);
      // Escalate only while we are still waiting for close. The timer keeps
      // the promise pending; cleanup clears it once the child has settled.
      forceTimer = setTimeout(() => forceKill(child), 1500);
      forceTimer.unref?.();
    };
    const onAbort = (): void => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), GIT_TIMEOUT_MS);
    timer.unref?.();

    signal.addEventListener("abort", onAbort, { once: true });
    // The signal may have aborted between the initial check and wiring the
    // listener; stop the just-spawned child instead of leaking it.
    if (signal.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > GIT_OUTPUT_CAP) {
        stop("output");
        return;
      }
      stdoutBytes += chunk.length;
      stdout.push(Buffer.from(chunk));
    });
    // Stderr is counted but discarded: Git diagnostics may include host paths
    // or repository-controlled text and are never surfaced.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > GIT_OUTPUT_CAP) stop("output");
    });
    child.once("error", () => {
      if (reason) return;
      reason = "spawn";
      // Spawn failures usually emit close afterwards; settling here also
      // covers a binary that disappears before close is observed.
      if (!child.pid) settle(null);
    });
    child.once("close", (code) => settle(code));
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ForgeError(
      "storage",
      "Agent worktree destination could not be inspected.",
    );
  }
}

export function createAgentWorktreeService(home: string): AgentWorktreeService {
  if (typeof home !== "string" || home.trim() === "" || home.includes("\0"))
    throw invalid("Agent worktree home is invalid.");
  const root = `${resolve(home)}-worktrees`;

  async function create(
    input: AgentWorktreeCreateInput,
  ): Promise<AgentWorktree> {
    const { workspace, sessionId, signal } = input;
    if (signal.aborted) throw cancelled();
    if (typeof workspace !== "string" || workspace.trim() === "")
      throw invalid(
        "Agent worktree isolation requires an existing workspace directory.",
      );
    if (!sessionIdSchema.safeParse(sessionId).success)
      throw invalid(
        "Agent session id is not a valid UUID; no worktree was created.",
      );

    let workspacePath: string;
    try {
      workspacePath = await realpath(resolve(workspace));
      if (!(await stat(workspacePath)).isDirectory())
        throw new Error("not a directory");
    } catch {
      throw invalid(
        "Agent worktree isolation requires an existing workspace directory.",
      );
    }
    if (signal.aborted) throw cancelled();

    let bare: GitResult;
    let top: GitResult;
    let head: GitResult;
    try {
      bare = await runGit(
        workspacePath,
        ["rev-parse", "--is-bare-repository"],
        signal,
      );
      if (bare.code !== 0)
        throw invalid(
          "Workspace is not inside a Git worktree; commit it to a repository before using worktree isolation.",
        );
      if (bare.stdout.trim() === "true")
        throw invalid(
          "Bare Git repositories cannot be used for agent worktree isolation.",
        );
      top = await runGit(
        workspacePath,
        ["rev-parse", "--show-toplevel"],
        signal,
      );
      head = await runGit(
        workspacePath,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        signal,
      );
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError(
        "tool",
        "Git repository state could not be inspected.",
      );
    }
    if (signal.aborted) throw cancelled();
    if (top.code !== 0)
      throw invalid(
        "Workspace is not inside a Git worktree; commit it to a repository before using worktree isolation.",
      );
    if (head.code !== 0)
      throw invalid(
        "The repository has no committed HEAD. Commit the parent workspace before creating an isolated agent worktree.",
      );

    let repository: string;
    try {
      repository = await realpath(resolve(top.stdout.trim()));
    } catch {
      throw new ForgeError(
        "tool",
        "Git repository root could not be resolved.",
      );
    }
    const baseRevision = head.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(baseRevision))
      throw new ForgeError(
        "tool",
        "Git returned an unsupported HEAD revision.",
      );

    const relativeWorkspace = relative(repository, workspacePath);
    if (relativeWorkspace.startsWith("..") || isAbsolute(relativeWorkspace))
      throw invalid(
        "Workspace is not contained in the detected Git repository.",
      );

    const destination = join(root, sessionId);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
    } catch {
      throw new ForgeError(
        "storage",
        "Agent worktree root could not be created.",
      );
    }
    if (await pathExists(destination))
      throw new ForgeError(
        "busy",
        `An agent worktree already exists at ${destination}; inspect and remove it manually before retrying.`,
      );
    if (signal.aborted) throw cancelled(destination);

    let added: GitResult;
    try {
      added = await runGit(
        repository,
        ["worktree", "add", "--detach", destination, baseRevision],
        signal,
      );
    } catch (error) {
      if (error instanceof ForgeError && error.code === "cancelled")
        throw cancelled(destination);
      throw new ForgeError(
        "tool",
        `Git could not create the agent worktree at ${destination}; the destination was retained for inspection and may contain partial files.`,
      );
    }
    if (signal.aborted) throw cancelled(destination);
    if (added.code !== 0)
      throw new ForgeError(
        "tool",
        `Git could not create the agent worktree at ${destination}; the destination was retained for inspection and may contain partial files.`,
      );

    const childWorkspace =
      relativeWorkspace === "" || relativeWorkspace === "."
        ? destination
        : join(destination, relativeWorkspace);
    try {
      await mkdir(childWorkspace, { recursive: true });
    } catch {
      throw new ForgeError(
        "storage",
        `Agent worktree was created at ${destination}, but its workspace subdirectory could not be prepared; inspect and remove it manually.`,
      );
    }
    return {
      workspace: childWorkspace,
      repository,
      baseRevision,
      worktree: destination,
    };
  }

  return { create };
}
