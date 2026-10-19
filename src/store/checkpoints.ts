import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import { MAX_EDITABLE_FILE_BYTES as LIMIT } from "../shared/file-limits";
import { createWorkspacePathGuard } from "../tools/path-guard";
import { canonicalPath, containsPath } from "../tools/protected-roots";
import {
  atomicJson,
  hasCode,
  privateDirectory,
  readJson,
  storageError,
  syncDirectory,
} from "./io";
import { fileLock } from "./lock";

const RECORD_LIMIT = Math.ceil(LIMIT * 8 / 3) + 64 * 1024;
const idSchema = z.string().uuid();
const recordSchema = z
  .object({
    id: idSchema,
    sessionId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    kind: z.enum(["created", "modified"]),
    state: z.enum(["pending", "completed", "restored"]),
    beforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    beforeMode: z.number().int().min(0).max(0o7777).nullable(),
    afterHash: z.string().regex(/^[a-f0-9]{64}$/),
    afterMode: z.number().int().min(0).max(0o7777).optional(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    restoredAt: z.string().datetime().optional(),
    before: z
      .string()
      .max(Math.ceil((LIMIT * 4) / 3) + 4)
      .nullable(),
    after: z.string().max(Math.ceil((LIMIT * 4) / 3) + 4),
  })
  .strict();
type RecordData = z.infer<typeof recordSchema>;
export type CheckpointMetadata = Omit<RecordData, "before" | "after">;
export interface RestoreOptions {
  readonly signal?: AbortSignal;
  readonly isSessionActive: (sessionId: string) => Promise<boolean>;
}
export interface CheckpointStore {
  list(signal?: AbortSignal): Promise<readonly CheckpointMetadata[]>;
  getDiff(id: string, signal?: AbortSignal): Promise<string>;
  restore(id: string, options: RestoreOptions): Promise<CheckpointMetadata>;
  begin(input: {
    path: string;
    sessionId: string;
    toolCallId: string;
    before: Buffer | null;
    beforeMode?: number | null;
    after: Buffer;
    signal?: AbortSignal;
  }): Promise<{
    complete(): Promise<CheckpointMetadata>;
    release(): Promise<void>;
  }>;
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const cancelled = () =>
  new ForgeError("cancelled", "Checkpoint operation cancelled.");
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}
function metadata(record: RecordData): CheckpointMetadata {
  const { before: _before, after: _after, ...rest } = record;
  return rest;
}
function bytes(encoded: string, expected: string): Buffer {
  const value = Buffer.from(encoded, "base64");
  if (
    value.length > LIMIT ||
    value.toString("base64") !== encoded ||
    hash(value) !== expected
  )
    throw storageError();
  return value;
}
async function current(path: string): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw storageError();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMIT) throw storageError();
    const value = await handle.readFile();
    if (value.length > LIMIT) throw storageError();
    return value;
  } finally {
    await handle.close();
  }
}
async function atomicBytes(
  path: string,
  value: Buffer,
  mode: number,
  signal?: AbortSignal,
) {
  const temp = join(dirname(path), `.forge-${randomUUID()}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let moved = false;
  try {
    await handle.writeFile(value);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    check(signal);
    await rename(temp, path);
    moved = true;
  } finally {
    await handle.close();
    if (!moved) await unlink(temp);
  }
}
// Nested storage is an internal opt-in only: its encompassing state root
// must be protected by the target guard. Existing two-argument callers retain
// the outside-workspace requirement and the persisted format/path is unchanged.
export async function createCheckpointStore(
  workspace: string,
  directory: string,
  options: { readonly protectedStateRoot: string } | undefined = undefined,
): Promise<CheckpointStore> {
  const protectedRoots = options ? [options.protectedStateRoot] : [];
  const guard = await createWorkspacePathGuard(workspace, protectedRoots);
  const destination = resolve(directory);
  const canonicalDestination = await canonicalPath(destination);
  const managed =
    options &&
    containsPath(
      await canonicalPath(options.protectedStateRoot),
      canonicalDestination,
    );
  if (options && !managed) throw storageError();
  if (
    !managed &&
    (containsPath(guard.root, destination) ||
      containsPath(guard.root, canonicalDestination))
  )
    throw storageError();
  const root = await privateDirectory(destination);
  const lockPath = join(root, "checkpoint.lock");
  function recordPath(id: string) {
    return join(root, `${idSchema.parse(id)}.json`);
  }
  async function load(id: string): Promise<RecordData> {
    const data = recordSchema.safeParse(
      await readJson(recordPath(id), RECORD_LIMIT),
    );
    if (!data.success || data.data.id !== id) throw storageError();
    return data.data;
  }
  async function target(name: string, writing: boolean) {
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name
        .split("/")
        .some(
          (part) =>
            part === ".." ||
            /^(?:\.git|\.config|\.ssh|\.env.*|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(
              part,
            ) ||
            /credential|\.(pem|key|p12|pfx)$/i.test(part),
        )
    )
      throw storageError();
    if (!name || name === "." || name.includes("\0")) throw storageError();
    return writing ? guard.resolveWrite(name) : guard.resolveRead(name);
  }
  return {
    async list(signal) {
      check(signal);
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(root);
      if (entries.length > 10000) throw storageError();
      const records: CheckpointMetadata[] = [];
      for (const entry of entries) {
        check(signal);
        if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
        const record = await load(entry.slice(0, -5));
        records.push(metadata(record));
      }
      return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async getDiff(id, signal) {
      check(signal);
      const record = await load(id);
      await target(record.path, true);
      const before =
        record.before === null
          ? ""
          : bytes(record.before, record.beforeHash ?? "").toString("utf8");
      const after = bytes(record.after, record.afterHash).toString("utf8");
      check(signal);
      // Full-file unified hunk, capped to avoid sending large private artifacts to UI.
      const lines = [
        `--- a/${record.path}`,
        `+++ b/${record.path}`,
        `@@ -1,${before.split("\n").length} +1,${after.split("\n").length} @@`,
        ...before.split("\n").map((x) => `-${x}`),
        ...after.split("\n").map((x) => `+${x}`),
      ];
      const diff = lines.join("\n");
      const limit = 128 * 1024;
      const encoded = Buffer.from(diff, "utf8");
      if (encoded.length <= limit) return diff;
      const marker = "\n[diff truncated]";
      const budget = limit - Buffer.byteLength(marker);
      const prefix = encoded
        .subarray(0, budget)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
      return prefix + marker;
    },
    async begin(input) {
      check(input.signal);
      if (
        !input.sessionId ||
        !input.toolCallId ||
        input.sessionId.length > 256 ||
        input.toolCallId.length > 256 ||
        input.after.length > LIMIT ||
        (input.before?.length ?? 0) > LIMIT
      )
        throw storageError();
      const path = await target(input.path, true);
      const release = await fileLock(lockPath, input.signal);
      let retained = false;
      try {
        check(input.signal);
        const actual = await current(path);
        if (
          (actual === null) !== (input.before === null) ||
          (actual && input.before && !actual.equals(input.before))
        )
          throw new ForgeError(
            "busy",
            "File changed before checkpoint; retry.",
          );
        const beforeMode =
          actual === null ? null : (await lstat(path)).mode & 0o7777;
        if (input.beforeMode !== undefined && input.beforeMode !== beforeMode)
          throw new ForgeError(
            "busy",
            "File mode changed before checkpoint; retry.",
          );
        const record: RecordData = {
          id: randomUUID(),
          sessionId: input.sessionId,
          toolCallId: input.toolCallId,
          path: input.path,
          kind: input.before === null ? "created" : "modified",
          state: "pending",
          beforeHash: input.before === null ? null : hash(input.before),
          beforeMode,
          afterHash: hash(input.after),
          createdAt: new Date().toISOString(),
          before: input.before?.toString("base64") ?? null,
          after: input.after.toString("base64"),
        };
        await atomicJson(recordPath(record.id), record, RECORD_LIMIT);
        check(input.signal);
        retained = true;
        let done = false;
        return {
          async complete() {
            if (done) throw storageError();
            const actual = await current(path);
            if (actual === null || hash(actual) !== record.afterHash)
              throw new ForgeError(
                "busy",
                "Resulting file does not match checkpoint; refusing completion.",
              );
            const afterMode = (await lstat(path)).mode & 0o7777;
            const updated: RecordData = {
              ...record,
              afterMode,
              state: "completed",
              completedAt: new Date().toISOString(),
            };
            await atomicJson(recordPath(record.id), updated, RECORD_LIMIT);
            done = true;
            return metadata(updated);
          },
          async release() {
            if (!done) done = true;
            await release();
          },
        };
      } finally {
        if (!retained) await release();
      }
    },
    async restore(id, options) {
      check(options.signal);
      if (!options.isSessionActive) throw storageError();
      const release = await fileLock(lockPath, options.signal);
      try {
        const record = await load(id);
        if (record.state !== "completed")
          throw new ForgeError("busy", "Checkpoint is not restorable.");
        if (await options.isSessionActive(record.sessionId))
          throw new ForgeError(
            "busy",
            "Session is active; stop it before restoring.",
          );
        check(options.signal);
        const path = await target(record.path, true);
        const parent = dirname(path);
        const parentInfo = await lstat(parent);
        const existing = await current(path);
        if (
          existing === null ||
          hash(existing) !== record.afterHash ||
          (record.afterMode !== undefined &&
            ((await lstat(path)).mode & 0o7777) !== record.afterMode)
        )
          throw new ForgeError(
            "busy",
            "File has changed since checkpoint; refusing restore.",
          );
        const original =
          record.before === null
            ? null
            : bytes(record.before, record.beforeHash ?? "");
        bytes(record.after, record.afterHash);
        check(options.signal);
        if (
          (await target(record.path, true)) !== path ||
          (await lstat(parent)).ino !== parentInfo.ino ||
          !(await current(path))?.equals(existing)
        )
          throw new ForgeError("busy", "File changed during restore.");
        if (original === null) await unlink(path);
        else
          await atomicBytes(
            path,
            original,
            record.beforeMode ?? 0o600,
            options.signal,
          );
        await syncDirectory(parent);
        const updated: RecordData = {
          ...record,
          state: "restored",
          restoredAt: new Date().toISOString(),
        };
        await atomicJson(recordPath(id), updated, RECORD_LIMIT);
        return metadata(updated);
      } finally {
        await release();
      }
    },
  };
}
