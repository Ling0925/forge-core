import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { privateDirectory } from "../store/io";
import { hostError } from "./errors";

/**
 * Portable sun_path budget: Linux allows 107 bytes and macOS/BSD 103, so 100
 * bytes fits every POSIX platform with room to spare.
 */
export const LOCAL_SOCKET_PATH_MAX_BYTES = 100;

/**
 * Filesystem Unix sockets with owner-only permissions work on every POSIX
 * platform Node supports. On Windows Node maps socket paths to named pipes,
 * which have neither a filesystem inode nor POSIX modes to verify.
 */
export function supportsLocalSocket(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

export async function localSocketPath(
  path: string,
  createParent = false,
): Promise<string> {
  if (!supportsLocalSocket())
    throw hostError(
      "Local Unix socket hosting requires a POSIX platform (Linux, macOS or BSD).",
    );
  if (
    !isAbsolute(path) ||
    Buffer.byteLength(path) > LOCAL_SOCKET_PATH_MAX_BYTES ||
    path.includes("\0")
  )
    throw hostError(
      `Use an absolute Unix socket path of at most ${LOCAL_SOCKET_PATH_MAX_BYTES} bytes.`,
    );
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (createParent) await privateDirectory(parent);
  const info = await lstat(parent).catch(() => {
    throw hostError(
      "The local host socket directory is missing or inaccessible. No execution instance was created.",
    );
  });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.() ||
    (await realpath(parent)) !== parent
  )
    throw hostError(
      "The local host socket needs a private directory owned by the current user.",
    );
  return absolute;
}
export async function verifyLocalSocket(path: string): Promise<void> {
  const info = await lstat(path).catch(() => {
    throw hostError(
      "The local host socket is missing or inaccessible. No execution instance was created.",
    );
  });
  if (
    !info.isSocket() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw hostError(
      "The local host socket is not private to the current user.",
    );
}
