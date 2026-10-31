import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";

import { createProtectedRootMatcher } from "./protected-roots";

export type WorkspacePathErrorCode =
  | "PROTECTED_PATH"
  | "OUTSIDE_WORKSPACE"
  | "SYMLINK"
  | "NOT_DIRECTORY"
  | "MISSING"
  | "INVALID_PATH";

export class WorkspacePathError extends Error {
  readonly code: WorkspacePathErrorCode;
  readonly relativePath: string | null;

  constructor(code: WorkspacePathErrorCode, relativePath: string | null) {
    super(`Workspace path rejected: ${code}`);
    this.name = "WorkspacePathError";
    this.code = code;
    this.relativePath = relativePath;
  }
}

export interface WorkspacePathGuard {
  readonly root: string;
  readonly isProtected: (path: string) => boolean;
  readonly resolveRead: (relative: string) => Promise<string>;
  readonly resolveWrite: (relative: string) => Promise<string>;
}

type AccessMode = "read" | "write";

function filesystemErrorCode(error: unknown): WorkspacePathErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "ENOENT") return "MISSING";
    if (error.code === "ENOTDIR") return "NOT_DIRECTORY";
  }
  return "INVALID_PATH";
}

function parseRelative(relative: string): readonly string[] {
  if (relative.length === 0 || relative.includes("\0")) {
    throw new WorkspacePathError("INVALID_PATH", null);
  }
  // Reject foreign-platform absolute spellings as well as native ones.
  if (isAbsolute(relative) || win32.isAbsolute(relative)) {
    throw new WorkspacePathError("OUTSIDE_WORKSPACE", null);
  }
  // Windows drive-relative paths have ambient drive state; they are not accepted.
  if (/^[A-Za-z]:/.test(relative)) {
    throw new WorkspacePathError("INVALID_PATH", null);
  }
  const components = relative
    .split(sep === "\\" ? /[\\/]/ : /\//)
    .filter((component) => component !== "" && component !== ".");
  let depth = 0;
  for (const component of components) {
    if (component === "..") {
      depth -= 1;
      if (depth < 0) {
        throw new WorkspacePathError("OUTSIDE_WORKSPACE", null);
      }
    } else {
      depth += 1;
    }
  }
  return components;
}

async function inspect(path: string, relativePath: string) {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    throw new WorkspacePathError(filesystemErrorCode(error), relativePath);
  }
}

export async function createWorkspacePathGuard(
  workspace: string,
  protectedRoots: readonly string[] = [],
): Promise<WorkspacePathGuard> {
  if (workspace.length === 0 || workspace.includes("\0")) {
    throw new WorkspacePathError("INVALID_PATH", null);
  }
  let root: string;
  try {
    root = await realpath(workspace);
  } catch (error: unknown) {
    throw new WorkspacePathError(filesystemErrorCode(error), null);
  }
  const isProtected = await createProtectedRootMatcher(protectedRoots);
  const rootInfo = await inspect(root, ".");
  if (!rootInfo.isDirectory()) {
    throw new WorkspacePathError("NOT_DIRECTORY", ".");
  }

  async function resolveTarget(
    relative: string,
    mode: AccessMode,
  ): Promise<string> {
    const components = parseRelative(relative);
    const normalized: string[] = [];
    for (const component of components) {
      if (component === "..") {
        normalized.pop();
      } else {
        normalized.push(component);
      }
    }
    const safeRelative = normalized.length === 0 ? "." : normalized.join(sep);
    let current = root;
    // Do not normalize away components before inspecting them: a/../b must
    // still reject a symlink (or missing/non-directory entry) at a.
    const steps = components.length === 0 ? ["."] : components;
    for (const [index, component] of steps.entries()) {
      current = resolve(current, component);
      if (isProtected(current))
        throw new WorkspacePathError("PROTECTED_PATH", safeRelative);
      const final = index === steps.length - 1;
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await inspect(current, safeRelative);
      } catch (error: unknown) {
        if (
          error instanceof WorkspacePathError &&
          error.code === "MISSING" &&
          mode === "write" &&
          final &&
          component !== ".." &&
          component !== "."
        ) {
          return join(root, safeRelative);
        }
        throw error;
      }
      if (info.isSymbolicLink()) {
        throw new WorkspacePathError("SYMLINK", safeRelative);
      }
      if (!final) {
        if (!info.isDirectory()) {
          throw new WorkspacePathError("NOT_DIRECTORY", safeRelative);
        }
        continue;
      }
      if (mode === "write" && info.isDirectory()) {
        throw new WorkspacePathError("NOT_DIRECTORY", safeRelative);
      }
      if (!info.isFile() && !info.isDirectory()) {
        throw new WorkspacePathError("INVALID_PATH", safeRelative);
      }
    }
    return current;
  }

  return Object.freeze({
    root,
    isProtected,
    resolveRead: (relative: string) => resolveTarget(relative, "read"),
    resolveWrite: (relative: string) => resolveTarget(relative, "write"),
  });
}
