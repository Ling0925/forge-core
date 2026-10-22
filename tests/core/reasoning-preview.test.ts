import { afterEach, expect, it, vi } from "vitest";
import { protocol } from "../../src/provider/errors";
afterEach(() => vi.useRealTimers());
import { createAgentRuntime } from "../../src/core/runtime";
import type {
  LocalToolRegistry,
  ModelProvider,
  SessionStore,
} from "../../src/shared/contracts";
import {
  defaultPublicSettings,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import type { AgentEvent, SessionSnapshot } from "../../src/shared/schemas";

const initial = (): SessionSnapshot =>
  sessionSnapshotSchema.parse({
    version: 1,
    id: "12345678-1234-4234-8234-123456789abc",
    title: "Test",
    workspace: "/workspace",
    model: "chosen",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "idle",
    messages: [],
    events: [],
    changes: [],
  });

const emptyTools: LocalToolRegistry = {
  definitions: [],
  execute: async () => ({ content: "ok", isError: false }),
  dispose: async () => undefined,
};

it("forwards live reasoning events and persists reasoning on the saved assistant message", async () => {
  let current = initial();
  const store: SessionStore = {
    list: async () => [],
    get: async () => current,
    create: async () => current,
    save: async (snapshot) => {
      current = sessionSnapshotSchema.parse(snapshot);
    },
    acquire: async () => async () => {},
  };
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (_messages, _definitions, options) => {
      options.onReasoning?.("thinking hard ");
      options.onReasoning?.("about the answer");
      options.onText("answer");
      return {
        message: { role: "assistant", content: "answer", reasoning: "thinking hard about the answer" },
      };
    },
  };
  const runtime = createAgentRuntime({
    store,
    provider,
    tools: emptyTools,
    settings: defaultPublicSettings,
  });
  const events: AgentEvent[] = [];
  const result = await runtime.run(
    { sessionId: initial().id, prompt: "go" },
    (event) => events.push(event),
    async () => false,
    new AbortController().signal,
  );
  const reasoning = events.filter((event) => event.type === "reasoning_delta");
  expect(reasoning.length).toBeGreaterThan(0);
  expect(reasoning.map((event) => event.text).join("")).toContain("thinking hard");
  // Live reasoning is a transient event, not durable event-log state.
  expect(result.events.some((event) => event.type === "reasoning_delta")).toBe(false);
  expect(current.events.some((event) => event.type === "reasoning_delta")).toBe(false);
  // The reasoning is persisted on the saved assistant message for a resumed view.
  const assistant = result.messages.find((message) => message.role === "assistant");
  expect(assistant?.role === "assistant" && assistant.reasoning).toBe("thinking hard about the answer");
  // The durable store snapshot carries it too, so a fresh load sees it.
  const stored = current.messages.find((message) => message.role === "assistant");
  expect(stored?.role === "assistant" && stored.reasoning).toBe("thinking hard about the answer");
  expect(assistant?.content).toBe("answer");
  // It is display-only metadata, never folded into the assistant content.
  expect(result.messages.some((message) => message.content?.includes("thinking hard"))).toBe(false);
});

function recordingRuntime(complete: ModelProvider["complete"], beforeSave?: (snapshot: SessionSnapshot) => void) {
  let current = initial();
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const store: SessionStore = {
    list: async () => [], get: async () => current, create: async () => current,
    save: async snapshot => { beforeSave?.(snapshot); current = sessionSnapshotSchema.parse(snapshot); },
    acquire: async () => async () => {},
  };
  const runtime = createAgentRuntime({ store, provider: { listModels: async () => [], complete }, tools: emptyTools, settings: defaultPublicSettings });
  return { events, controller, run: () => runtime.run({ sessionId: current.id, prompt: "go" }, event => events.push(event), async () => true, controller.signal) };
}

