import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import {
  containsSensitiveText,
  isSensitivePath,
} from "../shared/content-safety";
import { MAX_EDITABLE_FILE_BYTES as FILE_LIMIT } from "../shared/file-limits";
import { check, fail, signature } from "./local-common";
import { CACHE_LIMIT } from "./local-schemas";
import type { WorkspacePathGuard } from "./path-guard";

export function createLocalPolicy({
  known,
  guard,
  readReceipts,
}: {
  known: readonly string[];
  guard: WorkspacePathGuard;
  readReceipts: Map<string, string>;
}) {
  const cache = new Map<
    string,
    Readonly<{ signature: string; text: string; bytes: number }>
  >();
  let cacheBytes = 0;
  function receiptKey(sessionId: string, path: string): string {
    return JSON.stringify([sessionId, path]);
  }
  function requireRead(sessionId: string, path: string, stamp: string): void {
    const receipt = readReceipts.get(receiptKey(sessionId, path));
    if (receipt === undefined)
      fail(
        "Read the current file with read_file in this run before writing or editing. Previous-run reads do not carry write authority. Omit if_version so content is returned.",
      );
    if (receipt !== stamp)
      fail(
        "File changed since read_file in this run. Retrying the same call cannot succeed. Read the current file again without if_version, then re-apply the edit against the fresh content.",
      );
  }
  function containsKnown(text: string): boolean {
    return known.some((value) => text.includes(value));
  }
  function redact(text: string): string {
    let clean = text;
    for (const value of known) clean = clean.split(value).join("[REDACTED]");
    if (containsSensitiveText(clean)) return "[Sensitive output withheld]";
    return clean;
  }
  function safeText(text: string): void {
    if (Buffer.byteLength(text, "utf8") > FILE_LIMIT)
      fail(
        "File exceeds the 16 MiB ceiling. Split it into separate files; retrying the same content cannot succeed.",
      );
    if (
      text.includes("\0") ||
      containsKnown(text) ||
      containsSensitiveText(text)
    )
      fail("Binary or sensitive content is not permitted.");
  }
  function invalidate(path: string): void {
    const entry = cache.get(path);
    if (entry) cacheBytes -= entry.bytes;
    cache.delete(path);
  }
  function remember(path: string, stamp: string, text: string): void {
    invalidate(path);
    const bytes = text.length * 2;
    while (cacheBytes + bytes > CACHE_LIMIT || cache.size >= 256) {
      const first = cache.keys().next();
      if (first.done) break;
      invalidate(first.value);
    }
    cache.set(path, { signature: stamp, text, bytes });
    cacheBytes += bytes;
  }
  function clearCache(): void {
    cache.clear();
    cacheBytes = 0;
  }
  function targetName(path: string): string {
    const name = relative(guard.root, path).split(sep).join("/") || ".";
    if (isSensitivePath(name) || containsKnown(name))
      fail("Sensitive paths are not permitted.");
    return name;
  }
  async function readTarget(
    path: string,
    signal: AbortSignal,
  ): Promise<Readonly<{ text: string; cacheHit: boolean; stamp: string }>> {
    check(signal);
    targetName(path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      fail("Expected a regular non-symlink file.");
    if (info.size > FILE_LIMIT)
      fail("File exceeds the 16 MiB ceiling. Split it into separate files.");
    const stamp = signature(info);
    const cached = cache.get(path);
    if (cached?.signature === stamp) {
      cache.delete(path);
      cache.set(path, cached);
      return { text: cached.text, cacheHit: true, stamp };
    }
    invalidate(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || signature(opened) !== stamp)
        fail("File changed while opening; retry.");
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        check(signal);
        const chunk = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (chunk.bytesRead === 0) break;
        length += chunk.bytesRead;
      }
      if (length > FILE_LIMIT)
        fail("File exceeds the 16 MiB ceiling. Split it into separate files.");
      if (signature(await handle.stat()) !== stamp)
        fail("File changed while reading; retry.");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        );
      } catch {
        return fail("File is not UTF-8 text.");
      }
      safeText(text);
      remember(path, stamp, text);
      return { text, cacheHit: false, stamp };
    } finally {
      await handle.close();
    }
  }
  async function read(relativePath: string, signal: AbortSignal) {
    if (isSensitivePath(relativePath))
      fail("Sensitive paths are not permitted.");
    const path = await guard.resolveRead(relativePath);
    targetName(path);
    return { path, ...(await readTarget(path, signal)) };
  }
  return {
    receiptKey,
    requireRead,
    containsKnown,
    redact,
    safeText,
    invalidate,
    clearCache,
    targetName,
    readTarget,
    read,
  };
}
