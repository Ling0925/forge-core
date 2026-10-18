import { z } from "zod";

export const PUBLISHED_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const PUBLISHED_SESSION_MAX_BYTES = 64 * 1024 * 1024;
export const PUBLISHED_SESSION_MAX_FILES = 128;
export const PUBLISHED_PREVIEW_MAX_BYTES = 1024 * 1024;
export const publishedFileIdSchema = z.string().uuid();
export const publishedFileNameSchema = z.string().trim().min(1).max(200)
  .refine(name => name !== "." && name !== ".." && !/[\\/\x00-\x1f\x7f]/.test(name), "Expected a plain file name");
export const publishedFileSchema = z.object({
  id: publishedFileIdSchema,
  name: publishedFileNameSchema,
  mimeType: z.string().min(1).max(128),
  size: z.number().int().min(0).max(PUBLISHED_FILE_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  previewKind: z.enum(["text", "html", "image", "none"]),
  description: z.string().trim().min(1).max(1000).optional(),
}).strict().readonly();
export type PublishedFile = z.infer<typeof publishedFileSchema>;
export const publishedFilesSchema = z.array(publishedFileSchema).max(16).readonly();
export const publishedFileResponseSchema = z.object({
  file: publishedFileSchema,
  base64: z.string().max(Math.ceil(PUBLISHED_FILE_MAX_BYTES / 3) * 4)
    .refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "Expected base64 bytes"),
}).strict().readonly();
export type PublishedFileResponse = z.infer<typeof publishedFileResponseSchema>;

/** Only actual successful publish_file exchanges carry deliverable files. */
export function collectPublishedFiles(messages: readonly {
  readonly role: string;
  readonly content: string | null;
  readonly tool_calls?: readonly { readonly id: string; readonly function: { readonly name: string } }[] | undefined;
  readonly tool_call_id?: string | undefined;
}[]): readonly PublishedFile[] {
  const calls = new Set<string>();
  const files = new Map<string, PublishedFile>();
  for (const message of messages) {
    if (message.role === "assistant") {
      calls.clear();
      for (const call of message.tool_calls ?? [])
        if (call.function.name === "publish_file") calls.add(call.id);
    } else if (message.role === "user") calls.clear();
    else if (message.role === "tool" && message.tool_call_id && calls.delete(message.tool_call_id)) {
      try {
        const result = z.object({ isError: z.literal(false), files: publishedFilesSchema }).passthrough().parse(JSON.parse(message.content ?? ""));
        for (const file of result.files) files.set(file.id, file);
      } catch { /* Legacy, failed and unrelated results are not attachments. */ }
    }
  }
  return [...files.values()];
}
