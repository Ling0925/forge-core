import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import {
  type SessionId,
  type SessionSnapshot,
  sessionSummarySchema,
} from "../shared/schemas";
import type { SessionChange, SessionMutation } from "../shared/session-store";
import {
  atomicJson,
  hasCode,
  privateDirectory,
  readJson,
  storageError,
  syncDirectory,
} from "./io";
import { validateChange } from "./session-validation";

const CHECKPOINT_RECORDS = 64;
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const stampSchema = z
  .object({
    dev: z.number(),
    ino: z.number(),
    size: z.number(),
    mtimeMs: z.number(),
    ctimeMs: z.number(),
  })
  .strict();
type Stamp = z.infer<typeof stampSchema>;
const deltaSchema = z
  .object({
    keep: z.number().int().nonnegative(),
    append: z.array(z.unknown()).max(1000000),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    before: hashSchema,
    after: hashSchema,
    metadata: z.record(z.unknown()),
    messages: deltaSchema,
    events: deltaSchema,
    changes: deltaSchema,
  })
  .strict();
const summaryIndexSchema = z
  .object({
    version: z.literal(1),
    baseHash: hashSchema,
    base: stampSchema,
    journal: stampSchema.nullable(),
    summary: sessionSummarySchema,
  })
  .strict();
type Loaded = {
  snapshot: SessionSnapshot;
  hash: string;
  baseHash: string;
  base: Stamp;
  journal: Stamp | null;
  count: number;
  bytes: number;
  legacy: boolean;
  records: readonly { stamp: Stamp; change: SessionChange }[];
};
const baseRecordSchema = z
  .object({ _journalGeneration: z.string().uuid().optional() })
  .passthrough();
export function parseSessionBase(raw: unknown) {
  const parsed = baseRecordSchema.safeParse(raw);
  if (!parsed.success) throw storageError();
  const { _journalGeneration: generation, ...snapshot } = parsed.data;
  return { snapshot, generation };
}
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: Stamp | null, b: Stamp | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

