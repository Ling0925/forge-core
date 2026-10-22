import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type { LocalToolRegistry, SessionStore } from "../../src/shared/contracts";
import { defaultPublicSettings, sessionSnapshotSchema, type ToolCall, type ToolResult } from "../../src/shared/schemas";

const call = (id: string, name = "read_file"): ToolCall => ({
  id, type: "function", function: { name, arguments: "{}" },
});
const ok: ToolResult = { content: "ok", isError: false };
function latch() {
  let release = () => {};
  const work = new Promise<void>(resolve => { release = resolve; });
  return { work, release };
}
function fixture(calls: readonly ToolCall[], tools: LocalToolRegistry, maxToolCalls = 20) {
  let snapshot = sessionSnapshotSchema.parse({ version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "Test",
    workspace: "/workspace", model: "fixture", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    status: "idle", messages: [], events: [], changes: [] });
  let locked = false;
  const store: SessionStore = { list: async () => [], get: async () => snapshot, create: async () => snapshot,
    save: async value => { snapshot = sessionSnapshotSchema.parse(value); },
    acquire: async () => { locked = true; return async () => { locked = false; }; } };
  let requested = false;
  const runtime = createAgentRuntime({ store, tools, settings: { ...defaultPublicSettings, maxToolCalls }, provider: {
    listModels: async () => [], complete: async () => {
      if (requested) return { message: { role: "assistant", content: "done" } };
      requested = true;
      return { message: { role: "assistant", content: "", tool_calls: calls } };
    },
  } });
  return { locked: () => locked, run: (signal = new AbortController().signal) => runtime.run(
    { sessionId: snapshot.id, prompt: "work", permission: "unrestricted" }, () => {}, async () => true, signal,
  ) };
}

describe("bounded read-only concurrency", () => {
  it("overlaps four reads, commits in call order and waits at mutation barriers", async () => {
    const started = latch();
    const release = latch();
    const sequence: string[] = [];
    let active = 0;
    let peak = 0;
    const tools: LocalToolRegistry = { definitions: [], dispose: async () => {},
      isConcurrencySafe: item => item.function.name === "read_file",
      execute: async item => {
        sequence.push(item.id);
        active += 1; peak = Math.max(peak, active);
        if (sequence.length === 4) started.release();
        if (["1", "2", "3", "4"].includes(item.id)) await release.work;
        if (item.id === "write") expect(active).toBe(1);
        active -= 1;
        return { ...ok, content: item.id };
      } };
    const work = fixture([call("1"), call("2"), call("3"), call("4"), call("5"), call("write", "write_file"), call("6"), call("7")], tools).run();
    await started.work;
    expect(sequence).toEqual(["1", "2", "3", "4"]);
    release.release();
    const result = await work;
    expect(peak).toBe(4);
    expect(result.status).toBe("completed");
    expect(sequence).toEqual(["1", "2", "3", "4", "5", "write", "6", "7"]);
    expect(result.messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(sequence);
    expect(result.pendingTool).toBeUndefined();
  });

  it("keeps unclassified tools serial even when their names resemble reads", async () => {
    let active = 0;
    let peak = 0;
    const result = await fixture([call("1"), call("2")], { definitions: [], dispose: async () => {},
      execute: async () => { active += 1; peak = Math.max(active, peak); await Promise.resolve(); active -= 1; return ok; },
    }).run();
    expect(result.status).toBe("completed");
    expect(peak).toBe(1);
  });

  it("finishes a read batch beyond the legacy attempt budget", async () => {
    const executed: string[] = [];
    const result = await fixture([call("1"), call("2"), call("3")], {
      definitions: [], dispose: async () => {}, isConcurrencySafe: () => true,
      execute: async item => { executed.push(item.id); return ok; },
    }, 2).run();
    expect(executed).toEqual(["1", "2", "3"]);
    expect(result.status).toBe("completed");
    expect(result.events.findLast(event => event.type === "run_finished")).toMatchObject({ toolCalls: 3 });
    expect(result.messages.filter(message => message.role === "tool")).toHaveLength(3);
  });

  it("joins every started read before cancellation releases the session", async () => {
    const started = latch(); const release = latch();
    const controller = new AbortController();
    let count = 0;
    const run = fixture([call("1"), call("2")], {
      definitions: [], dispose: async () => {}, isConcurrencySafe: () => true,
      execute: async () => { count += 1; if (count === 2) started.release(); await release.work; return ok; },
    });
    const work = run.run(controller.signal);
    await started.work;
    controller.abort();
    expect(run.locked()).toBe(true);
    release.release();
    expect((await work).status).toBe("cancelled");
    expect(run.locked()).toBe(false);
  });

  it("joins siblings when one read throws and never starts a following write", async () => {
    const executed: string[] = [];
    const result = await fixture([call("1"), call("2"), call("write", "write_file")], {
      definitions: [], dispose: async () => {}, isConcurrencySafe: item => item.function.name === "read_file",
      execute: async item => { executed.push(item.id); if (item.id === "1") throw new Error("private diagnostic"); return ok; },
    }).run();
    expect(executed).toEqual(["1", "2"]);
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  });
});
