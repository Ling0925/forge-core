import type { createPluginHost } from "../plugins/host";
import { ForgeError } from "../shared/errors";
import {
  collectPublishedFiles,
  publishedFileIdSchema,
} from "../shared/published-files";
import { sessionIdSchema } from "../shared/schemas";
import type { openPublishedFileStore } from "../store/published-files";
import type { openSessionStore } from "../store/sessions";

type PublishedFileStore = Awaited<ReturnType<typeof openPublishedFileStore>>;

/**
 * Plugin publishing callbacks: office previews become HTML attachments and
 * browser screenshots are verified as real PNG/JPEG data before publishing.
 */
export const createPluginPublishers = (
  publishedFiles: PublishedFileStore,
): NonNullable<Parameters<typeof createPluginHost>[1]> => ({
  async publishOfficePreview(sessionId, preview, signal) {
    return publishedFiles.put(
      sessionId,
      Buffer.from(preview.html, "utf8"),
      {
        name: preview.name,
        mimeType: "text/html",
        previewKind: "html",
        description: preview.description,
      },
      signal,
    );
  },
  async publishImage(sessionId, image, signal) {
    const bytes = Buffer.from(image.data, "base64");
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (
      bytes.toString("base64") !== image.data ||
      (image.mimeType === "image/png" ? !png : !jpeg)
    )
      throw new ForgeError("tool", "Browser returned an invalid screenshot.");
    return publishedFiles.put(
      sessionId,
      bytes,
      {
        name: `browser-${Date.now()}.${png ? "png" : "jpg"}`,
        mimeType: image.mimeType,
        previewKind: "image",
        description: "Browser screenshot",
      },
      signal,
    );
  },
});

/**
 * Read a published attachment only through a session that references it, and
 * only when the stored metadata still matches the referenced snapshot.
 */
export const readSessionPublishedFile = async (
  store: Awaited<ReturnType<typeof openSessionStore>>,
  publishedFiles: PublishedFileStore,
  rawSessionId: unknown,
  rawFileId: unknown,
) => {
  const session = await store.get(sessionIdSchema.parse(rawSessionId));
  const fileId = publishedFileIdSchema.parse(rawFileId);
  const referenced = collectPublishedFiles(session.messages).find(
    (file) => file.id === fileId,
  );
  if (!referenced)
    throw new ForgeError(
      "not_found",
      "This session does not contain that attachment.",
    );
  const response = await publishedFiles.get(fileId);
  if (JSON.stringify(response.file) !== JSON.stringify(referenced))
    throw new ForgeError(
      "storage",
      "Attachment metadata does not match the published snapshot.",
    );
  return response;
};
