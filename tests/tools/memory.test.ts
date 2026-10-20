import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId, type Permission } from "../../src/shared/schemas";
import { searchMemorySchema, type MemoryStore } from "../../src/shared/memory";
import { openMemoryStore } from "../../src/store/memory";
import { createMemoryToolRegistry } from "../../src/tools/memory";

let root: string;
let store: MemoryStore;
let tools: LocalToolRegistry;
let context: ToolContext;
const forge = vi.fn(async () => ({ created: [0] }));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-memory-tools-"));
  store = await openMemoryStore(root);
  forge.mockClear();
  tools = createMemoryToolRegistry(store, { forge, redactValues: ["fixture-private-value"] });
  context = { sessionId: parseSessionId(randomUUID()), toolCallId: "call", workspace: root, permission: "unrestricted",
    signal: new AbortController().signal, approve: async () => false, onEvent: () => {} };
});
afterEach(async () => { await tools.dispose(); await store.close(); await rm(root, { recursive: true, force: true }); });
const call = (name: string, args: object) => ({ id: "call", type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const execute = (name: string, args: object, ctx = context) => tools.execute(call(name, args), ctx);

describe("memory tools", () => {
  it("publishes exactly five strict executable schemas and marks only reads concurrency-safe", () => {
    expect(tools.definitions.map(tool => tool.function.name)).toEqual(["update_memory", "del_memory", "get_memory", "search_memory", "forge_memory"]);
    for (const tool of tools.definitions) expect(tool.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
    expect(tools.definitions[0]?.function.parameters.properties).toHaveProperty("id", expect.objectContaining({ minimum: 0 }));
    expect(tools.isConcurrencySafe?.(call("get_memory", { id: 0 }))).toBe(true);
    expect(tools.isConcurrencySafe?.(call("forge_memory", { query: "forge" }))).toBe(false);
  });

  it("creates and patches ID 0, lists, paginates details and deletes", async () => {
    const created = await execute("update_memory", { summary: "中文", details: "abcdefgh", tags: ["one", "two"] });
    expect(created.isError).toBe(false);
    expect(JSON.parse(created.content)).toMatchObject({ id: 0, version: 1 });
    expect(JSON.parse(created.content)).not.toHaveProperty("details");
    expect((await execute("update_memory", { id: 0, tags: ["three"], expected_version: 1 })).isError).toBe(false);
    const page = JSON.parse((await execute("get_memory", { id: 0, offset: 2, limit: 3 })).content);
    expect(page).toMatchObject({ details: "cde", totalChars: 8, nextOffset: 5, tags: ["three"], version: 2 });
    expect(JSON.parse((await execute("get_memory", { id: 0, offset: 5 })).content).nextOffset).toBeNull();
    expect((await execute("get_memory", { id: 0, offset: 9 })).isError).toBe(true);
    expect(JSON.parse((await execute("search_memory", { keywords: ["中文"] })).content).total).toBe(1);
    expect(JSON.parse((await execute("del_memory", { id: 0, expected_version: 2 })).content)).toEqual({ id: 0, deleted: true });
  });

  it.each(["update_memory", "del_memory", "forge_memory"])("rejects readonly %s without store/model effects", async name => {
    const input = name === "forge_memory" ? { query: "forge", dry_run: true } : name === "del_memory" ? { id: 0 } : { summary: "s", details: "d" };
    const approve = vi.fn(async () => true);
    expect((await execute(name, input, { ...context, permission: "readonly", approve })).isError).toBe(true);
    expect(approve).not.toHaveBeenCalled(); expect(forge).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("permits readonly search/get and requires fresh workspace approval even for synthesis preview", async () => {
    await store.update({ summary: "s", details: "d" });
    const approve = vi.fn(async () => false);
    const ctx = { ...context, permission: "readonly" as const, approve };
    expect((await execute("get_memory", { id: 0 }, ctx)).isError).toBe(false);
    expect((await execute("search_memory", {}, ctx)).isError).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    expect((await execute("forge_memory", { query: "s", dry_run: true }, { ...ctx, permission: "workspace" })).isError).toBe(true);
    expect(approve).toHaveBeenCalledOnce(); expect(forge).not.toHaveBeenCalled();
    expect((await store.get(0))?.version).toBe(1);
    const allow = vi.fn<ToolContext["approve"]>(async () => true);
    expect((await execute("forge_memory", { query: "s", dry_run: true }, { ...context, permission: "workspace", approve: allow })).isError).toBe(false);
    expect(forge).toHaveBeenCalledOnce();
    expect(allow.mock.calls[0]?.[0]).toMatchObject({ description: expect.stringContaining("Send matching excerpts") });
  });

  it("cancellation or a permission downgrade during approval prevents writes", async () => {
    const controller = new AbortController();
    await expect(execute("update_memory", { summary: "s", details: "d" }, { ...context, permission: "workspace", signal: controller.signal,
      approve: async () => { controller.abort(); return true; } })).rejects.toMatchObject({ code: "cancelled" });
    let permission: Permission = "workspace";
    const result = await execute("update_memory", { summary: "s", details: "d" }, { ...context, get permission() { return permission; },
      approve: async () => { permission = "readonly"; return true; } });
    expect(result.isError).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("rechecks live permission at the SQLite write boundary after asynchronous preparation", async () => {
    let permission: Permission = "unrestricted";
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation(async (...args) => {
      permission = "readonly";
      return update(...args);
    });
    const result = await execute("update_memory", { summary: "s", details: "d" }, { ...context, get permission() { return permission; } });
    expect(result.isError).toBe(true);
    expect(await store.get(0)).toBeUndefined();
  });

  it("rejects invalid arguments/secrets before approval and redacts existing memory without malformed JSON", async () => {
    for (const args of [{ id: -1 }, { summary: "s" }, { summary: "s", details: "d", unknown: true }])
      expect((await execute("update_memory", args)).isError).toBe(true);
    expect((await execute("update_memory", { summary: "s", details: "fixture-private-value" })).isError).toBe(true);
    await store.update({ summary: "fixture-private-value", details: "api_key=fixture-value-long" });
    const read = await execute("get_memory", { id: 0 });
    expect(read.content).not.toContain("fixture-private-value");
    expect(read.content).not.toContain("fixture-value-long");
    expect(() => JSON.parse(read.content)).not.toThrow();
  });

  it("disposes the registry without closing the shared database", async () => {
    await tools.dispose();
    await expect(execute("get_memory", { id: 0 })).rejects.toMatchObject({ code: "cancelled" });
    expect((await store.search(searchMemorySchema.parse({}))).total).toBe(0);
  });
});
