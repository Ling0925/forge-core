import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { privateDirectory } from "../store/io";
import { hostError } from "./errors";

export async function localSocketPath(
  path: string,
  createParent = false,
): Promise<string> {
  if (
    process.platform !== "linux" ||
    !isAbsolute(path) ||
    Buffer.byteLength(path) > 100 ||
    path.includes("\0")
  )
    throw hostError(
      "Use an absolute Linux Unix socket path of at most 100 bytes.",
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