it("flushes small reasoning before text/tool previews and binds every tool occurrence to the saved generation", async () => {
  vi.useFakeTimers();
  let requests = 0;
  const calls = ["first", "second"].map(id => ({ id, type: "function" as const, function: { name: "read_file", arguments: "{}" } }));
  const f = recordingRuntime(async (messages, _tools, options) => {
    if (++requests > 1) {
      expect(JSON.stringify(messages)).not.toContain("generationId");
      expect(JSON.stringify(messages)).not.toContain("short thought");
      return { message: { role: "assistant", content: "done" } };
    }
    options.onReasoning?.("short thought");
    options.onText("");
    expect(f.events.some(event => event.type === "reasoning_delta")).toBe(false);
    options.onText("body");
    options.onToolCall?.({ index: 0, name: "read_file", argumentsChars: 2 });
    return { message: { role: "assistant", content: "body", reasoning: "short thought", tool_calls: calls } };
  });
  const result = await f.run();
  const previews = f.events.filter(event => ["reasoning_delta", "text_delta", "tool_call_preview"].includes(event.type));
  expect(previews.map(event => event.type)).toEqual(["reasoning_delta", "text_delta", "tool_call_preview"]);
  const generation = f.events.find(event => event.type === "generation_started")?.generationId;
  expect(previews.every(event => event.generationId === generation)).toBe(true);
  expect(result.messages.find(message => message.role === "assistant")).toMatchObject({ generationId: generation });
  expect(f.events.filter(event => event.type === "tool_started").map(event => [event.generationId, event.callIndex])).toEqual([[generation, 0], [generation, 1]]);
  expect(f.events.filter(event => event.type === "tool_finished").map(event => [event.generationId, event.callIndex])).toEqual([[generation, 0], [generation, 1]]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("ends a failing generation once and drains its buffered tail (synchronous=%s)", async synchronous => {
  vi.useFakeTimers();
  let stale: ((text: string) => void) | undefined;
  const complete: ModelProvider["complete"] = (_messages, _tools, options) => {
    stale = options.onReasoning;
    options.onReasoning?.("failure tail");
    if (synchronous) throw protocol("invalid_chunk");
    return Promise.reject(protocol("invalid_chunk"));
  };
  const f = recordingRuntime(complete);
  const result = await f.run();
  expect(result.status).toBe("failed");
  expect(f.events.filter(event => event.type === "generation_finished")).toEqual([expect.objectContaining({ status: "failed" })]);
  const tail = f.events.findIndex(event => event.type === "reasoning_delta");
  expect(tail).toBeGreaterThan(-1);
  expect(tail).toBeLessThan(f.events.findIndex(event => event.type === "generation_finished"));
  const length = f.events.length;
  stale?.("late");
  await vi.runAllTimersAsync();
  expect(f.events).toHaveLength(length);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not announce saved completion when checkpointing fails", async () => {
  let rejected = false;
  const f = recordingRuntime(async (_messages, _tools, options) => {
    options.onReasoning?.("preview");
    return { message: { role: "assistant", content: "answer", reasoning: "preview" } };
  }, snapshot => {
    if (!rejected && snapshot.messages.some(message => message.role === "assistant")) { rejected = true; throw Error("fixture save failure"); }
  });
  await f.run();
  expect(f.events.filter(event => event.type === "generation_finished")).toEqual([expect.objectContaining({ status: "failed" })]);
  expect(f.events.find(event => event.type === "error")).toMatchObject({ error: { code: "storage" } });
});

it("closes cancellation before accepting any late callbacks", async () => {
  vi.useFakeTimers();
  let stale: ((text: string) => void) | undefined;
  const f = recordingRuntime((_messages, _tools, options) => {
    stale = options.onReasoning;
    options.onReasoning?.("cancelled tail");
    f.controller.abort();
    return new Promise(() => {});
  });
  const result = await f.run();
  expect(result.status).toBe("cancelled");
  expect(f.events.filter(event => event.type === "generation_finished")).toEqual([expect.objectContaining({ status: "cancelled" })]);
  const length = f.events.length;
  stale?.("late");
  await vi.runAllTimersAsync();
  expect(f.events).toHaveLength(length);
  expect(vi.getTimerCount()).toBe(0);
});
