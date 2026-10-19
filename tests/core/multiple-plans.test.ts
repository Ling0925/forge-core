import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionPlan, updateSessionPlan } from "../../src/core/plans";
import { nativeDefinitions } from "../../src/core/agents";
import { buildSystemInstructions } from "../../src/core/prompts";
import { createAgentRuntime } from "../../src/core/runtime";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
import { recordPlan, sessionPlans } from "../../src/shared/plans";
import { defaultPublicSettings, sessionSnapshotSchema, type TaskPlan } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";

const content = (step = "inspect", status: TaskPlan["steps"][number]["status"] = "in_progress") => ({
  explanation: "Focused work and verification", steps: [{ step, status }],
});
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("independent session plans", () => {
  it("exposes flat create/update tools without ID or action on creation", () => {
    const create = nativeDefinitions.find(definition => definition.function.name === "create_plan");
    const update = nativeDefinitions.find(definition => definition.function.name === "update_plan");
    expect(create?.function.parameters).toMatchObject({ type: "object", additionalProperties: false,
      required: ["name", "explanation", "steps"], properties: { name: { type: "string" } } });
    expect(update?.function.parameters).toMatchObject({ type: "object", additionalProperties: false,
      required: ["explanation", "steps"], properties: { planId: { type: "string" } } });
    for (const key of ["id", "planId", "action", "title"])
      expect(create?.function.parameters.properties).not.toHaveProperty(key);
    for (const tool of [create, update]) expect(tool?.function.parameters).not.toHaveProperty("anyOf");
  });

  it("generates independent IDs and rejects IDs or invalid steps on creation", () => {
    const first = createSessionPlan({}, { name: "Task A", ...content() });
    const second = createSessionPlan(first, { name: "Task B", ...content() });
    expect(first.plan).toMatchObject({ title: "Task A", id: expect.any(String) });
    expect(second.plans).toHaveLength(2);
    expect(second.plan.id).not.toBe(first.plan.id);
    for (const key of ["id", "planId", "action"])
      expect(() => createSessionPlan(first, { name: "Task C", ...content(), [key]: "extra" })).toThrow();
    expect(() => createSessionPlan(first, { name: "Task C", ...content(), steps: [content().steps[0], content("other").steps[0]] })).toThrow("At most one");
    expect(first.plans).toHaveLength(1);
  });

  it("creates independent plans and updates an older one without changing another", () => {
    const first = updateSessionPlan({}, { action: "create", title: "Task A", ...content("A") });
    const second = updateSessionPlan(first, { action: "create", title: "Task B", ...content("B") });
    expect(second.plans).toHaveLength(2);
    expect(second.plan.id).not.toBe(first.plan.id);
    expect(second.plans[0]).toEqual(first.plan);
    const updated = updateSessionPlan(second, {
      action: "update", planId: first.plan.id, ...content("A", "completed"),
    });
    expect(updated.plan).toMatchObject({ id: first.plan.id, title: "Task A" });
    expect(updated.plans).toHaveLength(2);
    expect(updated.plans[1]).toEqual(second.plan);
    expect(second.plans[0]?.steps[0]?.status).toBe("in_progress");
  });

  it("keeps selector-free calls compatible and starts another plan after completion", () => {
    const initial = updateSessionPlan({}, content());
    const done = updateSessionPlan(initial, content("inspect", "completed"));
    expect(done.plan.id).toBe(initial.plan.id);
    expect(done.plans).toHaveLength(1);
    const next = updateSessionPlan(done, content("new task"));
    expect(next.plan.id).not.toBe(done.plan.id);
    expect(next.plans[0]).toEqual(done.plan);
    const reopened = updateSessionPlan(next, { planId: done.plan.id, ...content("follow-up") });
    expect(reopened.plans).toHaveLength(2);
    expect(reopened.plan.id).toBe(done.plan.id);
  });

  it("preserves legacy plans and supports old events and identified events", () => {
    const legacy = content("old", "completed");
    expect(sessionPlans({ plan: legacy })).toEqual([{ ...legacy, id: "legacy", title: "原有计划" }]);
    const next = updateSessionPlan({ plan: legacy }, { action: "create", title: "New", ...content() });
    expect(next.plans).toHaveLength(2);
    const event = { ...next.plan, ...content("verify", "completed") };
    const replay = recordPlan(next, event);
    expect(replay.plans).toHaveLength(2);
    expect(replay.plan).toEqual(event);
    const oldReplay = recordPlan({ plan: legacy }, content("old update"));
    expect(oldReplay.plans).toHaveLength(1);
    expect(oldReplay.plan).toEqual(content("old update"));
    expect(oldReplay.plans[0]?.id).toBe("legacy");
  });

  it("rejects unknown IDs, conflicting selectors and invalid steps without mutating plans", () => {
    const state = updateSessionPlan({}, content());
    expect(() => updateSessionPlan(state, { planId: "missing", ...content() })).toThrow("Unknown planId");
    expect(() => updateSessionPlan(state, { action: "create", planId: state.plan.id, ...content() })).toThrow("cannot specify planId");
    expect(() => updateSessionPlan({}, { action: "update", ...content() })).toThrow("No existing plan");
    expect(() => updateSessionPlan(state, { id: "overwrite", ...content() })).toThrow("Use planId");
    expect(() => updateSessionPlan(state, { ...content(), steps: [content().steps[0], content("other").steps[0]] })).toThrow("At most one");
    expect(state.plans).toHaveLength(1);
  });

  it("instructs later turns to create task-specific plans, not append to completed plans", () => {
    const prompt = buildSystemInstructions({ session: { workspace: "/workspace" }, permission: "readonly", mode: "build", maxToolCalls: 20 });
    expect(prompt).toContain("every new user request");
    expect(prompt).toContain("create_plan");
    expect(prompt).toContain("update_plan");
    expect(prompt).toContain("never append an unrelated task");
    expect(prompt).toContain("Simple questions and small edits");
  });

  it("persists multiple plans across runs/reopen/fork and emits identified update results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-multiple-plans-")); dirs.push(dir);
    const store = await openSessionStore(dir);
    const root = await store.create({ workspace: dir, model: "fixture", title: "Multiple plans" });
    let turn = 0;
    let firstId = "";
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages) => {
        const last = messages.at(-1);
        if (last?.role === "tool") {
          const result = JSON.parse(JSON.parse(last.content).content);
          expect(result.id).toBeTruthy();
          if (!firstId) firstId = result.id;
          return { message: { role: "assistant", content: "done" } };
        }
        const args = ++turn === 1
          ? { name: "First", ...content("A", "completed") }
          : turn === 2
            ? { name: "Second", ...content("B") }
            : { planId: firstId, ...content("A verified", "completed") };
        return { message: { role: "assistant", content: null, tool_calls: [{
          id: `plan-${turn}`, type: "function", function: { name: turn <= 2 ? "create_plan" : "update_plan", arguments: JSON.stringify(args) },
        }] } };
      },
    };
    const runtime = createAgentRuntime({ store, provider, settings: defaultPublicSettings,
      tools: { definitions: [], execute: async () => ({ content: "unused", isError: false }), dispose: async () => {} },
    });
    for (const prompt of ["Task A", "Task B", "Return to A"]) {
      const result = await runtime.run({ sessionId: root.id, prompt }, () => {}, async () => false, new AbortController().signal);
      expect(result.events.filter(event => event.type === "error")).toEqual([]);
      expect(result.status).toBe("completed");
    }
    const reopened = await openSessionStore(dir);
    const snapshot = sessionSnapshotSchema.parse(await reopened.get(root.id));
    expect(snapshot.plans).toHaveLength(2);
    expect(snapshot.plans?.map(plan => plan.title)).toEqual(["First", "Second"]);
    expect(snapshot.plan?.id).toBe(firstId);
    expect(snapshot.plans?.[0]?.steps[0]?.step).toBe("A verified");
    expect(snapshot.plans?.[1]?.steps[0]?.step).toBe("B");
    expect(snapshot.events.filter(event => event.type === "plan_updated")).toHaveLength(3);
    const harness = await createHarness({ stateDir: dir });
    try {
      const fork = await harness.forkSession(root.id);
      expect(fork.plans).toEqual(snapshot.plans);
      expect(fork.plan).toEqual(snapshot.plan);
    } finally { await harness.dispose(); }
  });
});
