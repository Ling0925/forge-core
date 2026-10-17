import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { HTML_PREVIEW_MAX_BYTES, isHtmlPath } from "../shared/html-preview";
import { createWorkspacePathGuard } from "../tools/path-guard";

const DOCUMENT_LIMIT = 24;
const DOCUMENT_TTL_MS = 30 * 60 * 1000;
const DOCUMENT_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Ad-hoc HTML documents (a fenced code block) cannot be framed from a string:
 * `srcdoc`, `blob:` and `data:` frames are all refused by the workbench CSP.
 * They are therefore parked here behind an unguessable id and served as a real
 * same-origin URL, which the frame loads under its own restrictive CSP.
 */
export class HtmlPreviewStore {
  private readonly documents = new Map<
    string,
    { readonly html: string; readonly createdAt: number }
  >();
  private bytes = 0;

  put(html: string): string {
    this.evict();
    const id = randomBytes(24).toString("hex");
    this.documents.set(id, { html, createdAt: Date.now() });
    this.bytes += html.length;
    while (
      this.documents.size > DOCUMENT_LIMIT ||
      this.bytes > DOCUMENT_TOTAL_BYTES
    ) {
      const oldest = this.documents.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    return `/preview/document?id=${id}`;
  }

  get(id: string): string | undefined {
    this.evict();
    const entry = this.documents.get(id);
    if (!entry) return undefined;
    // Access keeps the document alive for the current viewing session.
    this.documents.delete(id);
    this.documents.set(id, entry);
    return entry.html;
  }

  private drop(id: string): void {
    const entry = this.documents.get(id);
    if (!entry) return;
    this.documents.delete(id);
    this.bytes -= entry.html.length;
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, entry] of this.documents) {
      if (now - entry.createdAt > DOCUMENT_TTL_MS) this.drop(id);
    }
  }
}

export class PreviewFileError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PreviewFileError";
    this.status = status;
  }
}

/** Reject dot-segments: `.git`, `.env*`, `.config`, `.ssh` and similar never preview. */
function sensitive(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => segment.startsWith(".") && segment !== ".");
}

/**
 * Read one workspace HTML file for preview. The path guard rejects traversal,
 * foreign absolute paths, symlinks and protected state roots; the reader
 * rejects non-HTML, oversized and non-UTF-8 content. The result is still
 * untrusted markup and is only ever framed with a sandbox.
 */
export async function readPreviewFile(
  workspace: string,
  relativePath: string,
): Promise<string> {
  if (!isHtmlPath(relativePath))
    throw new PreviewFileError(
      415,
      "Only .html or .htm files can be previewed.",
    );
  if (sensitive(relativePath))
    throw new PreviewFileError(403, "This path cannot be previewed.");
  let target: string;
  try {
    target = await (await createWorkspacePathGuard(workspace)).resolveRead(
      relativePath,
    );
  } catch {
    throw new PreviewFileError(404, "The file is not available for preview.");
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new PreviewFileError(404, "The file is not available for preview.");
  if (info.size > HTML_PREVIEW_MAX_BYTES)
    throw new PreviewFileError(413, "The file is too large to preview.");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > HTML_PREVIEW_MAX_BYTES)
      throw new PreviewFileError(413, "The file is too large to preview.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw new PreviewFileError(415, "The file is not UTF-8 text.");
    }
  } finally {
    await handle.close();
  }
}
