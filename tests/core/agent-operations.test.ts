import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { executeAgentOperation, type AgentEnvironment } from "../../src/core/agent-operations";
import type { RunControl } from "../../src/shared/contracts";
import { defaultPublicSettings, parseSessionId, type SessionSnapshot } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "forge-agent-operations-"));
  const store = await openSessionStore(dir);
  const root = await store.create({ workspace: dir, title: "parent", model: "parent" });
  const controls = new Map<string, RunControl>();
  const jobs = new Map<string, (status: SessionSnapshot["status"], content: string) => Promise<void>>();
  const controller = new AbortController();
  const env: AgentEnvironment = {
    deps: { store, settings: defaultPublicSettings, provider: { listModels: async () => [], complete: async () => { throw Error("unused"); } },
      tools: { definitions: [], execute: async () => ({ content: "", isError: false }), dispose: async () => {} } },
    snapshot: root, input: { sessionId: root.id, prompt: "task" }, permission: "workspace", signal: controller.signal,
    children: new Map(), approveChild: () => async () => false,
    saveResolution: async (id, childUpdatedAt, resolution) => {
      env.snapshot = { ...env.snapshot, agentResolutions: [{ id: parseSessionId(id), childUpdatedAt, resolution }] };
      await store.save(env.snapshot);
    },
    runChild: async (input, _approve, signal, control) => {
      if (control) controls.set(input.sessionId, control);
      return new Promise<SessionSnapshot>(resolve => {
        let finished = false;
        const settle = async (status: SessionSnapshot["status"], content: string) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", abort);
          const snapshot = await store.get(input.sessionId);
          const result: SessionSnapshot = { ...snapshot, status, updatedAt: new Date().toISOString(), messages: [{ role: "assistant", content }] };
          await store.save(result);
          resolve(result);
        };
        const abort = () => { void settle("cancelled", "cancelled"); };
        jobs.set(input.sessionId, settle);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
  cleanups.push(async () => {
    controller.abort();
    await Promise.allSettled([...env.children.values()].map(child => child.work));
    await rm(dir, { recursive: true, force: true });
  });
  const invoke = (name: string, args: Record<string, unknown> = {}) => executeAgentOperation(name, args, env);
  const value = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await invoke(name, args)).content);
  const spawn = async (args: Record<string, unknown> = {}) => (await value("spawn_agent", { task: "task", ...args })).childSessionId as string;
  const settle = async (id: string, status: SessionSnapshot["status"] = "completed", content = "done") => {
    await jobs.get(id)!(status, content);
    await env.children.get(id)!.work;
  };
  return { dir, store, root, env, controls, jobs, controller, invoke, value, spawn, settle };
}

it("enforces four active slots but releases completed slots without deleting historical entries", async () => {
  const f = await fixture();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await f.spawn());
  await expect(f.spawn()).rejects.toMatchObject({ code: "busy" });
  await f.settle(ids[0]!);
  const fifth = await f.spawn();
  expect(f.env.children.size).toBe(5);
  expect([...f.env.children.values()].filter(child => child.active)).toHaveLength(4);
  expect(f.env.children.get(fifth)?.active).toBe(true);
  expect((await f.value("list_agents", { currentRun: true })).total).toBe(5);
});

it("has a separate total limit and denies nested delegation", async () => {
  const f = await fixture();
  for (let i = 0; i < 32; i++) await f.settle(await f.spawn());
  await expect(f.spawn()).rejects.toMatchObject({ code: "budget" });
  f.env.snapshot = { ...f.root, parentSessionId: f.root.id };
  await expect(f.spawn()).rejects.toMatchObject({ code: "invalid_input" });
});

