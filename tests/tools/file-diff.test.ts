import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalToolRegistry } from "../../src/tools/local";
import { parseSessionId, toolResultSchema, type Message } from "../../src/shared/schemas";
import { projectToolContext } from "../../src/core/tool-context";
import { createCheckpointStore } from "../../src/store/checkpoints";

it("captures complete late-file edits for write/edit without inflating model context or changing checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-file-diff-"));
  const checkpointDir = await mkdtemp(join(tmpdir(), "forge-diff-checkpoint-"));
  const sessionId = parseSessionId(randomUUID());
  const store = await createCheckpointStore(root, checkpointDir);
  const tools = await createLocalToolRegistry(root, { checkpointStore: store });
  const invoke = async (name: string, args: object) => {
    const call = { id: randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
    const result = await tools.execute(call, { sessionId, toolCallId: call.id, workspace: root,
      permission: "workspace", signal: new AbortController().signal, approve: async () => false, onEvent: () => {} });
    toolResultSchema.parse(result);
    return { call, result };
  };
  try {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`);
    const before = lines.join("");
    await writeFile(join(root, "large.ts"), before);
    expect((await invoke("read_file", { path: "large.ts" })).result.isError).toBe(false);
    const edit = await invoke("edit_file", { path: "large.ts", old_text: "line 2800\n", new_text: "LATE_EDIT_MARKER\n" });
    expect(edit.result.isError).toBe(false);
    expect(edit.result.changes?.[0]).toMatchObject({ truncated: true, patch: { status: "complete", added: 1, removed: 1 } });
    expect(JSON.stringify(edit.result.changes?.[0]?.patch)).toContain("LATE_EDIT_MARKER");
    lines[2800] = "LATE_WRITE_MARKER\n";
    await invoke("read_file", { path: "large.ts" });
    const write = await invoke("write_file", { path: "large.ts", content: lines.join("") });
    expect(write.result.changes?.[0]?.patch).toMatchObject({ status: "complete", added: 1, removed: 1 });
    expect(JSON.stringify(write.result.changes?.[0]?.patch)).toContain("LATE_WRITE_MARKER");
    const messages: Message[] = [
      { role: "assistant", content: null, tool_calls: [write.call] },
      { role: "tool", tool_call_id: write.call.id, content: JSON.stringify(write.result) },
    ];
    const projection = projectToolContext(messages);
    expect(JSON.stringify(projection)).not.toContain('"hunks"');
    expect(JSON.stringify(projection[1])).not.toContain("LATE_WRITE_MARKER");
    expect(messages[1]?.content).toContain("LATE_WRITE_MARKER");
    expect(projectToolContext(projection)).toEqual(projection);
    const checkpoints = await store.list();
    expect(checkpoints).toHaveLength(2);
    const checkpoint = checkpoints.find(item => item.toolCallId === write.call.id)!;
    await store.restore(checkpoint.id, { isSessionActive: async () => false });
    expect(await readFile(join(root, "large.ts"), "utf8")).toContain("LATE_EDIT_MARKER");
    const created = await invoke("write_file", { path: "new.ts", content: "a\nb\n" });
    expect(created.result.changes?.[0]).toMatchObject({ kind: "created", before: null, patch: { added: 2, removed: 0 } });
    const empty = await invoke("write_file", { path: "empty.ts", content: "" });
    expect(empty.result.changes?.[0]).toMatchObject({ kind: "created", patch: { status: "complete", added: 0, removed: 0 } });
    await invoke("read_file", { path: "new.ts" });
    const unchanged = await invoke("write_file", { path: "new.ts", content: "a\nb\n" });
    expect(unchanged.result.changes).toEqual([]);
  } finally { await tools.dispose(); await rm(root, { recursive: true, force: true }); await rm(checkpointDir, { recursive: true, force: true }); }
});
