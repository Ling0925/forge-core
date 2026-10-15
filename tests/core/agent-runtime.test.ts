import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type { LocalToolRegistry, ModelProvider } from "../../src/shared/contracts";
import { defaultPublicSettings, type Message } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const calls = (...tools: ReturnType<typeof call>[]) => ({ message: { role: "assistant" as const, content: null, tool_calls: tools } });
const answer = (content: string) => ({ message: { role: "assistant" as const, content } });
const lastResult = (messages: readonly Message[]): any => {
  const message = messages.findLast(m => m.role === "tool");
  return JSON.parse(JSON.parse(message?.content ?? "{}").content ?? "{}");
};
const empty: LocalToolRegistry = { definitions: [], execute: async () => ({ content: "ok", isError: false }), dispose: async () => {} };
async function setup(provider: ModelProvider, tools = empty, childToolFactory?: () => Promise<LocalToolRegistry>) {
  const directory = await mkdtemp(join(tmpdir(), "forge-agent-runtime-"));
  const store = await openSessionStore(directory);
  const root = await store.create({ workspace: directory, title: "root", model: "parent" });
  const runtime = createAgentRuntime({ store, provider, tools, settings: defaultPublicSettings, ...(childToolFactory ? { childToolFactory } : {}) });
  return { store, root, run: () => runtime.run({ sessionId: root.id, prompt: "delegate" }, () => {}, async () => false, new AbortController().signal),
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

it("delivers explicit waits once and permits more than four sequential children", async () => {
  let turns = 0;
  let spawned = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "child") return answer("child result");
    turns++;
    expect(messages.some(m => m.role === "user" && m.origin === "agent_reconciliation")).toBe(false);
    if (turns % 2 === 0) return calls(call(`wait-${turns}`, "wait_agents", { ids: [lastResult(messages).childSessionId] }));
    if (spawned++ < 6) return calls(call(`spawn-${turns}`, "spawn_agent", { task: "inspect", model: "child" }));
    return answer("integrated");
  } };
  const f = await setup(provider);
  try {
    const result = await f.run();
    expect(result.status).toBe("completed");
    expect(turns).toBe(13);
    expect((await f.store.list()).filter(s => s.parentSessionId === f.root.id)).toHaveLength(6);
  } finally { await f.cleanup(); }
});

for (const resolved of [false, true]) it(`${resolved ? "allows resolved" : "preserves unresolved"} failure without rewriting child status`, async () => {
  let turns = 0;
  let childId = "";
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "child") throw Error("private provider payload");
    turns++;
    if (turns === 1) return calls(call("spawn", "spawn_agent", { task: "inspect", model: "child" }));
    if (turns === 2) { childId = lastResult(messages).childSessionId; return calls(call("wait", "wait_agents", { ids: [childId] })); }
    if (turns === 3 && resolved) return calls(call("resolve", "resolve_agent", { id: childId, resolution: "Inspected changes: none; parent independently completed and verified the task." }));
    return answer("parent done");
  } };
  const f = await setup(provider);
  try {
    const result = await f.run();
    expect(result.status).toBe(resolved ? "completed" : "failed");
    const children = (await f.store.list()).filter(s => s.parentSessionId === f.root.id);
    expect(children[0]?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private provider payload");
    expect(result.agentResolutions?.length ?? 0).toBe(resolved ? 1 : 0);
    expect((await f.store.get(f.root.id)).agentResolutions).toEqual(result.agentResolutions);
    expect(result.messages.some(m => m.role === "user" && m.origin === "agent_reconciliation")).toBe(false);
  } finally { await f.cleanup(); }
});

it("automatic reconciliation delivers only new results and supports explicit resolution", async () => {
  let turns = 0;
  let childId = "";
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "child") throw Error("offline");
    turns++;
    if (turns === 1) return calls(call("spawn", "spawn_agent", { task: "check", model: "child" }));
    if (turns === 2) { childId = lastResult(messages).childSessionId; return answer("preliminary"); }
    if (turns === 3) {
      expect(messages.at(-1)).toMatchObject({ origin: "agent_reconciliation" });
      expect(messages.at(-1)?.content).toContain(childId);
      return calls(call("resolve", "resolve_agent", { id: childId, resolution: "Optional check abandoned after inspecting effects; parent verification passed." }));
    }
    return answer("integrated");
  } };
  const f = await setup(provider);
  try {
    const result = await f.run();
    expect(result.status).toBe("completed");
    expect(result.messages.filter(m => m.role === "user" && m.origin === "agent_reconciliation")).toHaveLength(1);
  } finally { await f.cleanup(); }
});

