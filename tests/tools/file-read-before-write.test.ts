import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";

let root: string;
let tools: LocalToolRegistry;
let context: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-read-before-write-"));
  tools = await createLocalToolRegistry(root);
  context = {
    sessionId: parseSessionId(randomUUID()), toolCallId: "file-test", workspace: root,
    permission: "workspace", signal: new AbortController().signal,
    onEvent: () => {}, approve: async () => true,
  };
});
afterEach(async () => {
  await tools.dispose();
  await rm(root, { recursive: true, force: true });
});
function execute(name: string, args: object, ctx = context) {
  return tools.execute({ id: "file-test", type: "function",
    function: { name, arguments: JSON.stringify(args) } }, ctx);
}

it("rejects unread overwrites and edits without creating temporary files", async () => {
  await writeFile(join(root, "a"), "original");
  for (const [name, args] of [
    ["write_file", { path: "a", content: "replacement" }],
    ["edit_file", { path: "a", old_text: "original", new_text: "replacement" }],
  ] as const) {
    const outcome = await execute(name, args);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("read_file");
    expect(await readFile(join(root, "a"), "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["a"]);
  }
});

it("allows creation but requires an explicit read before the next modification", async () => {
  expect((await execute("write_file", { path: "a", content: "first" })).isError).toBe(false);
  expect((await execute("write_file", { path: "a", content: "second" })).isError).toBe(true);
  await execute("read_file", { path: "./a", limit: 1 });
  expect((await execute("edit_file", { path: "a", old_text: "first", new_text: "second" })).isError).toBe(false);
  expect((await execute("write_file", { path: "a", content: "third" })).isError).toBe(true);
  await execute("read_file", { path: "a" });
  expect((await execute("write_file", { path: "a", content: "third" })).isError).toBe(false);
});

it("scopes reads to the session, and search or failed/empty reads do not authorize writes", async () => {
  await writeFile(join(root, "a"), "original");
  await execute("search_files", { query: "original" });
  await execute("read_file", { path: "a", offset: 100 });
  expect((await execute("write_file", { path: "a", content: "replacement" })).isError).toBe(true);
  await execute("read_file", { path: "a" });
  const other = { ...context, sessionId: parseSessionId(randomUUID()) };
  expect((await execute("write_file", { path: "a", content: "replacement" }, other)).isError).toBe(true);
  expect((await execute("write_file", { path: "a", content: "replacement" })).isError).toBe(false);
});

it("rejects stale reads and allows a refreshed page after an external change", async () => {
  await writeFile(join(root, "a"), "old");
  await execute("read_file", { path: "a" });
  await writeFile(join(root, "a"), "external change");
  expect((await execute("write_file", { path: "a", content: "replacement" })).isError).toBe(true);
  expect((await execute("edit_file", { path: "a", old_text: "external", new_text: "local" })).isError).toBe(true);
  expect(await readFile(join(root, "a"), "utf8")).toBe("external change");
  await execute("read_file", { path: "a" });
  expect((await execute("edit_file", { path: "a", old_text: "external", new_text: "local" })).isError).toBe(false);
});

it("reports read metadata and does not emit changes for identical writes or replacements", async () => {
  await writeFile(join(root, "a"), "你好\nsecond");
  const read = await execute("read_file", { path: "a", limit: 1 });
  expect(JSON.parse(read.content)).toMatchObject({
    size_bytes: Buffer.byteLength("你好\nsecond"), lines_returned: 1, next_offset: 1,
    version: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const write = await execute("write_file", { path: "a", content: "你好\nsecond" });
  expect(JSON.parse(write.content)).toEqual({ written: false, unchanged: true });
  expect(write.changes).toEqual([]);
  const edit = await execute("edit_file", { path: "a", old_text: "second", new_text: "second" });
  expect(JSON.parse(edit.content)).toEqual({ edited: false, unchanged: true, replacements: 0 });
  expect(edit.changes).toEqual([]);
});

it("serializes competing writes so only one can consume the current read", async () => {
  await writeFile(join(root, "a"), "old");
  await execute("read_file", { path: "a" });
  const outcomes = await Promise.all([
    execute("write_file", { path: "a", content: "first" }),
    execute("write_file", { path: "a", content: "second" }),
  ]);
  expect(outcomes.filter(item => !item.isError)).toHaveLength(1);
  expect(await readFile(join(root, "a"), "utf8")).toBe("first");
});

it("treats an empty file as readable and allows updating it", async () => {
  await writeFile(join(root, "a"), "");
  expect((await execute("read_file", { path: "a" })).isError).toBe(false);
  expect((await execute("write_file", { path: "a", content: "now populated" })).isError).toBe(false);
});
