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

it("passes live write and edit line estimates through the preview event", async () => {
  const arrived = gate(), generation = gate();
  const events: AgentEvent[] = [];
  let requests = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (_m, _d, options) => {
    if (requests++ > 0) return { message: { role: "assistant", content: "done" } };
    options.onToolCall?.({ index: 0, name: "edit_file", argumentsChars: 30, linesAdded: 1, linesRemoved: 2 });
    arrived.release();
    await generation.promise;
    return { message: { role: "assistant", content: null, tool_calls: [call] } };
  } };
  const f = fixture(provider, async () => ({ content: "ok", isError: false }));
  const work = f.runtime.run(f.input, event => events.push(event), async () => false, new AbortController().signal);
  try {
    await arrived.promise;
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call_preview",
      previewId: "1:0:0",
      name: "edit_file",
      argumentsChars: 30,
      linesAdded: 1,
      linesRemoved: 2,
    }));
    generation.release();
    const result = await work;
    expect(result.status).toBe("completed");
    // Still ephemeral: estimates never enter the stored transcript.
    expect(result.events.some(e => e.type === "tool_call_preview")).toBe(false);
    expect(f.current().events.some(e => e.type === "tool_call_preview")).toBe(false);
  } finally { generation.release(); await work; }
});

it("omits line estimates from preview events for tools that cannot be estimated", async () => {
  const arrived = gate(), generation = gate();
  const events: AgentEvent[] = [];
  let requests = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (_m, _d, options) => {
    if (requests++ > 0) return { message: { role: "assistant", content: "done" } };
    options.onToolCall?.({ index: 0, name: "read_file", argumentsChars: 7 });
    arrived.release();
    await generation.promise;
    return { message: { role: "assistant", content: null, tool_calls: [call] } };
  } };
  const f = fixture(provider, async () => ({ content: "ok", isError: false }));
  const work = f.runtime.run(f.input, event => events.push(event), async () => false, new AbortController().signal);
  try {
    await arrived.promise;
    const preview = events.find(e => e.type === "tool_call_preview");
    expect(preview).toMatchObject({ name: "read_file", argumentsChars: 7 });
    expect(preview && "linesAdded" in preview).toBe(false);
    expect(preview && "linesRemoved" in preview).toBe(false);
    generation.release();
    await work;
  } finally { generation.release(); await work; }
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

it("treats a line-estimate change as a real update and repeats as no-ops", () => {
  vi.useFakeTimers();
  try {
    const updates: { id: string; preview: ToolCallPreview }[] = [];
    const stream = createToolPreviewStream("t:a", (id, preview) => updates.push({ id, preview }));
    stream.push({ index: 0, name: "write_file", argumentsChars: 20, linesAdded: 1 });
    expect(updates).toHaveLength(1);
    // Same counters and estimate: nothing new to show.
    stream.push({ index: 0, name: "write_file", argumentsChars: 20, linesAdded: 1 });
    expect(updates).toHaveLength(1);
    vi.advanceTimersByTime(80);
    expect(updates).toHaveLength(1);
    // Only the estimated size advanced, so the coalesced update must still fire.
    stream.push({ index: 0, name: "write_file", argumentsChars: 20, linesAdded: 2 });
    vi.advanceTimersByTime(80);
    expect(updates).toHaveLength(2);
    expect(updates[1]?.preview).toEqual({
      index: 0,
      name: "write_file",
      argumentsChars: 20,
      linesAdded: 2,
    });
    // Removal-only and mixed edits are likewise differentiated.
    stream.push({ index: 1, name: "edit_file", argumentsChars: 30, linesRemoved: 1 });
    stream.push({ index: 1, name: "edit_file", argumentsChars: 30, linesAdded: 1, linesRemoved: 1 });
    stream.close();
    expect(updates).toHaveLength(4);
    expect(updates[3]?.preview).toEqual({
      index: 1,
      name: "edit_file",
      argumentsChars: 30,
      linesAdded: 1,
      linesRemoved: 1,
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("drops a snapshot whose line estimate fails schema bounds", () => {
  vi.useFakeTimers();
  try {
    const updates: { id: string; preview: ToolCallPreview }[] = [];
    const stream = createToolPreviewStream("t:a", (id, preview) => updates.push({ id, preview }));
    stream.push({ index: 0, name: "write_file", argumentsChars: 5, linesAdded: 1_000_001 });
    stream.push({ index: 0, name: "write_file", argumentsChars: 5, linesRemoved: -1 });
    stream.push({ index: 0, name: "write_file", argumentsChars: 5, linesAdded: 1.5 });
    stream.close();
    expect(updates).toEqual([]);
  } finally { vi.useRealTimers(); }
});
