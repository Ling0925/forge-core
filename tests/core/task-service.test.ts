import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTaskService } from "../../src/core/task-service";
import { openSessionStore } from "../../src/store/sessions";
import type { SessionId, SessionSnapshot } from "../../src/shared/schemas";
import type { CommandTaskAccess, TaskView } from "../../src/shared/task-view";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "forge-task-service-"));
  const store = await openSessionStore(dir);
  const parent = await store.create({ workspace: dir, title: "parent", model: "test" });
  const other = await store.create({ workspace: dir, title: "other", model: "test" });
  const owned = new Set<SessionId>();
  const commands: CommandTaskAccess[] = [];
  const cancel = vi.fn(async (id: SessionId) => { owned.delete(id); return true; });
  const service = createTaskService({ store, commands: () => commands, owns: id => owned.has(id), cancel,
    redact: text => text.replaceAll("SECRET_VALUE", "[REDACTED]") });
  async function child(root = parent, fields: Partial<SessionSnapshot> = {}) {
    const created = await store.create({ workspace: dir, title: "child", model: "child-model" });
    const snapshot = { ...created, parentSessionId: root.id, ...fields };
    await store.save(snapshot); return snapshot;
  }
  return { store, parent, other, owned, cancel, commands, service, child, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
it("lists only direct children, prioritizes owned active work and labels stale history read-only", async () => {
  const f = await fixture();
  try {
    const historical = await f.child(f.parent, { status: "running" });
    const live = await f.child(f.parent, { status: "awaiting_approval" }); f.owned.add(live.id);
    await f.child(f.other); await f.child(live);
    const first = await f.service.listTasks(f.parent.id, 0, 1);
    expect(first.tasks).toHaveLength(1); expect(first.tasks[0]).toMatchObject({ id: live.id, active: true, controllable: true });
    expect(first.nextOffset).toBe(1);
    const next = await f.service.listTasks(f.parent.id, 1, 1);
    expect(next.tasks[0]).toMatchObject({ id: historical.id, status: "running", active: false, controllable: false, historical: true });
    expect(await f.service.stopTask(f.parent.id, "agent", historical.id)).toBe(false);
    expect(f.cancel).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
it("authorizes detail and cancellation using parent relationship, never root or siblings", async () => {
  const f = await fixture();
  try {
    const live = await f.child(f.parent, { status: "running" }); f.owned.add(live.id);
    const foreign = await f.child(f.other, { status: "running" }); f.owned.add(foreign.id);
    await expect(f.service.getTask(f.parent.id, "agent", foreign.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await f.service.stopTask(f.parent.id, "agent", foreign.id)).toBe(false);
    expect(await f.service.stopTask(f.parent.id, "agent", f.parent.id)).toBe(false);
    expect(await f.service.stopTask(f.parent.id, "agent", live.id)).toBe(true);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(live.id);
  } finally { await f.cleanup(); }
});
it("paginates after redaction and exposes safe activity and reported usage without tool bodies", async () => {
  const f = await fixture();
  try {
    const created = await f.child();
    const time = created.createdAt;
    const child = { ...created, status: "running" as const, messages: [{ role: "assistant" as const, content: "123SECRET_VALUE456" }], events: [
      { type: "run_started" as const, sessionId: created.id, timestamp: time, model: "child-model", permission: "workspace" as const },
      { type: "tool_started" as const, sessionId: created.id, timestamp: time, call: { id: "call", type: "function" as const, function: { name: "edit_file", arguments: JSON.stringify({ path: "a.ts", new_text: "PRIVATE_BODY" }) } } },
    ] };
    await f.store.save(child); f.owned.add(child.id);
    const page = await f.service.getTask(f.parent.id, "agent", child.id, 0, 8);
    expect(page.task.activity).toBe("edit_file a.ts"); expect(JSON.stringify(page)).not.toContain("PRIVATE_BODY");
    const rest = await f.service.getTask(f.parent.id, "agent", child.id, page.nextOffset!, 8192);
    expect(page.content + rest.content).toBe("123[REDACTED]456");
    expect(page.truncated).toBe(true);
    await f.store.save({ ...child, status: "completed", events: [...child.events, { type: "run_finished", sessionId: child.id, timestamp: time, status: "completed", turns: 1, toolCalls: 1, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }] });
    expect((await f.service.getTask(f.parent.id, "agent", child.id)).task).toMatchObject({ active: false, usage: { totalTokens: 15 } });
    expect((await f.service.getTask(f.parent.id, "agent", child.id)).task.activity).toBeUndefined();
  } finally { await f.cleanup(); }
});
it("includes parent and direct-child commands without acknowledging model delivery", async () => {
  const f = await fixture();
  try {
    const child = await f.child();
    const command: TaskView = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "command", sessionId: child.id, title: "node --version", status: "completed", active: false, controllable: false, historical: true };
    const read = vi.fn((sessionId: SessionId, id: string, offset: number, limit: number) => sessionId === child.id && id === command.id
      ? { task: command, content: "output SECRET_VALUE".slice(offset, offset + limit), offset, nextOffset: null, truncated: false } : undefined);
    const stop = vi.fn(async () => false);
    f.commands.push({ list: id => id === child.id ? [command] : [], read, stop });
    expect((await f.service.listTasks(f.parent.id)).tasks.some(task => task.id === command.id)).toBe(true);
    expect((await f.service.getTask(f.parent.id, "command", command.id)).content).toBe("output [REDACTED]");
    await expect(f.service.getTask(f.other.id, "command", command.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await f.service.stopTask(f.parent.id, "command", command.id)).toBe(false);
    expect(stop).not.toHaveBeenCalled(); expect(read).toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
it("rejects invalid IDs and pages without touching tasks", async () => {
  const f = await fixture();
  try {
    await expect(f.service.listTasks(f.parent.id, -1)).rejects.toThrow();
    await expect(f.service.listTasks(f.parent.id, 0, 51)).rejects.toThrow();
    await expect(f.service.getTask(f.parent.id, "command", "short-id")).rejects.toThrow();
    await expect(f.service.getTask(f.parent.id, "agent", f.parent.id, 0, 8193)).rejects.toThrow();
    expect(f.cancel).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
