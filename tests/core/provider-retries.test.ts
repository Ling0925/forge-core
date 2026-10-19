import { afterEach, expect, it, vi } from "vitest";
import { createAgentRuntime, RETRY_DELAYS_MS } from "../../src/core/runtime";
import { ProviderError } from "../../src/provider/openai";
import { ForgeError } from "../../src/shared/errors";
import type { LocalToolRegistry, ModelProvider, SessionStore } from "../../src/shared/contracts";
import { defaultPublicSettings, sessionSnapshotSchema } from "../../src/shared/schemas";
import type { AgentEvent, Message } from "../../src/shared/schemas";

afterEach(() => { vi.useRealTimers(); });

it("stops a model retry loop after three identical tool failures", async () => {
  let calls = 0;
  let executions = 0;
  const f = fixture(async () => ({ message: { role: "assistant", content: null,
    tool_calls: [{ id: `failed-${++calls}`, type: "function", function: { name: "edit_file", arguments: '{"path":"a","old_text":"x","new_text":"y"}' } }] } }),
    async () => { executions++; return { content: '{"error":"old_text was not found."}', isError: true }; });
  await f.run();
  expect(calls).toBe(3);
  expect(executions).toBe(3);
  expect(f.snapshot().status).toBe("failed");
  expect(f.snapshot().messages.filter(message => message.role === "tool")).toHaveLength(3);
  expect(f.events.findLast(event => event.type === "error")).toMatchObject({ error: { code: "tool", retryable: false } });
});

function fixture(complete: ModelProvider["complete"], execute?: LocalToolRegistry["execute"]) {
  let snapshot = sessionSnapshotSchema.parse({ version: 1, id: "11111111-1111-4111-8111-111111111111",
    title: "Retry fixture", workspace: "/tmp", model: "same-model", status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messages: [], events: [], changes: [] });
  const store: SessionStore = { list: async () => [], get: async () => snapshot, create: async () => snapshot,
    save: async value => { snapshot = sessionSnapshotSchema.parse(value); }, acquire: async () => async () => {} };
  const tools: LocalToolRegistry = { definitions: [], execute: execute ?? (async () => ({ content: "ok", isError: false })), dispose: async () => {} };
  const runtime = createAgentRuntime({ store, tools, provider: { listModels: async () => [], complete }, settings: defaultPublicSettings });
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  return { events, controller, snapshot: () => snapshot,
    run: (observe?: (event: AgentEvent) => void) => runtime.run({ sessionId: snapshot.id, prompt: "do work" }, event => { events.push(event); observe?.(event); }, async () => false, controller.signal) };
}

