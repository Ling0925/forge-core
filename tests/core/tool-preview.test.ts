import { expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import { createToolPreviewStream } from "../../src/core/tool-preview";
import type { LocalToolRegistry, ModelProvider, SessionStore } from "../../src/shared/contracts";
import { ProviderError } from "../../src/provider/openai";
import { defaultPublicSettings, sessionSnapshotSchema, type AgentEvent, type ToolCallPreview } from "../../src/shared/schemas";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const call = { id: "call", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } } as const;
function fixture(provider: ModelProvider, execute: LocalToolRegistry["execute"]) {
  let current = sessionSnapshotSchema.parse({
    version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "Test", workspace: "/workspace", model: "chosen",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "idle", messages: [], events: [], changes: [],
  });
  const store: SessionStore = {
    list: async () => [], get: async () => current, create: async () => current,
    save: async snapshot => { current = sessionSnapshotSchema.parse(snapshot); }, acquire: async () => async () => {},
  };
  const runtime = createAgentRuntime({ store, provider, settings: defaultPublicSettings, tools: { definitions: [], execute, dispose: async () => {} } });
  return { runtime, input: { sessionId: current.id, prompt: "go", permission: "unrestricted" as const }, current: () => current };
}

it("publishes metadata before generation ends and start before a slow tool ends, without persisting drafts", async () => {
  const generation = gate(), firstPreview = gate(), execution = gate(), toolStarted = gate();
  const events: AgentEvent[] = [];
  let requests = 0, executed = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (_m, _d, options) => {
    if (requests++ > 0) return { message: { role: "assistant", content: "done" } };
    options.onToolCall?.({ index: 0, name: "read_file", argumentsChars: 7 });
    firstPreview.release();
    await generation.promise;
    return { message: { role: "assistant", content: null, tool_calls: [call] } };
  } };
  const f = fixture(provider, async () => { executed++; await execution.promise; return { content: "ok", isError: false }; });
  const work = f.runtime.run(f.input, event => { events.push(event); if (event.type === "tool_started") toolStarted.release(); }, async () => false, new AbortController().signal);
  try {
    await firstPreview.promise;
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_preview", name: "read_file", argumentsChars: 7, previewId: "1:0:0" }));
    expect(executed).toBe(0);
    expect(events.some(e => e.type === "tool_started")).toBe(false);
    generation.release();
    await toolStarted.promise;
    expect(events.find(e => e.type === "tool_started")).toMatchObject({ call, previewId: "1:0:0" });
    expect(events.some(e => e.type === "tool_finished")).toBe(false);
    execution.release();
    const result = await work;
    expect(result.status).toBe("completed");
    expect(executed).toBe(1);
    expect(events.some(e => e.type === "tool_finished")).toBe(true);
    expect(result.events.some(e => e.type === "tool_call_preview" || e.type === "tool_preview_reset")).toBe(false);
    expect(f.current().events.some(e => e.type === "tool_call_preview")).toBe(false);
  } finally { generation.release(); execution.release(); await work; }
});

it("clears failed attempt drafts and scopes replacement previews without executing failed drafts", async () => {
  const events: AgentEvent[] = [];
  let requests = 0, executed = 0;
  const f = fixture({ listModels: async () => [], complete: async (_m, _d, options) => {
    if (requests === 2) return { message: { role: "assistant", content: "done" } };
    options.onToolCall?.({ index: 0, name: "read_file", argumentsChars: 7 });
    if (requests++ === 0) throw new ProviderError("network", "network failed");
    return { message: { role: "assistant", content: null, tool_calls: [call] } };
  } }, async () => { executed++; return { content: "ok", isError: false }; });
  const result = await f.runtime.run(f.input, e => events.push(e), async () => false, new AbortController().signal);
  expect(result.status).toBe("completed");
  const previews = events.filter(e => e.type === "tool_call_preview");
  expect(previews.map(e => e.previewId)).toEqual(["1:0:0", "1:1:0"]);
  expect(events.findIndex(e => e.type === "retry_reset")).toBeGreaterThan(events.indexOf(previews[0]!));
  expect(events.findIndex(e => e.type === "retry_reset")).toBeLessThan(events.indexOf(previews[1]!));
  expect(executed).toBe(1);
});

it("does not execute or publish late previews after cancellation", async () => {
  const arrived = gate(), generation = gate();
  const controller = new AbortController();
  let late: (() => void) | undefined;
  const events: AgentEvent[] = [];
  const execute = vi.fn(async () => ({ content: "ok", isError: false }));
  const f = fixture({ listModels: async () => [], complete: async (_m, _d, options) => {
    options.onToolCall?.({ index: 0, name: "read_file", argumentsChars: 7 });
    late = () => options.onToolCall?.({ index: 0, name: "read_file", argumentsChars: 99 });
    arrived.release();
    await generation.promise;
    return { message: { role: "assistant", content: null, tool_calls: [call] } };
  } }, execute);
  const work = f.runtime.run(f.input, e => events.push(e), async () => false, controller.signal);
  await arrived.promise;
  controller.abort();
  const result = await work;
  const count = events.length;
  late?.(); generation.release();
  await Promise.resolve();
  expect(result.status).toBe("cancelled");
  expect(events.length).toBe(count);
  expect(execute).not.toHaveBeenCalled();
});

it("coalesces updates, emits the first snapshot immediately, bounds indices and stops its timer", () => {
  vi.useFakeTimers();
  try {
    const updates: { id: string; preview: ToolCallPreview }[] = [];
    const stream = createToolPreviewStream("turn:attempt", (id, preview) => updates.push({ id, preview }));
    stream.push({ index: 0, name: "read_file", argumentsChars: 1 });
    for (let i = 2; i < 100; i++) stream.push({ index: 0, name: "read_file", argumentsChars: i });
    stream.push({ index: 256, name: "read_file", argumentsChars: 100 });
    expect(updates).toHaveLength(1);
    vi.advanceTimersByTime(80);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ id: "turn:attempt:0", preview: { argumentsChars: 99 } });
    stream.push({ index: 0, name: "read_file", argumentsChars: 100 });
    stream.close();
    stream.push({ index: 1, name: "read_file", argumentsChars: 10 });
    vi.runAllTimers();
    expect(updates).toHaveLength(3);
    expect(stream.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
