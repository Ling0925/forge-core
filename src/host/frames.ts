import type { Socket } from "node:net";
import { PUBLISHED_FILE_MAX_BASE64_BYTES } from "../shared/published-files";
import { hostError } from "./errors";

export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
/** One maximum attachment is ~67 MiB as base64; leave 1 MiB for the JSON
 * envelope and 16 MiB for queued writes so it fits with slow-client headroom. */
export const MAX_RESPONSE_BYTES = Math.max(
  64 * 1024 * 1024,
  PUBLISHED_FILE_MAX_BASE64_BYTES + 17 * 1024 * 1024,
);
/** Bounded UTF-8 JSONL framing; no shell, eval, credentials or automatic retries. */
export function readFrames(
  socket: Socket,
  limit: number,
  receive: (value: unknown) => void,
  fail: (error: Error) => void,
) {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  socket.on("data", (chunk: Buffer) => {
    if (failed) return;
    try {
      // Enforce the per-frame bound even if multiple frames share one chunk.
      let offset = 0;
      for (;;) {
        const newline = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, newline < 0 ? undefined : newline);
        bytes += part.length;
        if (bytes > limit)
          throw hostError("Local host frame exceeds its size limit.");
        if (part.length) chunks.push(part);
        if (newline < 0) break;
        receive(JSON.parse(decoder.decode(Buffer.concat(chunks, bytes))));
        chunks = [];
        bytes = 0;
        offset = newline + 1;
      }
    } catch (error) {
      failed = true;
      fail(
        error instanceof Error ? error : hostError("Invalid local host frame."),
      );
    }
  });
}
export function sendFrame(
  socket: Socket,
  value: unknown,
  limit = MAX_RESPONSE_BYTES,
): boolean {
  if (socket.destroyed) return false;
  const frame = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(frame);
  if (bytes > limit || socket.writableLength + bytes > MAX_RESPONSE_BYTES) {
    socket.destroy();
    return false;
  }
  socket.write(frame);
  return true;
}
