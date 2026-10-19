import { expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import { ProviderError } from "../../src/provider/openai";
import type { ApprovalHandler, ModelProvider, SessionStore, RunControl } from "../../src/shared/contracts";
import { defaultPublicSettings, sessionSnapshotSchema, type AgentEvent, type Permission, type PublicSettings } from "../../src/shared/schemas";

const answer = { message: { role: "assistant", content: "News", citations: [{ url: "https://example.com/", title: "Source", startIndex: 0, endIndex: 4 }], webSearches: [{ id: "ws", status: "completed", action: "search", queries: ["news"] }] } } as const;
function fixture(complete: ModelProvider["complete"], settings: Partial<PublicSettings> = {}, apiMode: NonNullable<ModelProvider["apiMode"]> = "responses") {
  let current = sessionSnapshotSchema.parse({ version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "Test", workspace: "/workspace", model: "model", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "idle", messages: [], events: [], changes: [] });
  const store: SessionStore = { list: async () => [], get: async () => current, create: async () => current, save: async (s) => { current = sessionSnapshotSchema.parse(s); }, acquire: async () => async () => {} };
  const execute = vi.fn(async () => ({ content: "ok", isError: false }));
  const runtime = createAgentRuntime({ store, provider: { apiMode, listModels: async () => [], complete }, settings: { ...defaultPublicSettings, webSearch: "live", ...settings }, tools: { definitions: [], execute, dispose: async () => {} } });
  const events: AgentEvent[] = [];
  const run = (permission: Permission, approve: ApprovalHandler = async () => false, mode: "build" | "plan" = "build", control?: RunControl, signal = new AbortController().signal) => runtime.run({ sessionId: current.id, prompt: "news", permission, mode }, (e) => events.push(e), approve, signal, control);
  return { run, execute, events, current: () => current };
}

it("allows native search unrestricted, keeps progress ephemeral and saves citations/records, never executes a local search", async () => {
  const f = fixture(async (_m, _d, options) => {
    expect(options.webSearch).toBe("live");
    options.onWebSearch?.({ id: "ws", status: "searching" });
    return answer;
  });
  const approve = vi.fn(async () => false);
  const result = await f.run("unrestricted", approve);
  expect(result.status).toBe("completed");
  expect(result.messages.at(-1)).toEqual(answer.message);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "web_search", search: { id: "ws", status: "searching" } }));
  expect(result.events.some((e) => e.type === "web_search" || e.type === "web_search_result")).toBe(false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "web_search_result", citations: answer.message.citations }));
  expect(f.execute).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
});

it.each(["readonly", "plan", "disabled"] as const)("does not authorize search in %s", async (setting) => {
  const f = fixture(async (_m, _d, options) => { expect(options.webSearch).toBe("disabled"); return { message: { role: "assistant", content: "No search" } }; }, setting === "disabled" ? { webSearch: "disabled" } : {});
  const approve = vi.fn<ApprovalHandler>(async () => true);
  const result = await f.run(setting === "readonly" ? "readonly" : "unrestricted", approve, setting === "plan" ? "plan" : "build");
  expect(result.status).toBe("completed");
  expect(approve).not.toHaveBeenCalled();
});

it("approves each workspace request before dispatch and denial sends no provider request", async () => {
  const complete = vi.fn<ModelProvider["complete"]>(async () => answer);
  const f = fixture(complete);
  const denied = await f.run("workspace", async (request) => { expect(complete).not.toHaveBeenCalled(); expect(request).toMatchObject({ toolName: "web_search" }); expect(request.description).toContain("individual queries and URLs cannot be approved"); return false; });
  expect(denied.status).toBe("failed");
  expect(complete).not.toHaveBeenCalled();
  const approve = vi.fn<ApprovalHandler>(async () => true);
  expect((await f.run("workspace", approve)).status).toBe("completed");
  expect(approve).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
});

it("requests fresh workspace consent on each tool continuation", async () => {
  let calls = 0;
  const f = fixture(async () => calls++ === 0 ? { message: { role: "assistant", content: null, tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] } } : answer);
  const approve = vi.fn<ApprovalHandler>(async () => true);
  expect((await f.run("workspace", approve)).status).toBe("completed");
  expect(approve).toHaveBeenCalledTimes(2);
  expect(new Set(approve.mock.calls.map(([request]) => request.toolCallId)).size).toBe(2);
});

it("rechecks effective permission after approval and cancels a pending approval without dispatch", async () => {
  let permission: Permission = "workspace";
  const complete = vi.fn<ModelProvider["complete"]>(async (_m, _d, options) => { expect(options.webSearch).toBe("disabled"); return { message: { role: "assistant", content: "No search" } }; });
  const f = fixture(complete);
  expect((await f.run("workspace", async () => { permission = "readonly"; return true; }, "build", { getPermission: () => permission, drainSteering: () => [] })).status).toBe("completed");
  const controller = new AbortController();
  const another = fixture(complete);
  const before = complete.mock.calls.length;
  expect((await another.run("workspace", async () => { controller.abort(); return new Promise(() => {}); }, "build", undefined, controller.signal)).status).toBe("cancelled");
  expect(complete).toHaveBeenCalledTimes(before);
});

it("fails incompatible protocols before generation, and never retries an uncertain hosted request", async () => {
  const complete = vi.fn<ModelProvider["complete"]>(async () => { throw new ProviderError("network", "Connection lost", true); });
  const f = fixture(complete, {}, "chat-completions");
  expect((await f.run("unrestricted")).status).toBe("failed");
  expect(complete).not.toHaveBeenCalled();
  const native = fixture(complete);
  expect((await native.run("unrestricted")).status).toBe("failed");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(native.events.some((e) => e.type === "provider_retry")).toBe(false);
});
