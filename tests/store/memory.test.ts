import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../../src/store/memory";
import { searchMemorySchema, type MemoryStore } from "../../src/shared/memory";

let root: string;
let store: MemoryStore;
const extra: MemoryStore[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "forge-sqlite-memory-")); store = await openMemoryStore(root); });
afterEach(async () => { await store.close(); for (const item of extra.splice(0)) await item.close(); await rm(root, { recursive: true, force: true }); });
const input = { summary: "编译 Forge CLI", details: "只编译后重开，不需要安装。", tags: ["forge", "本机"] };
const search = (args: object = {}) => store.search(searchMemorySchema.parse(args));

describe("SQLite long-term memory", () => {
  it("keeps absent read-only stores absent, and uses a private SQLite file on first write", async () => {
    expect(await store.get(0)).toBeUndefined();
    expect(await search()).toEqual({ hits: [], total: 0, nextOffset: null });
    expect(await readdir(root)).toEqual([]);
    await store.update(input);
    expect((await readFile(join(root, "memory.sqlite"))).subarray(0, 16).toString()).toBe("SQLite format 3\0");
    expect((await stat(join(root, "memory.sqlite"))).mode & 0o077).toBe(0);
  });

  it("starts at 0, persists and does not reuse deleted IDs", async () => {
    expect((await store.update(input)).id).toBe(0);
    expect((await store.update(input)).id).toBe(1);
    await store.delete({ id: 0, expected_version: 1 });
    await store.delete({ id: 1 });
    await store.close(); store = await openMemoryStore(root);
    expect(await store.get(0)).toBeUndefined();
    const created = await store.update(input);
    expect(created).toMatchObject({ id: 2, version: 1, ...input });
    await store.close(); store = await openMemoryStore(root);
    expect(await store.get(2)).toEqual(created);
  });

  it("allocates distinct IDs across concurrent handles", async () => {
    const other = await openMemoryStore(root); extra.push(other);
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? other : store).update(input)));
    expect(records.map(record => record.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect((await search()).total).toBe(20);
  });

  it("patches ID zero, normalizes tags and rejects missing IDs and stale versions", async () => {
    const first = await store.update({ ...input, tags: [" forge ", "forge", "本机"] });
    expect(first.tags).toEqual(["forge", "本机"]);
    const patched = await store.update({ id: 0, summary: "编译后重开", expected_version: 1 });
    expect(patched).toMatchObject({ id: 0, version: 2, details: input.details, tags: first.tags, created_at: first.created_at });
    await expect(store.update({ id: 0, details: "lost", expected_version: 1 })).rejects.toThrow(/conflict/);
    await expect(store.delete({ id: 0, expected_version: 1 })).rejects.toThrow(/conflict/);
    expect((await store.update({ id: 0, tags: [] })).tags).toEqual([]);
    await expect(store.update({ id: 99, summary: "missing" })).rejects.toThrow(/not found/);
    expect(await store.delete({ id: 99 })).toEqual({ id: 99, deleted: false });
    await expect(store.update({ summary: "no details" })).rejects.toThrow();
    await expect(store.update({ id: -1, summary: "invalid" })).rejects.toThrow();
  });

  it("searches Unicode/Chinese literally across tags, summary and details with pagination", async () => {
    await store.update({ ...input, details: "ÉLAN 的中文详情包含 100%_literal，不能当通配符。" });
    await store.update({ ...input, summary: "其他摘要", tags: ["forge"] });
    await store.update({ summary: "无关", details: "elsewhere", tags: ["本机"] });
    expect((await search({ keywords: ["FORGE", "中文", "élan"] })).hits.map(item => item.id)).toEqual([0]);
    expect((await search({ keywords: ["%_"] })).total).toBe(1);
    expect((await search({ keywords: ["' OR 1=1 --"] })).total).toBe(0);
    expect((await search({ tags: ["forge", "本机"], tag_mode: "all" })).hits.map(item => item.id)).toEqual([0]);
    expect((await search({ tags: ["forge", "本机"], tag_mode: "any" })).total).toBe(3);
    expect((await search({ tags: ["Forge"] })).total).toBe(0);
    expect((await search({ tags: ["本机"], keywords: ["无关"] })).hits.map(item => item.id)).toEqual([2]);
    const page = await search({ limit: 1 });
    expect(page).toMatchObject({ total: 3, nextOffset: 1 });
    expect(page.hits[0]).not.toHaveProperty("details");
    expect((await search({ offset: 2, limit: 1 })).nextOffset).toBeNull();
  });

  it("commits synthesis atomically with provenance and rolls back IDs on any conflict", async () => {
    await store.update(input);
    const source = { kind: "memory" as const, id: 0, version: 1 };
    await expect(store.apply([
      { ...input, summary: "new", sources: [source] },
      { id: 0, summary: "changed", expected_version: 9, sources: [source] },
    ], [])).rejects.toThrow(/conflict/);
    expect((await search()).total).toBe(1);
    expect((await store.get(0))?.version).toBe(1);
    const batch = await store.apply([{ ...input, summary: "new", sources: [source] },
      { id: 0, summary: "changed", expected_version: 1, sources: [source] }], [{ id: 0, version: 1 }]);
    expect(batch.map(record => record.id)).toEqual([1, 0]);
    expect((await store.get(1))?.sources).toEqual([source]);
    expect((await store.update({ id: 1, summary: "manual" })).sources).toEqual([source]);
    await expect(store.apply([{ ...input, sources: [] }], [{ id: 0, version: 1 }])).rejects.toThrow(/conflict/);
    expect((await search()).total).toBe(2);
  });

  it("does not write after cancellation, including while waiting for lazy initialization", async () => {
    const controller = new AbortController();
    const pending = store.update(input, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(await store.get(0)).toBeUndefined();
    await expect(store.apply([{ ...input, sources: [] }], [], controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect((await store.update(input)).id).toBe(0);
  });

  it("rejects linked database and sidecar paths without touching their targets", async () => {
    const target = join(root, "unrelated");
    await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, join(root, "memory.sqlite"));
    await expect(store.update(input)).rejects.toMatchObject({ code: "storage" });
    expect(await readFile(target, "utf8")).toBe("untouched");
    await rm(join(root, "memory.sqlite"));
    await symlink(target, join(root, "memory.sqlite-wal"));
    await expect(store.update(input)).rejects.toMatchObject({ code: "storage" });
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
});
