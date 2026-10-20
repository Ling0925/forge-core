import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import { deleteMemorySchema, memoryIdSchema, memoryRecordSchema, memorySourceSchema, memoryVersionSchema,
  searchMemorySchema, updateMemorySchema, type MemoryChange, type MemoryRecord, type MemoryStore } from "../shared/memory";
import { hasCode, privateDirectory, storageError } from "./io";

const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new ForgeError("cancelled", "Memory write cancelled."); };
const conflict = () => new ForgeError("tool", "Memory version conflict; read the current memory before retrying.");
const sourcesSchema = z.array(memorySourceSchema).max(32);
const expectedSchema = z.array(z.object({ id: memoryIdSchema, version: memoryVersionSchema }).strict()).max(60);
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), next_id INTEGER NOT NULL);
  INSERT OR IGNORE INTO memory_sequence VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY CHECK(id >= 0), tags TEXT NOT NULL, summary TEXT NOT NULL, details TEXT NOT NULL,
    sources TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  PRAGMA user_version = 1;
`;

async function safeDirectory(path: string): Promise<boolean> {
  const parent = dirname(path);
  if (parent !== path && !await safeDirectory(parent)) return false;
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
    return true;
  } catch (error) { if (hasCode(error, "ENOENT")) return false; throw storageError(); }
}
async function safeFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw storageError();
    return true;
  } catch (error) { if (hasCode(error, "ENOENT")) return false; throw storageError(); }
}
function record(row: Record<string, unknown> | undefined): MemoryRecord | undefined {
  if (!row) return undefined;
  return memoryRecordSchema.parse({ ...row, tags: JSON.parse(String(row.tags)), sources: JSON.parse(String(row.sources)) });
}
const get = (db: DatabaseSync, id: number) => record(db.prepare("SELECT * FROM memories WHERE id = ?").get(id));

/** Lazy, short-lived connections; reads of an absent store create no files. */
export async function openMemoryStore(directory: string): Promise<MemoryStore> {
  const root = resolve(directory);
  const path = join(root, "memory.sqlite");
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const access = <T>(write: boolean, empty: T, action: (db: DatabaseSync) => T, signal?: AbortSignal, beforeWrite?: () => void): Promise<T> => {
    if (closed) return Promise.reject(new ForgeError("storage", "Memory store is closed."));
    const work = queue.then(async () => {
      check(signal);
      let db: DatabaseSync | undefined;
      try {
        if (!write && !await safeDirectory(root)) return empty;
        if (write) await privateDirectory(root);
        if ((await lstat(root)).mode & 0o077) throw storageError();
        const exists = await safeFile(path);
        for (const suffix of ["-wal", "-shm", "-journal"]) await safeFile(`${path}${suffix}`);
        if (!exists && !write) return empty;
        if (!exists) {
          check(signal);
          try { const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.close(); }
          catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
        }
        await safeFile(path);
        const { DatabaseSync } = await import("node:sqlite");
        check(signal);
        if (write) beforeWrite?.();
        db = new DatabaseSync(path, { readOnly: !write });
        db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
        const version = db.prepare("PRAGMA user_version").get()?.user_version;
        if (version !== 0 && version !== 1) throw new ForgeError("storage", "Unsupported memory database version.");
        if (!write && version === 0) return empty;
        if (write) {
          db.exec("PRAGMA journal_mode = WAL;");
          if (version === 0) {
            db.exec("BEGIN IMMEDIATE");
            try { db.exec(SCHEMA); db.exec("COMMIT"); }
            catch (error) { db.exec("ROLLBACK"); throw error; }
          }
        }
        db.function("memory_lower", { deterministic: true }, value => String(value).toLowerCase());
        if (!write) return action(db);
        check(signal);
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = action(db);
          check(signal);
          db.exec("COMMIT");
          return result;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      } catch (error) {
        if (error instanceof ForgeError) throw error;
        throw storageError();
      } finally { db?.close(); }
    });
    queue = work.catch(() => undefined);
    return work;
  };
  const change = (db: DatabaseSync, input: MemoryChange): MemoryRecord => {
    const previous = input.id === undefined ? undefined : get(db, input.id);
    if (input.id !== undefined && !previous) throw new ForgeError("not_found", "Memory ID was not found.");
    if (input.expected_version !== undefined && previous?.version !== input.expected_version) throw conflict();
    const now = new Date().toISOString();
    let id = input.id;
    if (id === undefined) {
      const statement = db.prepare("SELECT next_id FROM memory_sequence WHERE singleton = 1");
      statement.setReadBigInts(true);
      const next = statement.get()?.next_id;
      if (typeof next !== "bigint" || next < 0n || next > BigInt(Number.MAX_SAFE_INTEGER)) throw new ForgeError("storage", "Memory ID sequence exhausted.");
      id = Number(next);
      db.prepare("UPDATE memory_sequence SET next_id = ? WHERE singleton = 1").run(next + 1n);
    }
    if (previous?.version === Number.MAX_SAFE_INTEGER) throw new ForgeError("storage", "Memory version exhausted.");
    const updated = memoryRecordSchema.parse({ id, tags: input.tags ?? previous?.tags ?? [],
      summary: input.summary ?? previous?.summary, details: input.details ?? previous?.details,
      sources: input.sources, version: (previous?.version ?? 0) + 1, created_at: previous?.created_at ?? now, updated_at: now });
    db.prepare(`INSERT INTO memories (id,tags,summary,details,sources,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET tags=excluded.tags, summary=excluded.summary, details=excluded.details,
      sources=excluded.sources, version=excluded.version, updated_at=excluded.updated_at`).run(updated.id, JSON.stringify(updated.tags),
        updated.summary, updated.details, JSON.stringify(updated.sources), updated.version, updated.created_at, updated.updated_at);
    return updated;
  };
  return {
    async get(raw) {
      const id = memoryIdSchema.parse(raw);
      return access(false, undefined, db => get(db, id));
    },
    async search(raw) {
      const input = searchMemorySchema.parse(raw);
      return access(false, { hits: [], total: 0, nextOffset: null }, db => {
        const conditions: string[] = [];
        const params: (string | number)[] = [];
        if (input.tags.length) {
          conditions.push(`(${input.tags.map(() => "EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value = ?)").join(input.tag_mode === "all" ? " AND " : " OR ")})`);
          params.push(...input.tags);
        }
        for (const keyword of input.keywords) {
          conditions.push("(instr(memory_lower(m.summary), ?) > 0 OR instr(memory_lower(m.details), ?) > 0 OR EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE instr(memory_lower(t.value), ?) > 0))");
          params.push(keyword.toLowerCase(), keyword.toLowerCase(), keyword.toLowerCase());
        }
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const total = Number(db.prepare(`SELECT count(*) AS n FROM memories m ${where}`).get(...params)?.n ?? 0);
        const rows = db.prepare(`SELECT * FROM memories m ${where} ORDER BY m.id LIMIT ? OFFSET ?`).all(...params, input.limit, input.offset);
        const hits = rows.map(row => {
          const value = record(row)!;
          const matches = input.keywords.map(keyword => value.details.toLowerCase().indexOf(keyword.toLowerCase())).filter(index => index >= 0);
          const start = matches.length ? Math.max(0, Math.min(...matches) - 80) : 0;
          const { details, sources: _sources, ...metadata } = value;
          return { ...metadata, excerpt: details.slice(start, start + 400) };
        });
        return { hits, total, nextOffset: input.offset + hits.length < total ? input.offset + hits.length : null };
      });
    },
    async update(raw, signal, beforeWrite) {
      const input = updateMemorySchema.parse(raw);
      return access<MemoryRecord>(true, undefined as never, db => change(db, { ...input,
        sources: input.id === undefined ? [] : get(db, input.id)?.sources ?? [] }), signal, beforeWrite);
    },
    async delete(raw, signal, beforeWrite) {
      const input = deleteMemorySchema.parse(raw);
      return access(true, { id: input.id, deleted: false }, db => {
        const previous = get(db, input.id);
        if (input.expected_version !== undefined && previous?.version !== input.expected_version) throw conflict();
        if (!previous) return { id: input.id, deleted: false };
        db.prepare("DELETE FROM memories WHERE id = ?").run(input.id);
        return { id: input.id, deleted: true };
      }, signal, beforeWrite);
    },
    async apply(rawChanges, rawExpected, signal, beforeWrite) {
      if (rawChanges.length > 12) throw new ForgeError("invalid_input", "Memory batch exceeds 12 changes.");
      const changes = rawChanges.map(({ sources, ...input }) => ({ ...updateMemorySchema.parse(input), sources: sourcesSchema.parse(sources) }));
      const expected = expectedSchema.parse(rawExpected);
      const ids = changes.flatMap(item => item.id === undefined ? [] : [item.id]);
      if (new Set(ids).size !== ids.length) throw new ForgeError("invalid_input", "Duplicate memory update ID.");
      if (!changes.length) { check(signal); return []; }
      return access<readonly MemoryRecord[]>(true, [], db => {
        for (const item of expected) if (get(db, item.id)?.version !== item.version) throw conflict();
        return changes.map(input => change(db, input));
      }, signal, beforeWrite);
    },
    async close() { closed = true; await queue; },
  };
}
