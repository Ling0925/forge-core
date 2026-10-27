import { spawn } from "node:child_process";
import { ForgeError } from "../shared/errors";
import {
  type WorkspacePathGuard,
  createWorkspacePathGuard,
} from "./path-guard";

export type GitAction = "status" | "diff" | "log";
export interface GitInspection {
  readonly output: string;
  readonly truncated: boolean;
  readonly omitted: number;
  /**
   * False when the workspace is not a usable Git work tree root. The three legacy
   * fields stay present and empty so existing callers keep their shape, but this is
   * an ordinary "not applicable here" answer rather than a failure to retry.
   */
  readonly repository: boolean;
  /** Authored, non-disclosing context. Never repository text, paths or exit stderr. */
  readonly note?: string;
}
const CAP = 64 * 1024;
const FILES_CAP = 1000;
// Diagnostics are read only to classify a failure; this bound keeps them from growing.
const DIAGNOSTIC_CAP = 8 * 1024;
const TIMEOUT_MS = 5000;
function cancelled(): ForgeError {
  return new ForgeError("cancelled", "Git inspection cancelled.");
}
// Locale is pinned so the classification below sees stable diagnostics; it never
// reaches the model. Do not trust repository configuration as executable policy.
const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/dev/null",
  LC_ALL: "C",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_PAGER: "cat",
  GIT_EXTERNAL_DIFF: "",
  GIT_LFS_SKIP_SMUDGE: "1",
};
export type GitInspectionOutcome =
  | Readonly<{ kind: "ok"; stdout: Buffer }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "output_limit" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "exit"; code: number | null; diagnostic: string }>;
type RunOutcome = GitInspectionOutcome;
async function run(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<RunOutcome> {
  if (signal?.aborted) return { kind: "cancelled" };
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      [
        "--no-optional-locks",
        // Repository filenames are data, never Git pathspec patterns (including :(glob)*).
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.pager=cat",
        "-c",
        "color.ui=false",
        "-c",
        "diff.external=",
        "-c",
        "diff.submodule=short",
        "-c",
        "submodule.recurse=false",
        "-C",
        root,
        ...args,
      ],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    const parts: Buffer[] = [];
    const diagnostic: Buffer[] = [];
    let size = 0;
    let diagnosticSize = 0;
    let spawnFailed = false;
    let reason: "cancelled" | "limit" | "timeout" | null = null;
    const kill = (why: typeof reason) => {
      if (reason) return;
      reason = why;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("timeout"), TIMEOUT_MS);
    const abort = () => kill("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (part: Buffer) => {
      if (size + part.length > CAP) {
        kill("limit");
        return;
      }
      size += part.length;
      parts.push(part);
    });
    // stderr stays private: it may contain credentials, paths and repository config.
    // Only bounded text is retained, and only to pick a fixed failure category.
    child.stderr.on("data", (part: Buffer) => {
      if (diagnosticSize >= DIAGNOSTIC_CAP) return;
      const slice = part.subarray(0, DIAGNOSTIC_CAP - diagnosticSize);
      diagnosticSize += slice.length;
      diagnostic.push(slice);
    });
    child.once("error", () => {
      /* close reports the spawn failure; no stdout can arrive without a process. */
      spawnFailed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reason === "cancelled" || signal?.aborted) resolve({ kind: "cancelled" });
      else if (reason === "timeout") resolve({ kind: "timeout" });
      else if (reason === "limit") resolve({ kind: "output_limit" });
      else if (spawnFailed) resolve({ kind: "unavailable" });
      else if (code !== 0)
        resolve({
          kind: "exit",
          code: code ?? null,
          diagnostic: Buffer.concat(diagnostic).toString("utf8"),
        });
      else resolve({ kind: "ok", stdout: Buffer.concat(parts) });
    });
  });
}
/** Fixed reasons a workspace has no inspection to report. Text is authored here. */
const notApplicableNotes: Readonly<Record<"absent" | "invalid" | "no_worktree", string>> = {
  absent:
    "This workspace is not inside a Git work tree, so Git status/diff/log do not apply here. Nothing was inspected; use filesystem tools, or run Git inspection from a repository root.",
  invalid:
    "This workspace has an unusable .git entry, so Git status/diff/log do not apply here. Nothing was inspected; repair the repository metadata outside these tools.",
  no_worktree:
    "This workspace is a Git directory without a working tree (for example a bare repository), so Git status/diff/log do not apply here. Nothing was inspected.",
};
/**
 * Map private git diagnostics onto fixed reasons. Matching is restricted to stable
 * message prefixes under LC_ALL=C, and no diagnostic text is ever returned.
 */
