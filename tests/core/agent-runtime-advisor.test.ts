import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type { AgentRuntimeDependencies, LocalToolRegistry, ModelProvider } from "../../src/shared/contracts";
import { defaultPublicSettings, type AgentEvent, type Message, type SessionSnapshot } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { advisorRequestSchema } from "../../src/shared/agent-coordination";

const call = (id: string, name: string, args: unknown = {}) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const calls = (...tools: ReturnType<typeof call>[]) => ({ message: { role: "assistant" as const, content: null, tool_calls: tools } });
const answer = (content = "done") => ({ message: { role: "assistant" as const, content } });
const result = (messages: readonly Message[]) => JSON.parse(JSON.parse(messages.findLast(message => message.role === "tool")?.content ?? "{}").content ?? "{}");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
const empty: LocalToolRegistry = { definitions: [], execute: async () => ({ content: "ok", isError: false }), dispose: async () => {} };
async function setup(provider: ModelProvider, tools = empty) {
  const base = fileURLToPath(new URL("../../../../.forge/tmp/agent-collaboration/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "runtime-"));
  const store = await openSessionStore(directory);
  const root = await store.create({ workspace: directory, title: "root", model: "parent" });
  const controller = new AbortController();
  const runs: Promise<SessionSnapshot>[] = [];
  const deps: AgentRuntimeDependencies = { store, provider, tools, settings: defaultPublicSettings };
  const events: AgentEvent[] = [];
  const run = (onEvent?: (event: AgentEvent) => void) => {
    const work = createAgentRuntime(deps).run({ sessionId: root.id, prompt: "delegate", permission: "unrestricted" },
      event => { events.push(event); onEvent?.(event); }, async () => false,
      AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]));
    runs.push(work);
    return work;
  };
  cleanups.push(async () => { controller.abort(); await Promise.allSettled(runs); await rm(directory, { recursive: true, force: true }); });
  return { store, root, controller, deps, events, run };
}
function assertClosedExchanges(messages: readonly Message[]) {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") { expect(pending.has(message.tool_call_id)).toBe(true); pending.delete(message.tool_call_id); }
    else {
      expect([...pending]).toEqual([]);
      if (message.role === "assistant") pending = new Set(message.tool_calls?.map(call => call.id) ?? []);
    }
  }
  expect([...pending]).toEqual([]);
}

for (const explicitWait of [true, false]) it(`interrupts ${explicitWait ? "wait_agents" : "final reconciliation"}, persists replies and returns to the same child`, async () => {
  let parentTurn = 0;
  let childTurn = 0;
  let questionId = "";
  let childId = "";
  let replied = false;
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, definitions, options) => {
    assertClosedExchanges(messages);
    if (options.model === "child") {
      expect(definitions.some(tool => tool.function.name === "advisor")).toBe(true);
      expect(definitions.some(tool => tool.function.name === "spawn_agent")).toBe(false);
      if (++childTurn === 1) return calls(call("question", "advisor", { question: "v1 or v2?", recommendation: "v1", timeout_ms: 3000 }));
      expect(result(messages)).toMatchObject({ status: "answered", answer: "Use v1", nextInstruction: "Test both callers" });
      const parent = await f.store.get(f.root.id);
      expect(parent.advisorRequests?.[0]).toMatchObject({ status: "answered", deliveredAt: expect.any(String) });
      return answer("child verified v1");
    }
    parentTurn++;
    expect(definitions.some(tool => tool.function.name === "advisor")).toBe(false);
    if (parentTurn === 1) return calls(call("spawn", "spawn_agent", { task: "inspect endpoint", model: "child" }));
    if (parentTurn === 2) {
      childId = result(messages).childSessionId;
      return explicitWait ? calls(call("wait", "wait_agents", { ids: [childId], timeout_ms: 6000 })) : answer("preliminary");
    }
    if (!replied) {
      const pending = (await f.store.get(f.root.id)).advisorRequests?.find(request => request.status === "pending");
      expect(pending).toBeTruthy();
      questionId = pending!.id;
      if (explicitWait) expect(result(messages)).toMatchObject({ reason: "advisor", pendingCount: 1 });
      else expect(messages.findLast(message => message.role === "user")?.content).toContain("Use answer_advisor");
      replied = true;
      return calls(call("reply", "answer_advisor", { requestId: questionId, answer: "Use v1", nextInstruction: "Test both callers" }));
    }
    return answer("integrated");
  } };
  const f = await setup(provider);
  const completed = await f.run();
  expect(completed.status).toBe("completed");
  expect(childTurn).toBe(2);
  expect(completed.advisorRequests).toHaveLength(1);
  expect(completed.advisorRequests?.[0]).toMatchObject({ id: questionId, childSessionId: childId, status: "answered", deliveredAt: expect.any(String) });
  expect(f.events.filter(event => event.type === "advisor_update").map(event => event.request.status)).toEqual(["pending", "answered", "answered"]);
  assertClosedExchanges(completed.messages);
  assertClosedExchanges((await f.store.get(completed.advisorRequests![0]!.childSessionId as typeof f.root.id)).messages);
}, 15000);

