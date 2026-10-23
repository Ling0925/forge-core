import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import {
  PUBLISHED_FILE_MAX_BASE64_BYTES, PUBLISHED_FILE_MAX_BYTES, PUBLISHED_FILE_MAX_MIB,
  PUBLISHED_SESSION_MAX_BYTES, PUBLISHED_SESSION_MAX_FILES,
  publishedFileIdSchema, publishedFileResponseSchema, publishedFileSchema,
  type PublishedFile, type PublishedFileResponse,
} from "../shared/published-files";
import { sessionIdSchema, type SessionId } from "../shared/schemas";
import { atomicJson, privateDirectory, readJson, storageError } from "./io";
import { fileLock } from "./lock";

const RECORD_LIMIT = PUBLISHED_FILE_MAX_BASE64_BYTES + 16384;
const SESSION_MAX_MIB = PUBLISHED_SESSION_MAX_BYTES / (1024 * 1024);
const indexSchema = z.array(publishedFileSchema).max(PUBLISHED_SESSION_MAX_FILES).readonly();
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export interface PublishedFileStore {
  put(sessionId: SessionId, bytes: Buffer, details: Pick<PublishedFile, "name" | "mimeType" | "previewKind" | "description">, signal: AbortSignal): Promise<PublishedFile>;
  get(id: string): Promise<PublishedFileResponse>;
}

/** Immutable records are global by random id, authorized by transcript references in the harness.
 * Forks retain those references without copying bytes. No filesystem paths leave this store. */
export async function openPublishedFileStore(stateDirectory: string): Promise<PublishedFileStore> {
  const directory = await privateDirectory(join(stateDirectory, "published-files"));
  const indexes = await privateDirectory(join(directory, "sessions"));
  async function checkDirectories() {
    await privateDirectory(directory);
    await privateDirectory(indexes);
  }
  return {
    async put(rawSessionId, bytes, details, signal) {
      const sessionId = sessionIdSchema.parse(rawSessionId);
      if (bytes.length > PUBLISHED_FILE_MAX_BYTES) throw new ForgeError("tool", `File exceeds the ${PUBLISHED_FILE_MAX_MIB} MiB ceiling.`);
      await checkDirectories();
      const release = await fileLock(join(indexes, `${sessionId}.lock`), signal);
      const indexPath = join(indexes, `${sessionId}.json`);
      try {
        let files: readonly PublishedFile[] = [];
        try { files = indexSchema.parse(await readJson(indexPath, 1024 * 1024)); }
        catch (error) { if (!(error instanceof ForgeError && error.code === "not_found")) throw storageError(); }
        if (files.length >= PUBLISHED_SESSION_MAX_FILES || files.reduce((sum, file) => sum + file.size, bytes.length) > PUBLISHED_SESSION_MAX_BYTES)
          throw new ForgeError("tool", `Session attachment quota reached (${PUBLISHED_SESSION_MAX_FILES} files / ${SESSION_MAX_MIB} MiB).`);
        if (signal.aborted) throw new ForgeError("cancelled", "File publication cancelled.");
        const file = publishedFileSchema.parse({ ...details, id: randomUUID(), size: bytes.length, sha256: hash(bytes), createdAt: new Date().toISOString() });
        // Reserve quota first: failures/crashes may consume quota, never create
        // unlimited orphan blobs. Do not roll back uncertain atomic writes.
        await atomicJson(indexPath, [...files, file], 1024 * 1024);
        await atomicJson(join(directory, `${file.id}.json`), { file, base64: bytes.toString("base64") }, RECORD_LIMIT);
        return file;
      } finally {
        await release();
      }
    },
    async get(rawId) {
      const id = publishedFileIdSchema.parse(rawId);
      await checkDirectories();
      const parsed = publishedFileResponseSchema.safeParse(await readJson(join(directory, `${id}.json`), RECORD_LIMIT));
      if (!parsed.success) throw storageError();
      const response = parsed.data;
      const bytes = Buffer.from(response.base64, "base64");
      if (response.file.id !== id || bytes.length !== response.file.size || hash(bytes) !== response.file.sha256 || bytes.toString("base64") !== response.base64)
        throw storageError();
      return response;
    },
  };
}