export function gitNotApplicableNote(outcome: GitInspectionOutcome): string | undefined {
  if (outcome.kind !== "exit") return undefined;
  if (/^(?:fatal|error): not a git repository\b/m.test(outcome.diagnostic))
    return notApplicableNotes.absent;
  if (
    /^(?:fatal|error): (?:invalid gitfile format|not a git directory|gitfile does not point to a valid repository)\b/m.test(
      outcome.diagnostic,
    )
  )
    return notApplicableNotes.invalid;
  if (/^(?:fatal|error): this operation must be run in a work tree\b/m.test(outcome.diagnostic))
    return notApplicableNotes.no_worktree;
  return undefined;
}
export function gitFailure(outcome: GitInspectionOutcome): ForgeError {
  switch (outcome.kind) {
    case "cancelled":
      return cancelled();
    case "timeout":
      return new ForgeError(
        "tool",
        `Git inspection timed out after ${TIMEOUT_MS / 1000} seconds. Use filesystem tools or an explicitly authorized targeted Git command; do not repeat the same inspection call.`,
      );
    case "output_limit":
      return new ForgeError(
        "tool",
        `Git inspection output exceeded its ${CAP / 1024} KiB ceiling. Use filesystem tools or an explicitly authorized targeted Git command; retrying the same call cannot succeed.`,
      );
    case "unavailable":
      return new ForgeError(
        "tool",
        "Git could not start in this environment (the git executable is missing or not executable). No repository data was read.",
      );
    case "exit":
      return outcome.code === null
        ? new ForgeError(
            "tool",
            "Git inspection failed because the git process was terminated by a signal. Repository state was not modified; git diagnostics are withheld because they can contain paths or credentials.",
          )
        : new ForgeError(
            "tool",
            `Git inspection failed with exit code ${outcome.code}. Repository state was not modified; git diagnostics are withheld because they can contain paths or credentials.`,
          );
    case "ok":
      return new ForgeError("internal", "Git inspection outcome was not a failure.");
  }
}
function notApplicableResult(note: string): GitInspection {
  return { output: "", truncated: false, omitted: 0, repository: false, note };
}
function forbidden(name: string): boolean {
  return (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          /^(?:\.env.*|\.ssh|\.config|\.git|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(
            part,
          ) ||
          /credentials/i.test(part) ||
          /\.(?:pem|key|p12|pfx)$/i.test(part),
      )
  );
}
async function safePath(
  guard: WorkspacePathGuard,
  name: string,
): Promise<boolean> {
  if (forbidden(name)) return false;
  try {
    await guard.resolveWrite(name);
    return true;
  } catch {
    return false;
  }
}
function redact(text: string, values: readonly string[]): string {
  let output = text;
  for (const value of values)
    if (value) output = output.split(value).join("[REDACTED]");
  return output
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*[^\s]+/gi,
      "[REDACTED]",
    );
}
function bounded(output: string, omitted: number): GitInspection {
  const marker = "\n[git output truncated]";
  const bytes = Buffer.from(output);
  if (bytes.length <= CAP) return { output, truncated: false, omitted, repository: true };
  return {
    output:
      bytes
        .subarray(0, CAP - Buffer.byteLength(marker))
        .toString("utf8")
        .replace(/\uFFFD$/, "") + marker,
    truncated: true,
    omitted,
    repository: true,
  };
}
/** Read-only observations, never checkpoints. No repository-controlled hooks or diff drivers execute. */
export async function gitInspect(
  workspace: string,
  action: GitAction,
  signal?: AbortSignal,
  redactValues: readonly string[] = [],
  protectedRoots: readonly string[] = [],
): Promise<GitInspection> {
  if (!["status", "diff", "log"].includes(action))
    throw new ForgeError("tool", "Invalid git inspection action.");
  const guard = await createWorkspacePathGuard(workspace, protectedRoots);
  const root = await guard.resolveRead(".");
  const probe = await run(root, ["rev-parse", "--show-toplevel"], signal);
  if (probe.kind !== "ok") {
    // A workspace outside a repository is a normal "nothing to inspect", not a failure
    // to retry. Genuine failures keep their own category instead of this generic text.
    const note = gitNotApplicableNote(probe);
    if (note !== undefined) return notApplicableResult(note);
    throw gitFailure(probe);
  }
  const top = probe.stdout.toString("utf8").trim();
  if (top !== root)
    throw new ForgeError(
      "tool",
      "Workspace is inside a Git work tree but is not its root. Run Git inspection from the repository root, or use filesystem tools for this subdirectory.",
    );
  if (action === "log") {
    const head = await run(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal);
    // Exit code 1 from --verify --quiet means "no such revision" without diagnostics:
    // a repository whose branch has no commits yet has an empty log, not a failure.
    if (head.kind === "exit" && head.code === 1)
      return {
        output: "",
        truncated: false,
        omitted: 0,
        repository: true,
        note: "Repository has no commits yet, so there is no log to show.",
      };
    if (head.kind !== "ok") throw gitFailure(head);
    const output = (
      await run(
        root,
        ["log", "-10", "--format=%h %s", "--no-show-signature"],
        signal,
      )
    );
    if (output.kind !== "ok") throw gitFailure(output);
    const text = output.stdout.toString("utf8");
    let omitted = 0;
    const safe = text
      .split("\n")
      .map((line) => {
        if (line.split(/\s+/).some((part) => forbidden(part))) {
          omitted++;
          return "[sensitive git subject withheld]";
        }
        return line;
      })
      .join("\n");
    return bounded(redact(safe, redactValues), omitted);
  }
  if (action === "status") {
    const status = await run(
      root,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ],
      signal,
    );
    if (status.kind !== "ok") throw gitFailure(status);
    const data = status.stdout.toString("utf8").split("\0");
    const lines: string[] = [];
    let omitted = 0;
    for (let index = 0; index < data.length - 1; index++) {
      if (signal?.aborted) throw cancelled();
      const entry = data[index] ?? "";
      const code = entry.slice(0, 2);
      const name = entry.slice(3);
      const rename = code.includes("R") || code.includes("C");
      const source = rename ? (data[++index] ?? "") : null;
      if (
        !(await safePath(guard, name)) ||
        (source !== null && !(await safePath(guard, source)))
      ) {
        omitted++;
        continue;
      }
      lines.push(`${code} ${name}${source === null ? "" : ` <- ${source}`}`);
      if (lines.length >= FILES_CAP) {
        omitted += data.length - index - 2;
        break;
      }
    }
    return bounded(redact(lines.join("\n"), redactValues), omitted);
  }
  // Enumerate changed names without displaying blobs; never request a diff for a forbidden path.
  const diffNames = await run(
    root,
    [
      "diff",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--name-only",
      "-z",
      "--",
    ],
    signal,
  );
  if (diffNames.kind !== "ok") throw gitFailure(diffNames);
  const names = diffNames.stdout.toString("utf8").split("\0").filter(Boolean);
  const parts: string[] = [];
  let omitted = 0;
  for (const name of names) {
    if (signal?.aborted) throw cancelled();
    if (!(await safePath(guard, name)) || parts.length >= FILES_CAP) {
      omitted++;
      continue;
    }
    // Binary patch, textconv, ext diff, and submodule recursion are disabled explicitly.
    const patchResult = await run(
      root,
      [
        "diff",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "--",
        name,
      ],
      signal,
    );
    if (patchResult.kind !== "ok") throw gitFailure(patchResult);
    const patch = patchResult.stdout;
    const text = patch.toString("utf8");
    if (Buffer.byteLength(parts.join("")) + patch.length > CAP) {
      omitted++;
      const output = parts.join("");
      const marker = "\n[git output truncated]";
      const budget = Math.max(0, CAP - Buffer.byteLength(marker));
      return {
        output:
          Buffer.from(output)
            .subarray(0, budget)
            .toString("utf8")
            .replace(/\uFFFD$/, "") + marker,
        truncated: true,
        omitted,
        repository: true,
      };
    }
    // An apparently harmless filename can still contain forbidden credentials. Refuse
    // the whole patch rather than returning a partial redaction of its blob.
    if (
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*[^\s]+|\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/i.test(
        text,
      )
    ) {
      omitted++;
      continue;
    }
    parts.push(redact(text, redactValues));
  }
  return bounded(parts.join(""), omitted);
}
