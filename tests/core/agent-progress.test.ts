import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentProgress, AGENT_PROGRESS_LIMIT } from "../../src/core/agent-progress";
import { createAgentRuntime } from "../../src/core/runtime";
import type { ModelProvider } from "../../src/shared/contracts";
import { agentEventSchema, defaultPublicSettings, sessionIdSchema, type AgentEvent } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";

const id = sessionIdSchema.parse("11111111-1111-4111-8111-111111111111");
const other = sessionIdSchema.parse("22222222-2222-4222-8222-222222222222");
const base = { sessionId: id, timestamp: "2026-01-01T00:00:00.000Z", turn: 1, step: 1 };

it("keeps bounded cumulative visible drafts per child and resets only at generation boundaries", () => {
  const events: unknown[] = [];
  const push = createAgentProgress(id, event => events.push(event));
  push({ ...base, type: "text_delta", text: "第一" });
  push({ ...base, type: "text_delta", text: "条回复" });
  expect(events.at(-1)).toMatchObject({ text: "第一条回复", childTurn: 1, childStep: 1 });
  const count = events.length;
  push({ ...base, type: "reasoning_delta", text: "not visible" });
  push({ ...base, type: "text_delta", sessionId: other, text: "wrong child" });
  push({ ...base, type: "tool_started", call: { id: "tool", type: "function", function: { name: "write_file", arguments: "private body" } } });
  expect(events).toHaveLength(count);
  push({ ...base, type: "retry_reset" });
  expect(events.at(-1)).toMatchObject({ text: "", truncated: false });
  push({ ...base, type: "text_delta", text: "x".repeat(AGENT_PROGRESS_LIMIT + 3) });
  expect(events.at(-1)).toMatchObject({ text: "x".repeat(AGENT_PROGRESS_LIMIT), truncated: true });
  const boundedCount = events.length;
  push({ ...base, type: "text_delta", text: "ignored beyond limit" });
  expect(events).toHaveLength(boundedCount);
  push({ ...base, type: "step_started", step: 2, messageIndex: 3 });
  push({ ...base, step: 2, type: "text_delta", text: "新的回复" });
  expect(events.at(-1)).toMatchObject({ text: "新的回复", truncated: false, childStep: 2 });
  for (const event of events) expect(agentEventSchema.safeParse({ ...base, ...(event as object) }).success).toBe(true);
});

it("streams child replies through the real runtime before completion without persisting them on the parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-agent-progress-"));
  const events: AgentEvent[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const answer = (content: string) => ({ message: { role: "assistant" as const, content } });
  let parentTurns = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (_messages, _tools, options) => {
      if (options.model === "child") {
        options.onReasoning?.("private reasoning preview");
        options.onText("正在检查子任务");
        await barrier;
        options.onText("，已完成。");
        return answer("正在检查子任务，已完成。");
      }
      if (++parentTurns === 1) return { message: { role: "assistant", content: null, tool_calls: [{
        id: "spawn", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ task: "inspect", model: "child" }) },
      }] } };
      return answer("parent result");
    },
  };
  try {
    const store = await openSessionStore(directory);
    const root = await store.create({ workspace: directory, title: "parent", model: "parent" });
    const runtime = createAgentRuntime({ store, provider, settings: defaultPublicSettings,
      tools: { definitions: [], execute: async () => ({ content: "ok", isError: false }), dispose: async () => {} } });
    const pending = runtime.run({ sessionId: root.id, prompt: "delegate" }, event => {
      events.push(event);
    }, async () => false, new AbortController().signal);
    try {
      await expect.poll(() => events.some(event => event.type === "agent_progress" && event.text)).toBe(true);
      const progress = events.filter(event => event.type === "agent_progress");
      expect(progress.at(-1)).toMatchObject({ sessionId: root.id, text: "正在检查子任务", childTurn: 1, childStep: 1 });
      expect(events.some(event => event.type === "run_finished")).toBe(false);
      expect(JSON.stringify(progress)).not.toContain("private reasoning");
      release();
      const result = await pending;
      expect(result.status).toBe("completed");
      expect(result.events.some(event => event.type === "agent_progress")).toBe(false);
      expect((await store.get(root.id)).events.some(event => event.type === "agent_progress")).toBe(false);
      const child = (await store.list()).find(session => session.parentSessionId === root.id)!;
      expect((await store.get(child.id)).messages.at(-1)).toMatchObject({ role: "assistant", content: "正在检查子任务，已完成。" });
    } finally { release(); await pending; }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