it("rejects the entire mixed advisor/write batch and lets the child correct it without replaying a write", async () => {
  let parentTurns = 0;
  let childTurns = 0;
  let executions = 0;
  let answered = false;
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    assertClosedExchanges(messages);
    if (options.model === "child") {
      childTurns++;
      if (childTurns === 1) return calls(call("unsafe", "write_file", { path: "file", content: "must not write" }), call("mixed", "advisor", { question: "permission?" }));
      if (childTurns === 2) {
        expect(messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content!))).toMatchObject([{ isError: true }, { isError: true }]);
        return calls(call("alone", "advisor", { question: "which test?", timeout_ms: 3000 }));
      }
      expect(result(messages).answer).toBe("Run the focused test");
      return answer();
    }
    if (++parentTurns === 1) return calls(call("spawn", "spawn_agent", { task: "task", model: "child" }));
    const request = (await f.store.get(f.root.id)).advisorRequests?.find(request => request.status === "pending");
    if (request && !answered) { answered = true; return calls(call("reply", "answer_advisor", { requestId: request.id, answer: "Run the focused test" })); }
    return answer();
  } };
  const f = await setup(provider, { ...empty, execute: async () => { executions++; return { content: "unexpected", isError: false }; } });
  const completed = await f.run();
  expect(completed.status).toBe("completed");
  expect(executions).toBe(0);
  expect(completed.advisorRequests).toHaveLength(1);
  expect(childTurns).toBe(3);
}, 15000);

it("cancels a waiting child when the parent aborts and persists cancellation rather than consent", async () => {
  let parentTurns = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (_messages, _tools, options) => {
    if (options.model === "child") return calls(call("ask", "advisor", { question: "blocked", timeout_ms: 6000 }));
    if (++parentTurns === 1) return calls(call("spawn", "spawn_agent", { task: "task", model: "child" }));
    return calls(call("wait", "wait_agents", { timeout_ms: 6000 }));
  } };
  const f = await setup(provider);
  const completed = await f.run(event => { if (event.type === "advisor_update" && event.request.status === "pending") f.controller.abort(); });
  expect(completed.status).toBe("cancelled");
  expect(completed.advisorRequests?.[0]).toMatchObject({ status: "cancelled" });
  const children = (await f.store.list()).filter(session => session.parentSessionId === f.root.id);
  expect(children).toHaveLength(1);
  expect(children[0]?.status).toBe("cancelled");
  assertClosedExchanges(completed.messages);
}, 15000);

it("recovers pending historical requests as interrupted, but never answers or restarts the old child", async () => {
  let turns = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async messages => {
    if (++turns === 1) return calls(call("old-answer", "answer_advisor", { requestId, answer: "not allowed" }));
    expect(result(messages)).toMatchObject({ code: "invalid_input" });
    return answer();
  } };
  const f = await setup(provider);
  const child = await f.store.create({ workspace: f.root.workspace, title: "historical", model: "child" });
  const requestId = randomUUID();
  const request = advisorRequestSchema.parse({ id: requestId, parentSessionId: f.root.id, parentRunId: randomUUID(), childSessionId: child.id,
    toolCallId: "old-ask", question: "old question", status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60000).toISOString() });
  await f.store.save({ ...child, parentSessionId: f.root.id, status: "interrupted" });
  await f.store.save({ ...f.root, status: "running", advisorRequests: [request] });
  const completed = await f.run();
  expect(completed.status).toBe("completed");
  expect(completed.advisorRequests).toMatchObject([{ status: "interrupted" }]);
  expect((await f.store.get(child.id)).status).toBe("interrupted");
  expect(await f.store.list()).toHaveLength(2);
});

it("interrupts a selected-child wait for a different current child's question", async () => {
  let release = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let parentTurns = 0;
  let questionerTurns = 0;
  let silentId = "";
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, _tools, options) => {
    if (options.model === "silent") { await barrier; return answer("silent completed"); }
    if (options.model === "questioner") {
      if (++questionerTurns === 1) return calls(call("ask", "advisor", { question: "Need guidance", timeout_ms: 4000 }));
      expect(result(messages).answer).toBe("Keep the old contract");
      return answer();
    }
    parentTurns++;
    if (parentTurns === 1) return calls(call("spawn-silent", "spawn_agent", { task: "first", model: "silent" }),
      call("spawn-questioner", "spawn_agent", { task: "second", model: "questioner" }));
    if (parentTurns === 2) {
      silentId = (await f.store.list()).find(session => session.model === "silent")!.id;
      return calls(call("selected-wait", "wait_agents", { ids: [silentId], timeout_ms: 6000 }));
    }
    if (parentTurns === 3) {
      const waiting = result(messages);
      expect(waiting.reason).toBe("advisor");
      expect(waiting.waitingIds).toEqual([silentId]);
      expect(waiting.requests[0].childSessionId).not.toBe(silentId);
      return calls(call("reply", "answer_advisor", { requestId: waiting.requests[0].id, answer: "Keep the old contract" }));
    }
    release();
    return answer();
  } };
  const f = await setup(provider);
  try {
    const completed = await f.run();
    expect(completed.status).toBe("completed");
    expect(completed.advisorRequests?.[0]?.deliveredAt).toBeTruthy();
  } finally { release(); }
}, 15000);
