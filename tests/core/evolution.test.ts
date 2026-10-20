import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBoundary,
  projectSummary,
  summarize,
} from "../../src/core/context";
import { createAgentRuntime } from "../../src/core/runtime";
import type {
  LocalToolRegistry,
  ModelProvider,
} from "../../src/shared/contracts";
import {
  defaultPublicSettings,
  taskPlanSchema,
} from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const empty: LocalToolRegistry = {
  definitions: [],
  execute: async () => ({ content: "ok", isError: false }),
  dispose: async () => {},
};
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "forge-evolution-"));
  const store = await openSessionStore(dir);
  const root = await store.create({
    workspace: dir,
    title: "root",
    model: "parent",
  });
  return { dir, store, root };
}
describe("core evolution", () => {
  it("keeps the reconciled parent answer last while persisting inspectable child evidence", async () => {
    const { dir, store, root } = await setup();
    let parentTurns = 0;
    let childTurns = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages, _tools, options) => {
        if (options.model === "child" && childTurns++ === 0)
          return { message: { role: "assistant", content: null, tool_calls: [call("child-read", "read_file", { path: "a.ts" })] } };
        if (options.model === "child")
          return {
            message: {
              role: "assistant",
              content: "Child verified the implementation",
            },
          };
        parentTurns++;
        if (parentTurns === 1)
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                call("spawn", "spawn_agent", {
                  task: "verify",
                  model: "child",
                }),
              ],
            },
          };
        if (parentTurns === 2)
          return {
            message: {
              role: "assistant",
              content: "Preliminary parent answer",
            },
          };
        const reconciliation = messages.at(-1);
        expect(reconciliation?.role).toBe("user");
        expect(reconciliation?.content).toContain(
          "Child verified the implementation",
        );
        expect(reconciliation?.content).toContain('"status":"completed"');
        return {
          message: {
            role: "assistant",
            content: "Reconciled parent answer: implementation verified",
          },
        };
      },
    };
    try {
      const result = await createAgentRuntime({
        store,
        provider,
        tools: empty,
        settings: defaultPublicSettings,
      }).run(
        { sessionId: root.id, prompt: "delegate verification" },
        () => {},
        async () => false,
        new AbortController().signal,
      );
      expect(result.status).toBe("completed");
      expect(parentTurns).toBe(3);
      const finalMessage = {
        role: "assistant",
        content: "Reconciled parent answer: implementation verified",
      };
      expect(result.messages.at(-1)).toEqual(finalMessage);
      const restarted = await openSessionStore(dir);
      const persisted = await restarted.get(root.id);
      expect(
        persisted.messages.filter((m) => m.role === "assistant").at(-1),
      ).toEqual(finalMessage);
      expect(persisted.events.some(e => e.type === "agent_update" && e.currentTool?.name === "read_file" && e.currentTool.target === "a.ts")).toBe(true);
      expect(persisted.events.some(e => e.type === "tool_started" && e.call.id === "child-read")).toBe(false);
      const completed = persisted.events.filter(
        (e) => e.type === "agent_update" && e.status === "completed",
      );
      const outcome = completed.find(
        (e) =>
          e.type === "agent_update" &&
          e.summary.includes("Child verified the implementation"),
      );
      expect(outcome).toBeDefined();
      if (!outcome || outcome.type !== "agent_update")
        throw Error("Missing child outcome");
      const child = await restarted.get(outcome.childSessionId);
      expect(child.parentSessionId).toBe(root.id);
      expect(child.status).toBe("completed");
      expect(child.messages.at(-1)).toEqual({
        role: "assistant",
        content: "Child verified the implementation",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("runs independent child model requests concurrently and persists relationships", async () => {
    const { dir, store, root } = await setup();
    let concurrent = 0;
    let peak = 0;
    let rendezvousRelease = () => {};
    const rendezvous = new Promise<void>((resolve) => {
      rendezvousRelease = resolve;
    });
    let parentTurns = 0;
    const childModels: string[] = [];
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages, _tools, options) => {
        if (options.model === "parent") {
          parentTurns++;
          return {
            message:
              parentTurns === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      call("a", "spawn_agent", {
                        task: "one",
                        model: "child1",
                      }),
                      call("b", "spawn_agent", {
                        task: "two",
                        model: "child2",
                      }),
                    ],
                  }
                : { role: "assistant", content: "parent complete" },
          };
        }
        childModels.push(options.model);
        concurrent++;
        peak = Math.max(peak, concurrent);
        expect(
          messages.some((m) => m.content?.includes("parent complete")),
        ).toBe(false);
        if (concurrent === 2) rendezvousRelease();
        await rendezvous;
        concurrent--;
        return {
          message: { role: "assistant", content: `result ${options.model}` },
        };
      },
    };
    try {
      const result = await createAgentRuntime({
        store,
        provider,
        tools: empty,
        settings: defaultPublicSettings,
      }).run(
        { sessionId: root.id, prompt: "delegate" },
        () => {},
        async () => false,
        new AbortController().signal,
      );
      expect(result.status).toBe("completed");
      expect(peak).toBe(2);
      expect(childModels.sort()).toEqual(["child1", "child2"]);
      const restarted = await openSessionStore(dir);
      const children = (await restarted.list()).filter(
        (s) => s.parentSessionId === root.id,
      );
      expect(children).toHaveLength(2);
      expect(children.every((s) => s.status === "completed")).toBe(true);
      expect(
        result.events.filter(
          (e) => e.type === "agent_update" && e.status === "running",
        ),
      ).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("persists validated plans and enforces plan readonly through child execution", async () => {
    const { dir, store, root } = await setup();
    let parentTurns = 0;
    const permissions: string[] = [];
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (_m, _t, o) => {
        if (o.model === "parent")
          return {
            message:
              ++parentTurns === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      call("p", "update_plan", {
                        explanation: "inspect first",
                        steps: [{ step: "inspect", status: "in_progress" }],
                      }),
                      call("s", "spawn_agent", {
                        task: "inspect",
                        model: "child",
                      }),
                    ],
                  }
                : { role: "assistant", content: "plan ready" },
          };
        if (_m.some((m) => m.role === "tool"))
          return { message: { role: "assistant", content: "inspected" } };
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [call("w", "write_file", { path: "x", content: "no" })],
          },
        };
      },
    };
    const tools: LocalToolRegistry = {
      ...empty,
      execute: async (_c, ctx) => {
        permissions.push(ctx.permission);
        return { content: "denied", isError: true };
      },
    };
    try {
      const result = await createAgentRuntime({
        store,
        provider,
        tools,
        settings: defaultPublicSettings,
      }).run(
        {
          sessionId: root.id,
          prompt: "plan",
          mode: "plan",
          permission: "unrestricted",
        },
        () => {},
        async () => false,
        new AbortController().signal,
      );
      expect(result.plan?.steps[0]?.status).toBe("in_progress");
      expect((await store.get(root.id)).plan).toEqual(result.plan);
      expect(permissions).toEqual([]);
      expect(
        taskPlanSchema.safeParse({
          explanation: "bad",
          steps: [
            { step: "a", status: "in_progress" },
            { step: "b", status: "in_progress" },
          ],
        }).success,
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("joins failed children and cancellation cleanup without orphan sessions", async () => {
    const { dir, store, root } = await setup();
    let parentTurns = 0;
    let childStarted = () => {};
    const started = new Promise<void>((r) => {
      childStarted = r;
    });
    let parentFinal = () => {};
    const finalized = new Promise<void>((r) => {
      parentFinal = r;
    });
    if (!store.incremental) throw new Error("Missing incremental persistence");
    const commit = store.incremental.commit.bind(store.incremental);
    store.incremental.commit = async (id, mutation) => {
      const result = await commit(id, mutation);
      const snapshot = result.snapshot;
      if (
        snapshot.id === root.id &&
        snapshot.messages.at(-1)?.content === "done"
      )
        parentFinal();
      return result;
    };
    const controller = new AbortController();
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (_m, _t, o) => {
        if (o.model === "parent")
          return {
            message:
              ++parentTurns === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      call("s", "spawn_agent", {
                        task: "work",
                        model: "child",
                      }),
                    ],
                  }
                : { role: "assistant", content: "done" },
          };
        childStarted();
        await new Promise<void>((resolve) =>
          o.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw Error("cancelled child");
      },
    };
    try {
      const work = createAgentRuntime({
        store,
        provider,
        tools: empty,
        settings: defaultPublicSettings,
      }).run(
        { sessionId: root.id, prompt: "work" },
        () => {},
        async () => false,
        controller.signal,
      );
      await Promise.all([started, finalized]);
      controller.abort();
      const result = await work;
      expect(result.status).toBe("cancelled");
      const children = (await store.list()).filter(
        (s) => s.parentSessionId === root.id,
      );
      expect(children).toHaveLength(1);
      expect(children[0]?.status).toBe("cancelled");
      const release = await store.acquire(root.id);
      await release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("preserves child provider failure in parent-owned result envelopes", async () => {
    const { dir, store, root } = await setup();
    let turns = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (_m, _t, o) => {
        if (o.model !== "parent") throw Error("provider down");
        return {
          message:
            ++turns === 1
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    call("s", "spawn_agent", { task: "work", model: "broken" }),
                  ],
                }
              : { role: "assistant", content: "parent done" },
        };
      },
    };
    try {
      const result = await createAgentRuntime({
        store,
        provider,
        tools: empty,
        settings: defaultPublicSettings,
      }).run(
        { sessionId: root.id, prompt: "work" },
        () => {},
        async () => false,
        new AbortController().signal,
      );
      expect(result.status).toBe("failed");
      const envelope = result.events
        .filter((e) => e.type === "agent_update")
        .at(-1);
      expect(envelope?.type === "agent_update" && envelope.status).toBe(
        "failed",
      );
      expect(envelope?.type === "agent_update" && envelope.summary).toContain(
        "Model request failed",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("generates semantic memory without deleting transcript and rejects split pairs", async () => {
    const { dir, root } = await setup();
    const messages = [
      { role: "system" as const, content: "stable instructions" },
      { role: "user" as const, content: "task" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [call("x", "write_file", {})],
      },
      { role: "tool" as const, tool_call_id: "x", content: "done" },
    ];
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async () => ({
        message: {
          role: "assistant",
          content:
            "Task: implement. Constraints: readonly. Decisions: inspect. Files: x. Remaining: verify.",
        },
      }),
    };
    try {
      expect(() => assertBoundary(messages, 3)).toThrow();
      const s = await summarize(
        { ...root, messages },
        provider,
        new AbortController().signal,
        4,
      );
      expect(s.messages).toEqual(messages);
      expect(projectSummary(s)[0]).toEqual(messages[0]);
      expect(s.contextSummary?.fallback).toBe(false);
      const failed = await summarize(
        { ...root, messages },
        {
          ...provider,
          complete: async () => {
            throw Error("down");
          },
        },
        new AbortController().signal,
        4,
      );
      expect(failed.contextSummary?.fallback).toBe(true);
      expect(failed.messages).toEqual(messages);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
