import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { executeHistory, historyText } from "../../src/core/history";
import { summarizeWorkingState } from "../../src/core/working-memory";
import type { ModelProvider } from "../../src/shared/contracts";
import { sessionSnapshotSchema, type Message } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";

const state = { goal: "continue work", constraints: [], decisions: [], completed: [], nextSteps: [{ text: "Find original evidence", refs: ["m1"] }], verification: [], uncertainties: [] };
const base = sessionSnapshotSchema.parse({ version: 1, id: "11111111-1111-4111-8111-111111111111", title: "test", model: "fixture", workspace: "/tmp", status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages: [{ role: "user", content: "preserve files" }], events: [], changes: [] });

it("pages complete original records and bounds literal search results", () => {
  const snapshot = { ...base, messages: [{ role: "user" as const, content: "needle".repeat(5000) }] };
  const result = JSON.parse(executeHistory("history_search", { query: "NEEDLE" }, snapshot).content);
  expect(result.hits[0].id).toBe("m1");
  expect(result.hits[0].excerpt.length).toBeLessThanOrEqual(400);
  let offset: number | null = 0;
  let full = "";
  while (offset !== null) {
    const page = JSON.parse(executeHistory("history_read", { id: "m1", offset, limit: 1000 }, snapshot).content);
    full += page.text;
    offset = page.nextOffset;
  }
  const original = snapshot.messages[0];
  if (!original) throw new Error("Missing fixture record");
  expect(full).toBe(historyText(original));
  expect(executeHistory("history_read", { id: "../../settings" }, snapshot).isError).toBe(true);
  expect(executeHistory("history_search", { query: "needle", sessionId: base.id }, snapshot).isError).toBe(true);
});

it("uses one bounded summary call, preserves records and incrementally carries prior state", async () => {
  const complete = vi.fn<ModelProvider["complete"]>(async messages => {
    expect(JSON.stringify(messages).length).toBeLessThan(40000);
    return { message: { role: "assistant", content: JSON.stringify(state) } };
  });
  const provider = { complete, listModels: async () => [] };
  const snapshot = { ...base, messages: Array.from({ length: 60 }, () => ({ role: "user" as const, content: "large record".repeat(1000) })) };
  const compacted = await summarizeWorkingState(snapshot, provider, new AbortController().signal, 60);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(compacted.messages).toBe(snapshot.messages);
  expect(compacted.contextSummary?.fallback).toBe(false);
  expect(compacted.contextSummary?.content).toContain("m1..m60");
  await summarizeWorkingState({ ...compacted, messages: [...compacted.messages, { role: "user", content: "new instruction" }] }, provider, new AbortController().signal, 61);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]?.[0][1]?.content).toContain("new instruction");
  expect(complete.mock.calls[1]?.[0][1]?.content).not.toContain("large record");
});

it("keeps an explicit recoverable fallback on invalid output and aborts an uncooperative provider", async () => {
  const provider: ModelProvider = { listModels: async () => [], complete: async () => ({ message: { role: "assistant", content: "invalid JSON" } }) };
  const fallback = await summarizeWorkingState(base, provider, new AbortController().signal, 1);
  expect(fallback.contextSummary?.fallback).toBe(true);
  expect(fallback.contextSummary?.content).toContain("history_read");
  expect(fallback.messages).toBe(base.messages);
  const controller = new AbortController();
  const work = summarizeWorkingState(base, { ...provider, complete: () => new Promise(() => {}) }, controller.signal, 1);
  controller.abort();
  await expect(work).rejects.toMatchObject({ code: "cancelled" });
});

it("times out once and preserves a recoverable fallback without retrying", async () => {
  vi.useFakeTimers();
  try {
    const complete = vi.fn<ModelProvider["complete"]>(() => new Promise(() => {}));
    const work = summarizeWorkingState(base, { listModels: async () => [], complete }, new AbortController().signal, 1);
    await vi.advanceTimersByTimeAsync(20000);
    expect((await work).contextSummary?.fallback).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[2].signal.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("recovers compacted evidence through native tools after reopening the persisted session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-memory-test-"));
  let turn = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages, definitions) => {
      if (!definitions.length) return { message: { role: "assistant", content: JSON.stringify(state) } };
      expect(definitions.some(tool => tool.function.name === "history_read")).toBe(true);
      const call = (name: string, args: object) => ({ message: { role: "assistant" as const, content: null, tool_calls: [{ id: `history-${turn}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] } });
      turn++;
      if (turn === 1) {
        expect(messages.some(message => message.role === "user" && message.content === "archived-only-needle")).toBe(false);
        return call("history_search", { query: "archived-only-needle" });
      }
      if (turn === 2) {
        const envelope = JSON.parse(messages.at(-1)?.content ?? "{}");
        const result = JSON.parse(envelope.content);
        expect(result.hits.some((hit: { id: string }) => hit.id === "m1")).toBe(true);
        return call("history_read", { id: "m1" });
      }
      expect(messages.at(-1)?.content).toContain("archived-only-needle");
      return { message: { role: "assistant", content: "Recovered original evidence" } };
    },
  };
  const options = { stateDir: join(directory, "state"), providerFactory: () => provider };
  let service = await createHarness(options);
  try {
    await service.updateSettings({ settings: { baseUrl: "http://localhost:1234/v1", model: "fixture" } });
    const session = await service.createSession({ workspace: directory });
    const store = await openSessionStore(options.stateDir);
    const messages: Message[] = [{ role: "user", content: "archived-only-needle" }, { role: "assistant", content: "old response" }];
    await store.save({ ...session, messages });
    const compacted = await service.compactSession(session.id);
    expect(compacted.contextSummary?.fallback).toBe(false);
    await service.dispose();
    service = await createHarness(options);
    const result = await service.run({ sessionId: session.id, prompt: "Retrieve original evidence", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
    expect(result.status, JSON.stringify(result.events.filter(event => event.type === "error"))).toBe("completed");
    expect(result.messages.slice(0, 2).filter(message => message.role !== "system").length).toBeGreaterThan(0);
    expect(result.messages.some(message => message.content === "archived-only-needle")).toBe(true);
    expect(result.messages.at(-1)?.content).toBe("Recovered original evidence");
    expect(turn).toBe(3);
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