it("normalizes literal scope, catches ancestor conflicts, keeps similar prefixes and releases scope", async () => {
  const f = await fixture();
  const id = await f.spawn({ writePaths: ["./src//feature/", "src/feature"] });
  expect((await f.store.get(parseSessionId(id))).writePaths).toEqual(["src/feature"]);
  for (const path of ["src", "src/feature", "src/feature/a.ts"]) {
    const result = await f.invoke("spawn_agent", { task: "conflict", writePaths: [path] });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ code: "scope_conflict", ids: [id] });
  }
  await f.settle(await f.spawn({ writePaths: ["src/features/a.ts"] }));
  await f.settle(id);
  expect(await f.spawn({ writePaths: ["src"] })).toBeTruthy();
});

it("validates arguments and never creates sessions for invalid paths/budgets", async () => {
  const f = await fixture();
  for (const writePaths of [["../out"], ["/absolute"], ["C:\\out"], ["src/*.ts"], ["a/../b"], ["a\u0000b"]])
    await expect(f.spawn({ writePaths })).rejects.toThrow();
  for (const args of [{ task: " " }, { ownership: 4 }, { model: "" }, { maxToolCalls: 0 }, { maxToolCalls: 101 }, { unknown: true }])
    await expect(f.spawn(args)).rejects.toThrow();
  expect(await f.store.list()).toHaveLength(1);
  for (const args of [{ ids: ["bad"] }, { timeout_ms: -1 }, { timeout_ms: 1800001 }, { mode: "invalid" }, { unknown: true }])
    await expect(f.invoke("wait_agents", args)).rejects.toThrow();
});

it("polls and times out without cancelling or marking active results delivered", async () => {
  const f = await fixture();
  const id = await f.spawn();
  for (const timeout_ms of [0, 5]) {
    expect(await f.value("wait_agents", { ids: [id], timeout_ms })).toMatchObject([{ id, active: true }]);
    expect(f.env.children.get(id)?.controller.signal.aborted).toBe(false);
    expect(f.env.children.get(id)?.delivered).toBe(false);
  }
  await f.settle(id);
  expect(await f.value("wait_agents", { ids: [id], timeout_ms: 0 })).toMatchObject([{ status: "completed", active: false }]);
  expect(f.env.children.get(id)?.delivered).toBe(true);
});