async function stamp(path: string, directory = false): Promise<Stamp | null> {
  try {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (info.mode & 0o077) !== 0
    )
      throw storageError();
    return {
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}
function delta<T>(previous: readonly T[], next: readonly T[]) {
  let keep = 0;
  while (
    keep < previous.length &&
    keep < next.length &&
    (previous[keep] === next[keep] ||
      JSON.stringify(previous[keep]) === JSON.stringify(next[keep]))
  )
    keep++;
  return { keep, append: next.slice(keep) };
}
function apply(
  previous: readonly unknown[],
  change: z.infer<typeof deltaSchema>,
): readonly unknown[] {
  if (change.keep > previous.length) throw storageError();
  return [...previous.slice(0, change.keep), ...change.append];
}

/** Immutable delta records commit through atomic rename. A durable generation ID
 * survives backup copies and prevents old deltas replaying after checkpointing.
 * Closed generations are retained as recovery material, never rewritten. */
export function createSessionJournal(
  folder: string,
  summaries: string,
  validate: (value: unknown, persisted: boolean) => SessionSnapshot,
) {
  const cache = new Map<SessionId, Loaded>();
  const basePath = (id: SessionId) => join(folder, `${id}.json`);
  const journalPath = (id: SessionId, baseHash: string) =>
    join(folder, `${id}.${baseHash}.journal`);
  const indexPath = (id: SessionId) => join(summaries, `${id}.json`);
  const remember = (id: SessionId, value: Loaded) => {
    cache.delete(id);
    cache.set(id, value);
    if (cache.size > 4) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
  };
  const writeIndex = async (loaded: Loaded) => {
    const {
      messages: _messages,
      events: _events,
      changes: _changes,
      ...metadata
    } = loaded.snapshot;
    const shape = sessionSummarySchema.unwrap().shape;
    const summary = sessionSummarySchema.parse(
      Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key in shape),
      ),
    );
    await atomicJson(
      indexPath(loaded.snapshot.id),
      {
        version: 1,
        baseHash: loaded.baseHash,
        base: loaded.base,
        journal: loaded.journal,
        summary,
      },
      65536,
    );
    return summary;
  };
  const revision = (loaded: Loaded, current = loaded.hash) =>
    hash([loaded.baseHash, current]);
  const committed = async (directory: string) => {
    const journal = await stamp(directory, true);
    if (!journal) return { journal, entries: [] };
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (names.length > CHECKPOINT_RECORDS) throw storageError();
    const entries = await Promise.all(
      names.map(async (entry, index) => {
        if (
          !entry.isFile() ||
          entry.name !== `${String(index + 1).padStart(8, "0")}.json`
        )
          throw storageError();
        const path = join(directory, entry.name);
        const info = await stamp(path);
        if (!info) throw storageError();
        return { path, stamp: info };
      }),
    );
    return { journal, entries };
  };
  const load = async (id: SessionId): Promise<Loaded> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = await stamp(basePath(id));
      if (!base)
        throw new ForgeError("not_found", "Stored record was not found.");
      let cached = cache.get(id);
      if (cached && !same(base, cached.base)) cached = undefined;
      let loaded: Loaded;
      if (cached) loaded = cached;
      else {
        const stored = parseSessionBase(await readJson(basePath(id)));
        const snapshot = validate(stored.snapshot, true);
        if (snapshot.id !== id) throw storageError();
        const initialHash = hash(snapshot);
        loaded = {
          snapshot,
          hash: initialHash,
          baseHash: hash([initialHash, stored.generation ?? null]),
          base,
          journal: null,
          count: 0,
          bytes: 0,
          legacy: !stored.generation,
          records: [],
        };
      }
      const directory = journalPath(id, loaded.baseHash);
      const { journal, entries } = await committed(directory);
      // Directory mtime alone cannot detect an in-place modification of a record.
      // Check every bounded record's identity/ctime, including on a cache hit.
      if (cached && entries.length < cached.records.length)
        throw storageError();
      if (
        cached?.records.some(
          (record, i) => !same(record.stamp, entries[i]?.stamp ?? null),
        )
      ) {
        cache.delete(id);
        continue;
      }
      const records = [...loaded.records];
      let { snapshot, hash: currentHash, bytes } = loaded;
      for (const entry of entries.slice(records.length)) {
        const parsed = recordSchema.safeParse(await readJson(entry.path));
        if (!parsed.success) throw storageError();
        const record = parsed.data;
        if (record.before !== currentHash) throw storageError();
        if (record.version === 1) {
          snapshot = validate(
            {
              ...record.metadata,
              messages: apply(snapshot.messages, record.messages),
              events: apply(snapshot.events, record.events),
              changes: apply(snapshot.changes, record.changes),
            },
            true,
          );
          if (snapshot.id !== id || hash(snapshot) !== record.after)
            throw storageError();
        } else {
          const { after, ...payload } = record;
          if (hash(payload) !== after) throw storageError();
          snapshot = validateChange(snapshot, record, true);
        }
        const { messages, events, changes, ...metadata } = snapshot;
        // Store validated tails only; base history is never duplicated in the log cache.
        const change: SessionChange = {
          before: revision(loaded, record.before),
          after: revision(loaded, record.after),
          metadata,
          messages: {
            keep: record.messages.keep,
            append: messages.slice(record.messages.keep),
          },
          events: {
            keep: record.events.keep,
            append: events.slice(record.events.keep),
          },
          changes: {
            keep: record.changes.keep,
            append: changes.slice(record.changes.keep),
          },
        };
        records.push({ stamp: entry.stamp, change });
        currentHash = record.after;
        bytes += entry.stamp.size;
      }
      if (
        !same(base, await stamp(basePath(id))) ||
        !same(journal, await stamp(directory, true)) ||
        (await Promise.all(entries.map((entry) => stamp(entry.path)))).some(
          (info, i) => !same(info, entries[i]?.stamp ?? null),
        )
      )
        continue;
      loaded = {
        ...loaded,
        snapshot,
        hash: currentHash,
        journal,
        count: records.length,
        bytes,
        records,
      };
      remember(id, loaded);
      return loaded;
    }
    throw new ForgeError(
      "storage",
      "Session changed while being read. Try again.",
      true,
    );
  };
  const commit = async (id: SessionId, mutation: SessionMutation) => {
    const previous = await load(id);
    if (mutation.baseRevision !== revision(previous))
      throw new ForgeError(
        "busy",
        "Session version changed before saving.",
        true,
      );
    const snapshot = validateChange(previous.snapshot, mutation, false);
    const { messages, events, changes, ...metadata } = snapshot;
    const payload = {
      version: 2 as const,
      before: previous.hash,
      metadata,
      messages: {
        keep: mutation.messages.keep,
        append: messages.slice(mutation.messages.keep),
      },
      events: {
        keep: mutation.events.keep,
        append: events.slice(mutation.events.keep),
      },
      changes: {
        keep: mutation.changes.keep,
        append: changes.slice(mutation.changes.keep),
      },
    };
    const {
      messages: _m,
      events: _e,
      changes: _c,
      ...oldMetadata
    } = previous.snapshot;
    if (
      !previous.legacy &&
      messages === previous.snapshot.messages &&
      events === previous.snapshot.events &&
      changes === previous.snapshot.changes &&
      JSON.stringify(metadata) === JSON.stringify(oldMetadata)
    )
      return previous;
    let loaded: Loaded;
    if (
      previous.legacy ||
      previous.count >= CHECKPOINT_RECORDS ||
      previous.bytes >= CHECKPOINT_BYTES ||
      (["completed", "failed", "cancelled", "interrupted"].includes(
        snapshot.status,
      ) &&
        (previous.snapshot.status !== snapshot.status ||
          messages !== previous.snapshot.messages ||
          events !== previous.snapshot.events ||
          changes !== previous.snapshot.changes))
    ) {
      const generation = randomUUID();
      // Checkpoints use the canonical schema order used by cold-load hashing.
      const checkpoint = validate(snapshot, false);
      await atomicJson(basePath(id), {
        ...checkpoint,
        _journalGeneration: generation,
      });
      const base = await stamp(basePath(id));
      if (!base) throw storageError();
      const nextHash = hash(checkpoint);
      loaded = {
        snapshot: checkpoint,
        hash: nextHash,
        baseHash: hash([nextHash, generation]),
        base,
        journal: null,
        count: 0,
        bytes: 0,
        legacy: false,
        records: [],
      };
    } else {
      const nextHash = hash(payload);
      const record = { ...payload, after: nextHash };
      const directory = await privateDirectory(
        journalPath(id, previous.baseHash),
      );
      if (!previous.journal) await syncDirectory(folder);
      const path = join(
        directory,
        `${String(previous.count + 1).padStart(8, "0")}.json`,
      );
      // The caller's session flock serializes writers; never overwrite a committed record.
      if (await stamp(path))
        throw new ForgeError("busy", "Session changed before saving.", true);
      await atomicJson(path, record);
      const info = await stamp(path);
      if (!info) throw storageError();
      const change: SessionChange = {
        metadata,
        messages: payload.messages,
        events: payload.events,
        changes: payload.changes,
        before: revision(previous),
        after: revision(previous, nextHash),
      };
      loaded = {
        ...previous,
        snapshot,
        hash: nextHash,
        journal: await stamp(directory, true),
        count: previous.count + 1,
        bytes: previous.bytes + info.size,
        records: [...previous.records, { stamp: info, change }],
      };
    }
    remember(id, loaded);
    await writeIndex(loaded);
    return loaded;
  };
  return {
    async get(id: SessionId) {
      return (await load(id)).snapshot;
    },
    async read(id: SessionId) {
      const loaded = await load(id);
      return { revision: revision(loaded), snapshot: loaded.snapshot };
    },
    async changesSince(id: SessionId, baseRevision: string) {
      const loaded = await load(id);
      const current = revision(loaded);
      if (baseRevision === current) return { revision: current, changes: [] };
      const index = loaded.records.findIndex(
        (record) => record.change.before === baseRevision,
      );
      if (index >= 0)
        return {
          revision: current,
          changes: loaded.records.slice(index).map((record) => record.change),
        };
      return { revision: current, snapshot: loaded.snapshot };
    },
    async commit(id: SessionId, mutation: SessionMutation) {
      const loaded = await commit(id, mutation);
      return { revision: revision(loaded), snapshot: loaded.snapshot };
    },
    async create(snapshot: SessionSnapshot) {
      await atomicJson(basePath(snapshot.id), {
        ...snapshot,
        _journalGeneration: randomUUID(),
      });
      await writeIndex(await load(snapshot.id));
    },
    async save(snapshot: SessionSnapshot) {
      const previous = await load(snapshot.id);
      const { messages, events, changes, ...metadata } = snapshot;
      await commit(snapshot.id, {
        baseRevision: revision(previous),
        metadata,
        messages: delta(previous.snapshot.messages, messages),
        events: delta(previous.snapshot.events, events),
        changes: delta(previous.snapshot.changes, changes),
      });
    },
    async summary(id: SessionId) {
      try {
        const index = summaryIndexSchema.parse(
          await readJson(indexPath(id), 65536),
        );
        if (
          index.summary.id === id &&
          same(index.base, await stamp(basePath(id))) &&
          same(
            index.journal,
            await stamp(journalPath(id, index.baseHash), true),
          )
        )
          return index.summary;
      } catch (error) {
        if (!(error instanceof ForgeError) && !(error instanceof z.ZodError))
          throw error;
      }
      return writeIndex(await load(id));
    },
  };
}