it("delivers bounded guidance at the child's next model boundary without sharing parent steering", async () => {
  let releaseChild = () => {};
  const barrier = new Promise<void>(resolve => { releaseChild = resolve; });
  let parentTurns = 0;
  let childTurns = 0;
  let childId = "";
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "child") {
      if (++childTurns === 1) { await barrier; return answer("initial"); }
      expect(messages.some(m => m.role === "user" && m.content === "Inspect the edge case too; do not change permissions.")).toBe(true);
      expect(messages[0]?.content).toContain('Declared write paths (coordination only, not sandbox permissions): ["src/child.ts"]');
      return answer("follow-up inspected");
    }
    if (++parentTurns === 1) return calls(call("spawn", "spawn_agent", { task: "independent", model: "child", writePaths: ["src/child.ts"] }));
    if (parentTurns === 2) { childId = lastResult(messages).childSessionId; return calls(call("send", "send_agent_message", { id: childId, message: "Inspect the edge case too; do not change permissions." })); }
    if (parentTurns === 3) { expect(lastResult(messages).queued).toBe(true); releaseChild(); return calls(call("wait", "wait_agents", { ids: [childId] })); }
    return answer("integrated");
  } };
  const f = await setup(provider);
  try { expect((await f.run()).status).toBe("completed"); expect(childTurns).toBe(2); }
  finally { releaseChild(); await f.cleanup(); }
});

it("enforces a lowered child tool budget and preserves safe native error categories", async () => {
  let parentTurns = 0;
  let childTurns = 0;
  let executions = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "child") return calls(call(`read-${++childTurns}`, "read_file", { path: "a.ts" }));
    parentTurns++;
    if (parentTurns === 1) return calls(call("invalid", "spawn_agent", { task: "bad", maxToolCalls: 1000 }));
    if (parentTurns === 2) { expect(lastResult(messages).code).toBe("invalid_input"); return calls(call("spawn", "spawn_agent", { task: "bounded", model: "child", maxToolCalls: 1 })); }
    return answer("parent done");
  } };
  const f = await setup(provider, { ...empty, execute: async () => { executions++; return { content: "read", isError: false }; } });
  try {
    const result = await f.run();
    expect(result.status).toBe("failed");
    expect(executions).toBe(1);
    expect(JSON.stringify(result)).toContain("Tool attempt budget exhausted");
  } finally { await f.cleanup(); }
});

for (const reported of [false, true]) it(`aggregates child usage with honest completeness (reported=${reported})`, async () => {
  let turns = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "child") return { ...answer("child"), ...(reported ? { usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6, cachedPromptTokens: 1 } } : {}) };
    const response = ++turns === 1 ? calls(call("spawn", "spawn_agent", { task: "work", model: "child" }))
      : turns === 2 ? calls(call("wait", "wait_agents", { ids: [lastResult(messages).childSessionId] })) : answer("done");
    return { ...response, usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } };
  } };
  const f = await setup(provider);
  try {
    const result = await f.run();
    expect(result.events.at(-1)).toMatchObject({ type: "run_finished", usageComplete: true,
      usage: { totalTokens: 33 }, childUsage: { totalTokens: reported ? 6 : 0 },
      totalUsage: { totalTokens: reported ? 39 : 33 }, childUsageComplete: reported });
  } finally { await f.cleanup(); }
});

it("joins cleanup failures, reports them independently and allows evidence-backed resolution", async () => {
  let turns = 0;
  let childId = "";
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "child") return answer("work done");
    turns++;
    if (turns === 1) return calls(call("spawn", "spawn_agent", { task: "work", model: "child" }));
    if (turns === 2) { childId = lastResult(messages).childSessionId; return calls(call("wait", "wait_agents", { ids: [childId] })); }
    if (turns === 3) {
      expect(lastResult(messages)[0]).toMatchObject({ status: "failed", active: false });
      expect(lastResult(messages)[0].error).toContain("cleanup");
      return calls(call("resolve", "resolve_agent", { id: childId, resolution: "Inspected tool cleanup failure; no live resources or uncertain effects remain." }));
    }
    return answer("done");
  } };
  const f = await setup(provider, empty, async () => ({ ...empty, dispose: async () => { throw Error("PRIVATE cleanup details"); } }));
  try {
    const result = await f.run();
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    const updates = result.events.filter(event => event.type === "agent_update");
    expect(updates.some(event => event.status === "completed")).toBe(false);
    expect(updates.at(-1)?.status).toBe("failed");
    expect((await f.store.list()).find(child => child.id === childId)?.status).toBe("failed");
  } finally { await f.cleanup(); }
});
