import { randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { SessionStore } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { SessionId, SessionSnapshot } from "../shared/schemas";
import {
  createSessionInputSchema,
  sessionIdSchema,
  sessionSnapshotSchema,
  sessionSummarySchema,
} from "../shared/schemas";
import {
  atomicJson,
  hasCode,
  privateDirectory,
  readJson,
  storageError,
} from "./io";
import { fileLock } from "./lock";
export { MAX_SNAPSHOT_BYTES } from "./io";

const lockSchema = z
  .object({
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    start: z.string().nullable(),
    version: z.literal(1),
  })
  .strict();
const validateId = (id: unknown): SessionId => {
  const parsed = sessionIdSchema.safeParse(id);
  if (!parsed.success)
    throw new ForgeError("invalid_input", "Invalid session identifier.");
  return parsed.data;
};
function validateSnapshot(value: unknown, persisted: boolean): SessionSnapshot {
  const parsed = sessionSnapshotSchema.safeParse(value);
  if (!parsed.success)
    throw persisted
      ? storageError()
      : new ForgeError("invalid_input", "Invalid session snapshot.");
  const snapshot = parsed.data;
  if (
    !isAbsolute(snapshot.workspace) ||
    snapshot.updatedAt < snapshot.createdAt ||
    snapshot.events.some((event) => event.sessionId !== snapshot.id)
  ) {
    throw persisted
      ? storageError()
      : new ForgeError("invalid_input", "Invalid session relationships.");
  }
  const pending = new Set<string>();
  for (const message of snapshot.messages) {
    if (message.role === "assistant") {
      if (pending.size !== 0) throw storageError();
      for (const call of message.tool_calls ?? []) {
        if (pending.has(call.id)) throw storageError();
        pending.add(call.id);
      }
    } else if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) throw storageError();
    } else if (pending.size !== 0) throw storageError();
  }
  return snapshot;
}
export async function openSessionStore(
  directory: string,
): Promise<SessionStore> {
  const root = await privateDirectory(directory);
  const folder = await privateDirectory(join(root, "sessions"));
  const pathFor = (id: unknown): string =>
    join(folder, `${validateId(id)}.json`);
  const get: SessionStore["get"] = async (id) => {
    const snapshot = validateSnapshot(await readJson(pathFor(id)), true);
    if (snapshot.id !== id) throw storageError();
    return snapshot;
  };
  return {
    get,
    async list() {
      try {
        const summaries = [];
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw storageError();
          if (!entry.name.endsWith(".json")) continue;
          const id = validateId(entry.name.slice(0, -5));
          const snapshot = await get(id);
          const {
            messages: _messages,
            events: _events,
            changes: _changes,
            pendingTool: _pendingTool,
            ...summary
          } = snapshot;
          summaries.push(
            sessionSummarySchema.parse(
              Object.fromEntries(
                Object.entries(summary).filter(
                  ([key]) => key in sessionSummarySchema.unwrap().shape,
                ),
              ),
            ),
          );
        }
        return summaries.sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        );
      } catch (error) {
        if (error instanceof ForgeError && error.code === "storage")
          throw error;
        throw storageError();
      }
    },
    async create(input) {
      const parsed = createSessionInputSchema.safeParse(input);
      if (!parsed.success || !parsed.data.model || !parsed.data.title)
        throw new ForgeError(
          "invalid_input",
          "Invalid session creation input.",
        );
      let workspace: string;
      try {
        workspace = await realpath(parsed.data.workspace);
        if (!(await stat(workspace)).isDirectory()) throw storageError();
      } catch {
        throw new ForgeError(
          "invalid_input",
          "Workspace must be an existing directory.",
        );
      }
      const now = new Date().toISOString();
      const snapshot = validateSnapshot(
        {
          version: 1,
          id: randomUUID(),
          workspace,
          title: parsed.data.title,
          model: parsed.data.model,
          createdAt: now,
          updatedAt: now,
          status: "idle",
          messages: [],
          events: [],
          changes: [],
        },
        false,
      );
      await atomicJson(pathFor(snapshot.id), snapshot);
      return snapshot;
    },
    async save(snapshot) {
      const validated = validateSnapshot(snapshot, false);
      await get(validated.id);
      await atomicJson(pathFor(validated.id), validated);
    },
    async acquire(id, signal) {
      if (signal?.aborted)
        throw new ForgeError("cancelled", "Lock acquisition was cancelled.");
      await get(id);
      const legacyPath = `${pathFor(id)}.lock`;
      // The .lock inode is permanent: never unlink/replace it. Empty files are
      // descriptor-lock artifacts, not JSON. Legacy metadata is only consulted
      // under the kernel lock. Mixed old/new executables must not share state.
      const release = await fileLock(legacyPath, signal);
      try {
        if ((await stat(legacyPath)).size === 0) return release;
        const value = lockSchema.safeParse(await readJson(legacyPath, 4096));
        if (!value.success) throw storageError();
        let alive = true;
        try {
          process.kill(value.data.pid, 0);
        } catch (error) {
          alive = !hasCode(error, "ESRCH");
        }
        let start: string | null = null;
        try {
          const proc = await readFile(`/proc/${value.data.pid}/stat`, "utf8");
          start = proc.slice(proc.lastIndexOf(")") + 2).split(" ")[19] ?? null;
        } catch {
          /* Fail closed when identity is unavailable. */
        }
        if (
          alive &&
          (value.data.start === null ||
            start === null ||
            start === value.data.start)
        )
          throw new ForgeError("busy", "This session is already locked.", true);
        // Leave dead legacy metadata intact: all new clients check under flock,
        // and no pathname deletion can remove a replacement owner's lock.
        return release;
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}