it("allows exactly five additional attempts, discards failed drafts and keeps the same request", async () => {
  vi.useFakeTimers();
  let calls = 0;
  let stale: ((text: string) => void) | undefined;
  const requests: (readonly Message[])[] = [];
  const starts: number[] = [];
  const f = fixture(async (messages, _tools, options) => {
    expect(options.model).toBe("same-model"); requests.push(messages); starts.push(Date.now()); calls++;
    if (calls <= 5) {
      stale = options.onText;
      options.onText("discarded draft"); options.onReasoning?.("discarded reasoning");
      throw new ProviderError("protocol", "Incomplete fixture response");
    }
    options.onText("accepted");
    return { message: { role: "assistant", content: "accepted" }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const running = f.run(); await vi.runAllTimersAsync(); await running;
  expect(calls).toBe(6);
  expect(starts.slice(1).map((value, i) => value - (starts[i] ?? value))).toEqual(RETRY_DELAYS_MS);
  expect(requests.every(messages => messages === requests[0])).toBe(true);
  expect(f.snapshot().status).toBe("completed");
  expect(f.snapshot().messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["accepted"]);
  expect(f.events.filter(event => event.type === "provider_retry").map(event => event.attempt)).toEqual([1, 2, 3, 4, 5]);
  expect(f.events.filter(event => event.type === "retry_reset")).toHaveLength(5);
  expect(f.snapshot().events.some(event => event.type === "retry_reset" || event.type === "provider_retry")).toBe(false);
  expect(f.events.findLast(event => event.type === "run_finished")).toMatchObject({ turns: 1, toolCalls: 0, usageComplete: false });
  const before = f.events.length; stale?.("late abandoned output");
  expect(f.events).toHaveLength(before);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops after six failed requests rather than retrying an entire task", async () => {
  vi.useFakeTimers(); let calls = 0;
  const f = fixture(async () => { calls++; throw new ProviderError("network", "Connection failed", true); });
  const running = f.run(); await vi.runAllTimersAsync(); await running;
  expect(calls).toBe(6); expect(f.snapshot().status).toBe("failed");
  expect(f.events.filter(event => event.type === "provider_retry")).toHaveLength(5);
  expect(f.events.findLast(event => event.type === "run_finished")).toMatchObject({ turns: 1, toolCalls: 0 });
});

it.each([408, 429, 500, 503])("retries transient HTTP %i", async status => {
  vi.useFakeTimers(); let calls = 0;
  const f = fixture(async () => { if (++calls === 1) throw new ProviderError("http", "Unavailable", true, status);
    return { message: { role: "assistant", content: "ok" } }; });
  const running = f.run(); await vi.runAllTimersAsync(); await running;
  expect(calls).toBe(2); expect(f.snapshot().status).toBe("completed");
});

it.each([
  new ProviderError("http", "Rejected", false, 401),
  new ProviderError("http", "Rejected", false, 403),
  new ProviderError("http", "Rejected", false, 400),
  new ProviderError("http", "Missing", false, 404),
  new ProviderError("observer", "Observer failed"),
  new ProviderError("aborted", "Cancelled"),
  new ProviderError("protocol", "Too large", false, undefined, "output_limit"),
  new ProviderError("protocol", "Truncated", false, undefined, "output_truncated"),
  new ProviderError("protocol", "Bad arguments", false, undefined, "invalid_tool_call"),
  new ProviderError("protocol", "Bad chunk", false, undefined, "invalid_chunk"),
  new ForgeError("storage", "Store failed"),
  new ForgeError("tool", "Tool failed"),
  new ForgeError("invalid_input", "Invalid input"),
  new ForgeError("budget", "Budget exhausted"),
])("does not retry non-transient failure %#", async error => {
  vi.useFakeTimers(); let calls = 0;
  const f = fixture(async () => { calls++; throw error; });
  const running = f.run(); await vi.runAllTimersAsync(); await running;
  expect(calls).toBe(1); expect(f.events.some(event => event.type === "provider_retry")).toBe(false);
});

it("cancels during backoff without constructing another provider request", async () => {
  vi.useFakeTimers(); let calls = 0;
  const f = fixture(async () => { calls++; throw new ProviderError("timeout", "Idle timeout", true); });
  const running = f.run(event => { if (event.type === "provider_retry") setTimeout(() => f.controller.abort(), 100); });
  await vi.runAllTimersAsync(); await running;
  expect(calls).toBe(1); expect(f.snapshot().status).toBe("cancelled"); expect(vi.getTimerCount()).toBe(0);
});

it("keeps completed tool evidence and executes each tool once across later generation retries", async () => {
  vi.useFakeTimers(); let calls = 0; let effects = 0;
  const f = fixture(async messages => {
    if (++calls === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "effect", type: "function", function: { name: "inspect", arguments: "{}" } }] } };
    expect(messages.filter(message => message.role === "tool")).toHaveLength(1);
    if (calls === 2) throw new ProviderError("network", "Connection failed", true);
    return { message: { role: "assistant", content: "done" } };
  }, async () => { effects++; return { content: "one effect", isError: false }; });
  const running = f.run(); await vi.runAllTimersAsync(); await running;
  expect(calls).toBe(3); expect(effects).toBe(1); expect(f.snapshot().status).toBe("completed");
  expect(f.snapshot().messages.filter(message => message.role === "tool")).toHaveLength(1);
  expect(f.events.findLast(event => event.type === "run_finished")).toMatchObject({ turns: 2, toolCalls: 1 });
});
