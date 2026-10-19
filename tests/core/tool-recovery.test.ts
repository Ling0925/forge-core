import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProjectContext } from "../../src/context/project-context";
import { executeHistory } from "../../src/core/history";
import { createAgentRuntime } from "../../src/core/runtime";
import { createToolFailureGuard } from "../../src/core/tool-failure-guard";
import type { ModelProvider, SessionStore } from "../../src/shared/contracts";
import { defaultPublicSettings, sessionSnapshotSchema, type AgentEvent, type ToolCall } from "../../src/shared/schemas";
import { createSkillTool } from "../../src/tools/skills";

const initial = (workspace: string) => sessionSnapshotSchema.parse({ version: 1, id: "00000000-0000-4000-8000-000000000001", title: "Input recovery",
  workspace, model: "fixture", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", status: "idle", messages: [], events: [], changes: [] });
const call = (name: string, args: string): ToolCall => ({ id: "input", type: "function", function: { name, arguments: args } });

it.each([
  ["project_context", '{"path":"../outside"}'],
  ["project_context", '{"path":"private-input-marker'],
  ["load_skill", '{"skill":"private-input-marker'],
  ["create_plan", '{"name":"private-input-marker'],
  ["list_models", '{"query":"private-input-marker'],
  ["list_models", '{"limit":101}'],
  ["history_search", '{"query":"x","limit":21}'],
  ["history_read", '{"id":"invalid"}'],
])("lets the model correct invalid %s input without abandoning the run", async (name, args) => {
  const root = await mkdtemp(join(tmpdir(), "forge-tool-recovery-"));
  const context = await createProjectContext(root);
  const tools = createSkillTool(context);
  let snapshot = initial(root);
  let requests = 0;
  const events: AgentEvent[] = [];
  const provider: ModelProvider = { listModels: async () => [], complete: async () => {
    requests++;
    return { message: requests < 3
      ? { role: "assistant", content: null, tool_calls: [requests === 1 ? call(name, args) : call("project_context", "{}")] }
      : { role: "assistant", content: "Corrected." } };
  } };
  const store: SessionStore = { list: async () => [], get: async () => snapshot, create: async () => snapshot,
    save: async value => { snapshot = value; }, acquire: async () => async () => {} };
  try {
    const runtime = createAgentRuntime({ store, provider, tools, settings: defaultPublicSettings });
    const result = await runtime.run({ sessionId: snapshot.id, prompt: "Inspect the fixture.", permission: "unrestricted" }, event => events.push(event), async () => false, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(requests).toBe(3);
    expect(snapshot.pendingTool).toBeUndefined();
    const finished = events.filter(event => event.type === "tool_finished");
    expect(finished).toHaveLength(2);
    expect(finished[0]?.result.isError).toBe(true);
    expect(JSON.parse(finished[0]?.result.content ?? "null")).toMatchObject({ code: "invalid_input" });
    expect(finished[0]?.result.content).not.toContain("private-input-marker");
    expect(finished[1]?.result.isError).toBe(false);
  } finally {
    await tools.dispose(); await context.dispose(); await rm(root, { recursive: true, force: true });
  }
});

it("stops repeated history validation failures even when the query changes", () => {
  const guard = createToolFailureGuard();
  const attempt = (query: string) => {
    const args = { query, limit: 21 };
    guard(call("history_search", JSON.stringify(args)), executeHistory("history_search", args, initial("/workspace")));
  };
  attempt("one"); attempt("two");
  expect(() => attempt("three")).toThrow("three identical failures");
});
