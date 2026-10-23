import { defineTool } from "../shared/tool-definition";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { LocalToolRegistry } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { invalidToolInput, recoverToolInputError } from "../shared/tool-input";
import { PUBLISHED_FILE_MAX_BYTES, PUBLISHED_FILE_MAX_MIB, publishedFileNameSchema, type PublishedFile } from "../shared/published-files";
import type { PublishedFileStore } from "../store/published-files";
import { createWorkspacePathGuard } from "./path-guard";

const argumentsSchema = z.object({
  path: z.string().min(1).max(4096),
  displayName: publishedFileNameSchema.optional().describe("Optional download filename; defaults to the file's name."),
  description: z.string().trim().min(1).max(1000).optional(),
}).strict();
const fail = (message: string): never => { throw new ForgeError("tool", message); };
const check = (signal: AbortSignal) => { if (signal.aborted) throw new ForgeError("cancelled", "File publication cancelled."); };
const sensitive = (path: string) => path.split(/[\\/]/).some(part =>
  /^(?:\.env.*|\.ssh|\.config|\.git|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(part)
  || /credentials/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
const secretText = (text: string) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
  || /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/.test(text)
  || /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*(?:[A-Za-z0-9_-]{8,}|"[A-Za-z0-9_-]{8,}"|'[A-Za-z0-9_-]{8,}')\s*$/im.test(text);
const signature = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

function presentation(name: string, bytes: Buffer): Pick<PublishedFile, "mimeType" | "previewKind"> {
  const extension = extname(name).toLowerCase();
  // Only inert raster formats may be placed in an <img>. SVG is download-only.
  if (extension === ".png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: "image/png", previewKind: "image" };
  if (/^\.jpe?g$/.test(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mimeType: "image/jpeg", previewKind: "image" };
  if (extension === ".gif" && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return { mimeType: "image/gif", previewKind: "image" };
  if (extension === ".webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mimeType: "image/webp", previewKind: "image" };
  if (/^\.(?:txt|md|markdown|csv|tsv|json|jsonl|log|ya?ml|toml|xml|js|jsx|ts|tsx|css|py|rs|go|java|c|h|cpp|sh|sql|html?|htm)$/.test(extension)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.includes("\0")) return /^\.html?$/.test(extension) || extension === ".htm"
        ? { mimeType: "text/html", previewKind: "html" }
        : { mimeType: "text/plain", previewKind: "text" };
    } catch { /* Non-UTF-8 files remain downloadable. */ }
  }
  return { mimeType: extension === ".pdf" ? "application/pdf" : extension === ".zip" ? "application/zip" : "application/octet-stream", previewKind: "none" };
}

export async function createPublishedFileTool(workspace: string, store: PublishedFileStore, options: {
  readonly protectedRoots?: readonly string[];
  readonly redactValues?: readonly string[];
} = {}): Promise<LocalToolRegistry> {
  const guard = await createWorkspacePathGuard(workspace, options.protectedRoots);
  const known = options.redactValues?.filter(Boolean) ?? [];
  const unsafe = (text: string) => secretText(text) || known.some(secret => text.includes(secret));
  let disposed = false;
  return {
    definitions: [defineTool("publish_file", `Deliver an existing workspace file to this conversation as an immutable downloadable attachment. Use after generating a user-facing report, image or archive; writing a file alone does not send it. Workspace-relative only, no symlinks/hardlinks, credentials or sensitive content; protected state is inaccessible even unrestricted. Maximum ${PUBLISHED_FILE_MAX_MIB} MiB/file, 128 files/64 MiB per session. Readonly denied. Only metadata enters context; original bytes are preserved. Do not claim delivery unless this tool succeeds.`, argumentsSchema)],
    async execute(call, context) {
      try {
        check(context.signal);
        if (disposed || call.function.name !== "publish_file") fail("File publication is unavailable.");
        if (context.permission === "readonly") fail("Readonly permission forbids file publication.");
        if (await realpath(context.workspace) !== guard.root) fail("Workspace does not match this tool.");
        const args = argumentsSchema.safeParse(JSON.parse(call.function.arguments));
        if (!args.success) return invalidToolInput(args.error);
        const { path, displayName, description } = args.data;
        if (sensitive(path) || unsafe(path) || path.includes("\\") || (displayName && (sensitive(displayName) || unsafe(displayName))) || (description && unsafe(description))) fail("Sensitive paths or metadata cannot be published.");
        const target = await guard.resolveRead(path);
        const before = await lstat(target);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("Only regular, unlinked workspace files can be published.");
        if (before.size > PUBLISHED_FILE_MAX_BYTES) fail(`File exceeds the ${PUBLISHED_FILE_MAX_MIB} MiB ceiling.`);
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.nlink !== 1 || signature(before) !== signature(info)) fail("File changed while being published; inspect before retrying.");
          const buffer = Buffer.alloc(info.size + 1);
          let length = 0;
          while (length < buffer.length) {
            check(context.signal);
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length !== info.size || signature(info) !== signature(await handle.stat()) || target !== await guard.resolveRead(path) || signature(info) !== signature(await lstat(target))) fail("File changed while being published; inspect before retrying.");
          bytes = buffer.subarray(0, length);
        } finally { await handle.close(); }
        if (unsafe(bytes.toString("utf8"))) fail("Sensitive content cannot be published.");
        const name = publishedFileNameSchema.parse(displayName ?? basename(target));
        check(context.signal);
        const file = await store.put(context.sessionId, bytes, { name, ...presentation(name, bytes), ...(description ? { description } : {}) }, context.signal);
        return { content: JSON.stringify({ published: true, file }), isError: false, files: [file] };
      } catch (error) {
        if (error instanceof ForgeError && error.code === "cancelled") throw error;
        const invalid = recoverToolInputError(error);
        if (invalid) return invalid;
        return { content: JSON.stringify({ error: error instanceof ForgeError ? error.message : "File could not be safely published. Inspect the file and arguments before retrying." }), isError: true };
      }
    },
    async dispose() { disposed = true; },
  };
}
