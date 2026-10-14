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
}
const CAP = 64 * 1024;
const FILES_CAP = 1000;
function cancelled(): ForgeError {
  return new ForgeError("cancelled", "Git inspection cancelled.");
}
// Do not trust repository configuration as executable policy. No ambient git environment.
const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_PAGER: "cat",
  GIT_EXTERNAL_DIFF: "",
  GIT_LFS_SKIP_SMUDGE: "1",
};
async function run(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
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
    let size = 0;
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
    const timer = setTimeout(() => kill("timeout"), 5000);
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
    // stderr is deliberately discarded: git diagnostics may contain credentials/paths.
    child.stderr.resume();
    child.once("error", () => {
      /* close handles spawn failures */
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reason === "cancelled" || signal?.aborted) reject(cancelled());
      else if (reason === "limit")
        reject(
          new ForgeError(
            "tool",
            "Git inspection output exceeded its 64 KiB ceiling.",
          ),
        );
      else if (reason || code !== 0)
        reject(
          new ForgeError("tool", "Git inspection unavailable or timed out."),
        );
      else resolve(Buffer.concat(parts));
    });
  });
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
  if (bytes.length <= CAP) return { output, truncated: false, omitted };
  return {
    output:
      bytes
        .subarray(0, CAP - Buffer.byteLength(marker))
        .toString("utf8")
        .replace(/\uFFFD$/, "") + marker,
    truncated: true,
    omitted,
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
  const top = (await run(root, ["rev-parse", "--show-toplevel"], signal))
    .toString("utf8")
    .trim();
  if (top !== root)
    throw new ForgeError("tool", "Workspace is not the repository root.");
  if (action === "log") {
    const output = (
      await run(
        root,
        ["log", "-10", "--format=%h %s", "--no-show-signature"],
        signal,
      )
    ).toString("utf8");
    let omitted = 0;
    const safe = output
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
    const data = (
      await run(
        root,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=normal",
          "--ignore-submodules=all",
        ],
        signal,
      )
    )
      .toString("utf8")
      .split("\0");
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
  const names = (
    await run(
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
    )
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const parts: string[] = [];
  let omitted = 0;
  for (const name of names) {
    if (signal?.aborted) throw cancelled();
    if (!(await safePath(guard, name)) || parts.length >= FILES_CAP) {
      omitted++;
      continue;
    }
    // Binary patch, textconv, ext diff, and submodule recursion are disabled explicitly.
    const patch = await run(
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
    const text = patch.toString("utf8");
    if (Buffer.byteLength(parts.join("")) + patch.length > CAP) {
      omitted++;
      const output = parts.join("");
      const marker = "\n[git output truncated]";
      const budget = CAP - Buffer.byteLength(marker);
      return {
        output:
          Buffer.from(output)
            .subarray(0, budget)
            .toString("utf8")
            .replace(/\uFFFD$/, "") + marker,
        truncated: true,
        omitted,
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
