import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ForgeError } from "../shared/errors";

export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const storageError = (): ForgeError =>
  new ForgeError("storage", "Stored data could not be safely accessed.");
export const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === code;

export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) await rejectSymlinkAncestors(parent);
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0
    )
      throw storageError();
    await chmod(absolute, 0o700);
    return absolute;
  } catch {
    throw storageError();
  }
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await rejectSymlinkAncestors(parent);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw storageError();
  }
}

export async function checkEntry(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw storageError();
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw storageError();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJson(
  path: string,
  limit = MAX_SNAPSHOT_BYTES,
): Promise<unknown> {
  try {
    if (!(await checkEntry(path)))
      throw new ForgeError("not_found", "Stored record was not found.");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit || (info.mode & 0o077) !== 0)
        throw storageError();
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length !== info.size) throw storageError();
      text = buffer.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (const char of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") {
        depth += 1;
        if (depth > 64) throw storageError();
      } else if (char === "}" || char === "]") depth -= 1;
    }
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw storageError();
  }
}

export async function atomicJson(
  path: string,
  value: unknown,
  limit = MAX_SNAPSHOT_BYTES,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > limit) throw storageError();
    await checkEntry(path);
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await checkEntry(path);
    await rename(temporary, path);
    created = false;
    await syncDirectory(dirname(path));
  } catch {
    throw storageError();
  } finally {
    if (created) await unlink(temporary);
  }
}
