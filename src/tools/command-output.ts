import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { type FileHandle, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeError } from "../shared/errors";

const COMMAND_BYTES = 16 * 1024 * 1024;
const RUN_BYTES = 128 * 1024 * 1024;
const PREVIEW_CHARS = 12000;
type Stream = "stdout" | "stderr";
type Record = { readonly sessionId: string; readonly paths: { readonly stdout: string; readonly stderr: string }; ready: boolean };

/** Run-scoped private logs. Redact the complete capture before exposing any page. */
export function createCommandOutputStore(redact: (text: string) => string) {
  let directory: Promise<string> | undefined;
  let usedBytes = 0;
  const records = new Map<string, Record>();
  return {
    async create(sessionId: string) {
      directory ??= mkdtemp(join(tmpdir(), "forge-command-output-"));
      const root = await directory;
      const id = randomUUID();
      const paths = { stdout: join(root, `${id}.stdout`), stderr: join(root, `${id}.stderr`) };
      const stdout = await open(paths.stdout, "wx", 0o600);
      let stderr: FileHandle;
      try { stderr = await open(paths.stderr, "wx", 0o600); }
      catch (error) { await stdout.close(); throw error; }
      const handles = { stdout, stderr };
      const record: Record = { sessionId, paths, ready: false };
      records.set(id, record);
      let bytes = 0;
      let limited = false;
      let storageFailed = false;
      let closed = false;
      return {
        capture(stream: Stream, chunk: Buffer) {
          if (closed || storageFailed) return;
          const length = Math.min(chunk.length, COMMAND_BYTES - bytes, RUN_BYTES - usedBytes);
          try {
            let offset = 0;
            while (offset < length) {
              const written = writeSync(handles[stream].fd, chunk, offset, length - offset);
              if (written === 0) throw new ForgeError("storage", "Command log write stalled.");
              offset += written;
              bytes += written;
              usedBytes += written;
            }
            if (length < chunk.length) limited = true;
          } catch {
            // A log failure must not replay or terminate the user's command.
            storageFailed = true;
          }
        },
        async finish() {
          closed = true;
          let out = "[Command finished; log capture is unavailable.]";
          let err = "";
          try {
            await Promise.all([stdout.close(), stderr.close()]);
            // Do not reveal a secret cut in half by a quota or disk failure.
            if (!limited && !storageFailed) {
              out = redact(await readFile(paths.stdout, "utf8"));
              err = redact(await readFile(paths.stderr, "utf8"));
              const size = Buffer.byteLength(out) + Buffer.byteLength(err);
              if (size > COMMAND_BYTES || usedBytes - bytes + size > RUN_BYTES) limited = true;
              else usedBytes += size - bytes;
            }
            if (limited || storageFailed) {
              out = "[Log capture incomplete; command execution was not interrupted.]";
              err = "";
            }
            await Promise.all([writeFile(paths.stdout, out, { mode: 0o600 }), writeFile(paths.stderr, err, { mode: 0o600 })]);
            record.ready = true;
          } catch {
            storageFailed = true;
            out = "[Command finished; log capture is unavailable. Do not rerun effects to recover output.]";
            err = "";
          }
          const incomplete = limited || storageFailed;
          return {
            stdout: out.slice(0, PREVIEW_CHARS), stderr: err.slice(0, PREVIEW_CHARS),
            truncated: incomplete, preview_truncated: out.length > PREVIEW_CHARS || err.length > PREVIEW_CHARS,
            ...(record.ready ? { output_id: id } : {}),
            output_notice: incomplete
              ? "Log capture reached its quota or failed; command was allowed to finish. Do not rerun effects just to recover output."
              : "Read remaining output with read_command_output(id, stream, offset). Logs expire when this run ends.",
          };
        },
        async discard() {
          if (!closed) {
            closed = true;
            await Promise.all([stdout.close(), stderr.close()]);
          }
          records.delete(id);
          await Promise.all([rm(paths.stdout, { force: true }), rm(paths.stderr, { force: true })]);
        },
      };
    },
    async read(sessionId: string, id: string, stream: Stream, offset: number, limit: number) {
      const record = records.get(id);
      if (!record || record.sessionId !== sessionId || !record.ready)
        throw new ForgeError("tool", "Unknown or unfinished command output for this session/run.");
      const text = await readFile(record.paths[stream], "utf8");
      const end = Math.min(text.length, offset + limit);
      return { id, stream, content: text.slice(offset, end), offset, offset_units: "utf16_code_units",
        total_chars: text.length, next_offset: end < text.length ? end : null, truncated: end < text.length };
    },
    async dispose() {
      records.clear();
      if (directory) await rm(await directory, { recursive: true, force: true });
    },
  };
}
