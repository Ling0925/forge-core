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
import {
  atomicJson,
  hasCode,
  privateDirectory,
  readJson,
  storageError,
  syncDirectory,
} from "./io";

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
    version: z.literal(1),
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
function delta(previous: readonly unknown[], next: readonly unknown[]) {
  let keep = 0;
  while (
    keep < previous.length &&
    keep < next.length &&
    JSON.stringify(previous[keep]) === JSON.stringify(next[keep])
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
  const load = async (id: SessionId, fresh = false): Promise<Loaded> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = await stamp(basePath(id));
      if (!base)
        throw new ForgeError("not_found", "Stored record was not found.");
      const cached = cache.get(id);
      if (
        !fresh &&
        cached &&
        same(base, cached.base) &&
        same(
          await stamp(journalPath(id, cached.baseHash), true),
          cached.journal,
        )
      )
        return cached;
      const stored = parseSessionBase(await readJson(basePath(id)));
      let snapshot = validate(stored.snapshot, true);
      if (snapshot.id !== id) throw storageError();
      const initialHash = hash(snapshot);
      const baseHash = hash([initialHash, stored.generation ?? null]);
      const directory = journalPath(id, baseHash);
      const journal = await stamp(directory, true);
      let currentHash = initialHash;
      let count = 0;
      let bytes = 0;
      if (journal) {
        const entries = (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.name.endsWith(".json"))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (entries.length > CHECKPOINT_RECORDS) throw storageError();
        for (const entry of entries) {
          if (
            !entry.isFile() ||
            entry.name !== `${String(count + 1).padStart(8, "0")}.json`
          )
            throw storageError();
          const path = join(directory, entry.name);
          const parsed = recordSchema.safeParse(await readJson(path));
          if (!parsed.success) throw storageError();
          const record = parsed.data;
          if (record.before !== currentHash) throw storageError();
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
          currentHash = record.after;
          bytes += (await stamp(path))?.size ?? 0;
          count++;
        }
      }
      if (
        !same(base, await stamp(basePath(id))) ||
        !same(journal, await stamp(directory, true))
      )
        continue;
      const loaded = {
        snapshot,
        hash: currentHash,
        baseHash,
        base,
        journal,
        count,
        bytes,
        legacy: !stored.generation,
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
  return {
    async get(id: SessionId) {
      return (await load(id, true)).snapshot;
    },
    async create(snapshot: SessionSnapshot) {
      await atomicJson(basePath(snapshot.id), {
        ...snapshot,
        _journalGeneration: randomUUID(),
      });
      const loaded = await load(snapshot.id);
      await writeIndex(loaded);
    },
    async save(snapshot: SessionSnapshot) {
      const previous = await load(snapshot.id);
      const nextHash = hash(snapshot);
      if (previous.hash === nextHash) {
        await writeIndex(previous);
        return;
      }
      let loaded: Loaded;
      if (
        previous.legacy ||
        previous.count >= CHECKPOINT_RECORDS ||
        previous.bytes >= CHECKPOINT_BYTES ||
        ["completed", "failed", "cancelled", "interrupted"].includes(
          snapshot.status,
        )
      ) {
        const generation = randomUUID();
        await atomicJson(basePath(snapshot.id), {
          ...snapshot,
          _journalGeneration: generation,
        });
        const base = await stamp(basePath(snapshot.id));
        if (!base) throw storageError();
        loaded = {
          snapshot,
          hash: nextHash,
          baseHash: hash([nextHash, generation]),
          base,
          journal: null,
          count: 0,
          bytes: 0,
          legacy: false,
        };
      } else {
        const {
          messages: _messages,
          events: _events,
          changes: _changes,
          ...metadata
        } = snapshot;
        const record = {
          version: 1,
          before: previous.hash,
          after: nextHash,
          metadata,
          messages: delta(previous.snapshot.messages, snapshot.messages),
          events: delta(previous.snapshot.events, snapshot.events),
          changes: delta(previous.snapshot.changes, snapshot.changes),
        };
        const directory = await privateDirectory(
          journalPath(snapshot.id, previous.baseHash),
        );
        if (!previous.journal) await syncDirectory(folder);
        const path = join(
          directory,
          `${String(previous.count + 1).padStart(8, "0")}.json`,
        );
        // The session flock serializes writers; an existing committed record is
        // evidence of a stale writer, never something to overwrite.
        if (await stamp(path))
          throw new ForgeError("busy", "Session changed before saving.", true);
        await atomicJson(path, record);
        loaded = {
          ...previous,
          snapshot,
          hash: nextHash,
          journal: await stamp(directory, true),
          count: previous.count + 1,
          bytes: previous.bytes + Buffer.byteLength(JSON.stringify(record)) + 1,
        };
      }
      remember(snapshot.id, loaded);
      await writeIndex(loaded);
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