it("wait-any returns after one completion; wait-all retains other pending tasks until settlement", async () => {
  const f = await fixture();
  const a = await f.spawn(); const b = await f.spawn();
  const waiting = f.value("wait_agents", { ids: [a, b], mode: "any", timeout_ms: 1000 });
  await f.settle(a);
  expect(await waiting).toMatchObject([{ id: a, active: false }, { id: b, active: true }]);
  let done = false;
  const all = f.value("wait_agents", { ids: [a, b], mode: "all", timeout_ms: 1000 }).then(result => { done = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(done).toBe(false);
  await f.settle(b);
  expect((await all).every((item: { active: boolean }) => !item.active)).toBe(true);
});

it("cancels waits promptly on parent abort and joins owned cancellation", async () => {
  const f = await fixture();
  const id = await f.spawn();
  const wait = f.invoke("wait_agents", { ids: [id], timeout_ms: 120000 });
  f.controller.abort();
  await expect(wait).rejects.toMatchObject({ code: "cancelled" });
  await f.env.children.get(id)!.work;
  expect(f.env.children.get(id)?.active).toBe(false);
});

it("pages historical results and denies access/control to unrelated sessions", async () => {
  const f = await fixture();
  const id = await f.spawn();
  const text = "😀中文\n".repeat(3000);
  await f.settle(id, "completed", text);
  const child = f.env.children.get(id)!;
  f.env.children.clear();
  let offset = 0; let combined = "";
  do {
    const page = await f.value("get_agent_result", { id, offset, limit: 1001 });
    combined += page.content;
    expect(page.currentRun).toBe(false);
    expect(page.truncated).toBe(page.nextOffset !== null);
    offset = page.nextOffset;
  } while (offset !== null);
  expect(combined).toBe(text);
  expect(child.delivered).toBe(false);
  expect(await f.value("wait_agents", { ids: [id] })).toMatchObject([{ id, currentRun: false, active: false, truncated: true }]);
  await expect(f.invoke("get_agent_result", { id: f.root.id })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await f.value("wait_agents", { ids: [f.root.id] })).toMatchObject([{ id: f.root.id, error: expect.any(String) }]);
  await expect(f.invoke("cancel_agent", { id })).rejects.toMatchObject({ code: "invalid_input" });
  await expect(f.invoke("send_agent_message", { id, message: "restart" })).rejects.toMatchObject({ code: "invalid_input" });
});

it("paginates persisted children and labels historical/current ownership", async () => {
  const f = await fixture();
  const historical = await f.spawn(); await f.settle(historical);
  f.env.children.clear();
  const current = await f.spawn({ ownership: "src task", writePaths: ["src/task.ts"] });
  const first = await f.value("list_agents", { limit: 1 });
  const second = await f.value("list_agents", { offset: first.nextOffset, limit: 1 });
  expect(first.total).toBe(2); expect(first.truncated).toBe(true); expect(second.nextOffset).toBe(null);
  const all = [...first.agents, ...second.agents];
  expect(all.find(item => item.id === historical)).toMatchObject({ currentRun: false, active: false, controllable: false });
  expect(all.find(item => item.id === current)).toMatchObject({ currentRun: true, active: true, writePaths: ["src/task.ts"] });
  expect((await f.value("list_agents", { currentRun: true })).total).toBe(1);
});

it("queues at most eight messages and atomically closes an empty final boundary", async () => {
  const f = await fixture(); const id = await f.spawn();
  for (let i = 0; i < 8; i++) expect(await f.value("send_agent_message", { id, message: `message-${i}` })).toMatchObject({ queued: true, pendingMessages: i + 1 });
  await expect(f.invoke("send_agent_message", { id, message: "overflow" })).rejects.toMatchObject({ code: "budget" });
  const control = f.controls.get(id)!;
  expect(control.drainSteering(true)).toHaveLength(8);
  expect(await f.value("send_agent_message", { id, message: "last" })).toMatchObject({ queued: true });
  expect(control.drainSteering(true)).toEqual(["last"]);
  expect(control.drainSteering(true)).toEqual([]);
  await expect(f.invoke("send_agent_message", { id, message: "too late" })).rejects.toMatchObject({ code: "invalid_input" });
  await f.settle(id);
});

it("cancel joins only its child and resolving requires settlement with persistent evidence", async () => {
  const f = await fixture(); const a = await f.spawn(); const b = await f.spawn();
  await expect(f.invoke("resolve_agent", { id: a, resolution: "premature" })).rejects.toMatchObject({ code: "busy" });
  expect(await f.value("cancel_agent", { id: a })).toMatchObject({ status: "cancelled", active: false, handled: false });
  expect(f.env.children.get(b)?.active).toBe(true);
  expect(await f.value("resolve_agent", { id: a, resolution: "No changes; redundant task deliberately cancelled." })).toMatchObject({ status: "cancelled", handled: true });
  expect((await f.store.get(f.root.id)).agentResolutions?.[0]?.id).toBe(a);
  expect((await f.store.get(parseSessionId(a))).status).toBe("cancelled");
  f.env.children.delete(a);
  expect(await f.value("wait_agents", { ids: [a] })).toMatchObject([{ handled: true }]);
});

it("bounds many escaped reports without cutting JSON or losing child IDs", async () => {
  const f = await fixture();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) { const id = await f.spawn(); ids.push(id); await f.settle(id, "completed", "\u0000😀".repeat(4000)); }
  const result = await f.invoke("wait_agents", { ids });
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(65536);
  const reports = JSON.parse(result.content);
  expect(reports.map((item: { id: string }) => item.id)).toEqual(ids);
  expect(reports.every((item: { truncated: boolean; nextOffset: number }) => item.truncated && item.nextOffset > 0)).toBe(true);
});
