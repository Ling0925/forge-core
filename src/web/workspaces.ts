import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  WORKSPACE_DIRECTORY_LIMIT,
  type WorkspaceDirectoryPage,
  isAbsoluteWorkspacePath,
} from "../shared/workspaces";
import { containsPath, createProtectedRootMatcher } from "../tools/protected-roots";

/** At most this many directory entries are inspected while answering one page. */
export const WORKSPACE_SCAN_LIMIT = 2000;

/**
 * A browse failure that maps onto one HTTP status. The message is always a
 * fixed sentence: filesystem details, paths and stacks never reach the client.
 */
export class WorkspaceBrowseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "WorkspaceBrowseError";
    this.status = status;
  }
}

function fsErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** EACCES and friends are "not browsable"; missing or file targets are 404. */
function fsFailure(error: unknown): WorkspaceBrowseError {
  switch (fsErrorCode(error)) {
    case "ENOENT":
      return new WorkspaceBrowseError(404, "This directory does not exist.");
    case "ENOTDIR":
      return new WorkspaceBrowseError(404, "This path is not a directory.");
    case "ELOOP":
    case "EACCES":
    case "EPERM":
      return new WorkspaceBrowseError(403, "This directory cannot be browsed.");
    case "ENAMETOOLONG":
      return new WorkspaceBrowseError(400, "Expected an absolute path.");
    default:
      return new WorkspaceBrowseError(
        500,
        "The directory could not be listed.",
      );
  }
}

/** Dot-prefixed path components (`.git`, `.ssh`, `.env`) are never browsable. */
function hasHiddenComponent(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((segment) => segment.length > 0 && segment.startsWith("."));
}

/**
 * One bounded, read-only directory page.
 *
 * Security rules, all fail-closed:
 * - Only absolute paths are accepted, using this platform's `node:path`
 *   semantics (no drive enumeration, no drive-relative spellings).
 * - The target is canonicalized; it may not be a symlink itself, and listing
 *   never follows or returns symlinked directories.
 * - Only real directories are returned: no ordinary files, no hidden entries.
 * - Hidden, protected (Forge state) and unreadable directories are refused
 *   even when requested directly, and no refused parent is ever advertised.
 *   Hidden segments inside the host's own launch workspace path are exempt:
 *   a workspace that happens to live under a dotted directory stays usable,
 *   while hidden names *within* the browsed tree are still refused.
 *
 * `requested` is the client's absolute path; `undefined` opens the host's
 * launch workspace, so the server always decides the default.
 */
export async function browseWorkspaceDirectory(
  workspace: string,
  requested?: string,
): Promise<WorkspaceDirectoryPage> {
  if (
    requested !== undefined &&
    (!isAbsoluteWorkspacePath(requested) || !isAbsolute(requested))
  )
    throw new WorkspaceBrowseError(400, "Expected an absolute path.");

  const isProtected = await createProtectedRootMatcher();
  let root: string;
  try {
    root = await realpath(workspace);
  } catch {
    throw new WorkspaceBrowseError(404, "This directory does not exist.");
  }
  // Only names below the launch workspace are subject to the hidden check, so
  // a workspace under `~/.config` does not become unbrowsable.
  const browsable = (path: string): boolean => {
    if (isProtected(path)) return false;
    const below = containsPath(root, path) ? relative(root, path) : path;
    return !hasHiddenComponent(below);
  };

  const target = requested ?? root;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(target);
  } catch (error: unknown) {
    throw fsFailure(error);
  }
  // A symlinked argument is refused rather than resolved to its target.
  if (info.isSymbolicLink())
    throw new WorkspaceBrowseError(403, "This directory cannot be browsed.");
  if (!info.isDirectory())
    throw new WorkspaceBrowseError(404, "This path is not a directory.");

  let canonical: string;
  try {
    // Canonicalize platform spellings (`/tmp` → `/private/tmp` on macOS).
    canonical = await realpath(target);
  } catch (error: unknown) {
    throw fsFailure(error);
  }
  if (!browsable(canonical))
    throw new WorkspaceBrowseError(403, "This directory cannot be browsed.");

  const directories: { name: string; path: string }[] = [];
  let scanned = 0;
  let truncated = false;
  let ended = false;
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(canonical);
  } catch (error: unknown) {
    throw fsFailure(error);
  }
  try {
    while (scanned < WORKSPACE_SCAN_LIMIT) {
      const entry = await directory.read();
      if (entry === null) {
        ended = true;
        break;
      }
      scanned += 1;
      // `Dirent` is lstat-based, so a symlink is never reported as a directory.
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = join(canonical, entry.name);
      if (entry.name.length > 255 || !isAbsoluteWorkspacePath(child) || !browsable(child)) continue;
      if (directories.length >= WORKSPACE_DIRECTORY_LIMIT) {
        truncated = true;
        break;
      }
      directories.push({ name: entry.name, path: join(canonical, entry.name) });
    }
    if (!ended) truncated = true;
  } catch (error: unknown) {
    throw fsFailure(error);
  } finally {
    await directory.close().catch(() => undefined);
  }
  directories.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  const parent = dirname(canonical);
  return {
    path: canonical,
    // Never advertise a parent the client would only be refused.
    parent: parent === canonical || !browsable(parent) ? null : parent,
    directories,
    truncated,
  };
}
