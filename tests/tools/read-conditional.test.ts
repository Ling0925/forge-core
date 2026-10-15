import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";

describe("conditional file reads and read receipts", () => {
  let root: string;
  let tools: LocalToolRegistry;
  let context: ToolContext;
  const text = "first\nsecond\nthird";
  const version = createHash("sha256").update(text).digest("hex");
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-conditional-"));
    await writeFile(join(root, "a.txt"), text);
    tools = await createLocalToolRegistry(root);
    context = { sessionId: parseSessionId(randomUUID()), toolCallId: "read", workspace: root,
      permission: "workspace", signal: new AbortController().signal, onEvent: () => {}, approve: async () => false };
  });
  afterEach(async () => { await tools.dispose(); await rm(root, { recursive: true, force: true }); });
  async function run(name: string, args: Record<string, unknown>) {
    const result = await tools.execute({ id: "read", type: "function",
      function: { name, arguments: JSON.stringify(args) } }, context);
    return { ...result, data: JSON.parse(result.content) };
  }
  it("returns complete repeated pages by default and explicit end line", async () => {
    const first = await run("read_file", { path: "a.txt", offset: 1, limit: 1 });
    const second = await run("read_file", { path: "a.txt", offset: 1, limit: 1 });
    expect(first.data).toMatchObject({ content: "2: second", end_line: 2, offset: 1, next_offset: 2, version });
    expect(second.data).toMatchObject({ content: "2: second", end_line: 2, cache_hit: true });
    expect(second.data.unchanged).toBeUndefined();
    expect((await run("read_file", { path: "a.txt", offset: 100 })).data).toMatchObject({ content: "", end_line: null });
  });
  it("omits body only on matching SHA, retaining existing but not creating new receipts", async () => {
    const initial = await run("read_file", { path: "a.txt", if_version: version });
    expect(initial.data).toMatchObject({ unchanged: true, version, lines_returned: 0, end_line: null });
    expect(initial.data).not.toHaveProperty("content");
    expect((await run("write_file", { path: "a.txt", content: "changed" })).isError).toBe(true);
    await run("read_file", { path: "a.txt", limit: 1 });
    await run("read_file", { path: "a.txt", if_version: version.toUpperCase() });
    expect((await run("edit_file", { path: "a.txt", old_text: "first", new_text: "changed" })).isError).toBe(false);
  });
  it("does not reuse another session's receipt or authorize through search cache", async () => {
    await run("read_file", { path: "a.txt" });
    context = { ...context, sessionId: parseSessionId(randomUUID()) };
    await run("search_files", { query: "first" });
    await run("read_file", { path: "a.txt", if_version: version });
    expect((await run("edit_file", { path: "a.txt", old_text: "first", new_text: "changed" })).isError).toBe(true);
  });
  it("invalid or stale versions read normally and external changes require a fresh visible page", async () => {
    for (const if_version of ["invalid", "0".repeat(64), ""]) {
      expect((await run("read_file", { path: "a.txt", if_version })).data.content).toBe("1: first\n2: second\n3: third");
    }
    const changed = "external";
    await writeFile(join(root, "a.txt"), changed);
    const hash = createHash("sha256").update(changed).digest("hex");
    await run("read_file", { path: "a.txt", if_version: hash });
    expect((await run("write_file", { path: "a.txt", content: "next" })).isError).toBe(true);
    expect((await run("read_file", { path: "a.txt", if_version: version })).data.content).toBe("1: external");
    expect((await run("write_file", { path: "a.txt", content: "next" })).isError).toBe(false);
  });
});
