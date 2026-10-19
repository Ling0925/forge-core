import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";
import { createCheckpointStore } from "../../src/store/checkpoints";

let root: string;
let registry: LocalToolRegistry;
let context: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-tool-contracts-"));
  registry = await createLocalToolRegistry(root);
  context = { sessionId: parseSessionId(randomUUID()), toolCallId: "call", workspace: root,
    permission: "unrestricted", signal: new AbortController().signal, onEvent: () => {}, approve: async () => false };
});
afterEach(async () => { await registry.dispose(); await rm(root, { recursive: true, force: true }); });
const execute = (name: string, args: object, ctx = context) => registry.execute({
  id: "call", type: "function", function: { name, arguments: JSON.stringify(args) },
}, ctx);

it("exposes disjoint flat write/append schemas", () => {
  const write = registry.definitions.find(tool => tool.function.name === "write_file")?.function.parameters;
  const append = registry.definitions.find(tool => tool.function.name === "append_file")?.function.parameters;
  expect(write).toMatchObject({ type: "object", required: ["path", "content"], additionalProperties: false });
  expect(write?.properties).not.toHaveProperty("append");
  expect(write?.properties).not.toHaveProperty("expected_bytes");
  expect(append).toMatchObject({ type: "object", required: ["path", "content", "expected_bytes"], additionalProperties: false });
  expect(append?.properties).not.toHaveProperty("append");
  expect(append).not.toHaveProperty("anyOf");
});

it("creates, appends UTF-8 chunks and edits under the same write authority", async () => {
  const written = await execute("write_file", { path: "a.txt", content: "中" });
  expect(written.isError).toBe(false);
  expect(JSON.parse(written.content)).toMatchObject({ size_bytes: 3 });
  const appended = await execute("append_file", { path: "a.txt", content: "文\n", expected_bytes: 3 });
  expect(appended.isError).toBe(false);
  expect(JSON.parse(appended.content)).toMatchObject({ size_bytes: 7 });
  expect(appended.changes?.[0]).toMatchObject({ path: "a.txt", kind: "modified", patch: { status: "complete" } });
  expect((await execute("edit_file", { path: "a.txt", old_text: "中文", new_text: "完成" })).isError).toBe(false);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("完成\n");
  expect((await execute("append_file", { path: "new.txt", content: "new", expected_bytes: 0 })).isError).toBe(false);
});

it("rejects stale, missing and readonly appends without changing the file", async () => {
  await execute("write_file", { path: "a.txt", content: "initial" });
  const stale = await execute("append_file", { path: "a.txt", content: "repeat", expected_bytes: 0 });
  expect(stale.isError).toBe(true);
  expect(stale.content).toContain("No content was appended");
  const missing = await execute("append_file", { path: "a.txt", content: "repeat" });
  expect(missing.isError).toBe(true);
  expect(JSON.parse(missing.content)).toMatchObject({ code: "invalid_input", error: expect.stringContaining("expected_bytes: expected number") });
  const readonly = await execute("append_file", { path: "a.txt", content: "repeat", expected_bytes: 7 }, { ...context, permission: "readonly" });
  expect(readonly.isError).toBe(true);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("initial");
});

it("preserves legacy append calls and explains incompatible write arguments", async () => {
  expect((await execute("write_file", { path: "a.txt", content: "one", append: true, expected_bytes: 0 })).isError).toBe(false);
  expect((await execute("write_file", { path: "a.txt", content: "two", append: true, expected_bytes: 3 })).isError).toBe(false);
  const rejected = await execute("write_file", { path: "a.txt", content: "replacement", append: false, expected_bytes: 6 });
  expect(rejected.isError).toBe(true);
  expect(JSON.parse(rejected.content)).toMatchObject({ code: "invalid_input", error: expect.stringContaining("Remove it, or use append_file") });
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("onetwo");
});

it("reports field constraints rather than hiding validation failures or echoing input", async () => {
  const invalid = await execute("read_file", { path: "secret-input-marker", limit: 201 });
  expect(invalid.isError).toBe(true);
  expect(JSON.parse(invalid.content)).toMatchObject({ code: "invalid_input", error: expect.stringContaining("limit: maximum 200") });
  expect(invalid.content).not.toContain("secret-input-marker");
  expect((await execute("write_file", { path: "a.txt", content: "ok" })).isError).toBe(false);
  expect((await execute("read_file", { path: "a.txt", limit: 200 })).isError).toBe(false);
  const malformed = await registry.execute({ id: "call", type: "function", function: { name: "write_file", arguments: '{"content":"private-marker' } }, context);
  expect(malformed.isError).toBe(true);
  expect(JSON.parse(malformed.content)).toMatchObject({ code: "invalid_input", error: expect.stringContaining("valid JSON") });
  expect(malformed.content).not.toContain("private-marker");
});

it("requires a current-run read and invalidates authority on external changes", async () => {
  await execute("write_file", { path: "a.txt", content: "old" });
  await registry.dispose();
  registry = await createLocalToolRegistry(root);
  const withoutRead = await execute("write_file", { path: "a.txt", content: "new" });
  expect(withoutRead.isError).toBe(true);
  expect(withoutRead.content).toContain("Previous-run reads do not carry write authority");
  await execute("read_file", { path: "a.txt" });
  expect((await execute("write_file", { path: "a.txt", content: "new" })).isError).toBe(false);
  await writeFile(join(root, "a.txt"), "external change");
  const stale = await execute("edit_file", { path: "a.txt", old_text: "external", new_text: "own" });
  expect(stale.isError).toBe(true);
  expect(stale.content).toContain("File changed since read_file in this run");
  await execute("read_file", { path: "a.txt" });
  expect((await execute("edit_file", { path: "a.txt", old_text: "external", new_text: "own" })).isError).toBe(false);
});

it("checkpoints append effects and restores the original bytes", async () => {
  const checkpointDir = await mkdtemp(join(tmpdir(), "forge-append-checkpoints-"));
  try {
    await registry.dispose();
    const store = await createCheckpointStore(root, checkpointDir);
    registry = await createLocalToolRegistry(root, { checkpointStore: store });
    await writeFile(join(root, "a.txt"), "original");
    await execute("read_file", { path: "a.txt" });
    expect((await execute("append_file", { path: "a.txt", content: " appended", expected_bytes: 8 })).isError).toBe(false);
    const checkpoints = await store.list();
    expect(checkpoints).toHaveLength(1);
    const checkpoint = checkpoints[0];
    if (!checkpoint) throw new Error("Missing append checkpoint");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original appended");
    await store.restore(checkpoint.id, { isSessionActive: async () => false });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original");
  } finally { await rm(checkpointDir, { recursive: true, force: true }); }
});
