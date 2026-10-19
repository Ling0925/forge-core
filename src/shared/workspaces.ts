import { z } from "zod";

/**
 * Shared contract for the Web server directory browser.
 *
 * The browser only ever answers with directories: it never returns ordinary
 * files, hidden entries or symlinks, and it never reads file contents. The
 * request carries an absolute path only; when it is omitted the server decides
 * which directory to open (its own launch workspace), so no client-chosen
 * default is ever implied.
 */

export const WORKSPACE_PATH_MAX_LENGTH = 4096;
/** At most this many directories are returned in one page. */
export const WORKSPACE_DIRECTORY_LIMIT = 200;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A platform-neutral absolute path. `path.isAbsolute` lives in `node:path`,
 * which the renderer bundle cannot import, so this mirrors its spellings: a
 * POSIX root, a Windows drive root, or a UNC share. Control characters are
 * refused so no path can smuggle line breaks into a response or a log.
 */
export function isAbsoluteWorkspacePath(value: string): boolean {
  if (value.length === 0 || value.length > WORKSPACE_PATH_MAX_LENGTH)
    return false;
  if (hasControlCharacter(value)) return false;
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]/.test(value)
  );
}

const absolutePathSchema = z
  .string()
  .refine(isAbsoluteWorkspacePath, "Expected an absolute path");

export const workspaceBrowseRequestSchema = z
  .object({
    /**
     * Directory to list. Omitted means "the directory the server chooses",
     * which is always the host's launch workspace.
     */
    path: absolutePathSchema.optional(),
  })
  .strict()
  .readonly();
export type WorkspaceBrowseRequest = z.infer<
  typeof workspaceBrowseRequestSchema
>;

/** One browsable directory. `path` is absolute and already normalized. */
export const workspaceDirectoryEntrySchema = z
  .object({
    name: z.string().min(1).max(255),
    path: z.string().min(1).max(WORKSPACE_PATH_MAX_LENGTH),
  })
  .strict()
  .readonly();
export type WorkspaceDirectoryEntry = z.infer<
  typeof workspaceDirectoryEntrySchema
>;

/**
 * One page of a directory listing. `parent` is the canonical parent directory,
 * or `null` at a filesystem root (and where no parent may be offered).
 */
export const workspaceDirectoryPageSchema = z
  .object({
    path: z.string().min(1).max(WORKSPACE_PATH_MAX_LENGTH),
    parent: z.string().min(1).max(WORKSPACE_PATH_MAX_LENGTH).nullable(),
    directories: z
      .array(workspaceDirectoryEntrySchema)
      .max(WORKSPACE_DIRECTORY_LIMIT)
      .readonly(),
    /** The listing was cut short: more entries exist than were returned. */
    truncated: z.boolean(),
  })
  .strict()
  .readonly();
export type WorkspaceDirectoryPage = z.infer<
  typeof workspaceDirectoryPageSchema
>;
