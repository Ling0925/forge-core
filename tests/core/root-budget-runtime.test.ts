import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSummary, boundedReports } from "../../src/core/agent-operations";
import { createRootRunBudget } from "../../src/core/run-budget";
import { createAgentRuntime } from "../../src/core/runtime";
import { ProviderError } from "../../src/provider/openai";
import type {
  AgentRuntimeDependencies,
  ApprovalHandler,
  LocalToolRegistry,
  ModelProvider,
  SessionStore,
} from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import type { RootRunBudget } from "../../src/shared/run-budget";
import {
  type AgentEvent,
  type SessionSnapshot,
  type ToolCall,
  defaultPublicSettings,
  sessionIdSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";

const call = (
  id: string,
  name = "read_file",
  args: unknown = {},
): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const calls = (...items: ToolCall[]) => ({
  message: { role: "assistant" as const, content: null, tool_calls: items },
});
const answer = () => ({
  message: { role: "assistant" as const, content: "done" },
});
const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
const tools: LocalToolRegistry = {
  definitions: [],
  dispose: async () => {},
  execute: async () => ({ content: "ok", isError: false }),
};
function latch() {
  let release = () => {};
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { work, release };
}
function abort(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
function fixture(provider: ModelProvider, registry = tools, settings = {}) {
  const records = new Map<string, SessionSnapshot>();
  const locked = new Set<string>();
  let failSave: ((value: SessionSnapshot) => boolean) | undefined;
  const create = (input: {
    workspace: string;
    title: string;
    model: string;
  }) => {
    const value = sessionSnapshotSchema.parse({
      ...input,
      version: 1,
      id: randomUUID(),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      status: "idle",
      messages: [],
      events: [],
      changes: [],
    });
    records.set(value.id, value);
    return value;
  };
  const store: SessionStore = {
    get: async (id) => {
      const value = records.get(id);
      if (!value) throw Error("missing");
      return value;
    },
    list: async () => [...records.values()],
    create: async (input) => create(input),
    save: async (value) => {
      if (failSave?.(value)) throw Error("fixture write failure");
      records.set(value.id, sessionSnapshotSchema.parse(value));
    },
    acquire: async (id) => {
      if (locked.has(id)) throw new ForgeError("busy", "fixture locked");
      locked.add(id);
      return async () => {
        locked.delete(id);
      };
    },
  };
  const root = create({
    workspace: "/fixture",
    title: "fixture",
    model: "parent",
  });
  const deps: AgentRuntimeDependencies = {
    store,
    provider,
    tools: registry,
    settings: { ...defaultPublicSettings, ...settings },
  };
  const run = (
    extra: Partial<AgentRuntimeDependencies> = {},
    approve: ApprovalHandler = async () => false,
    signal = new AbortController().signal,
    onEvent: (event: AgentEvent) => void = () => {},
  ) =>
    createAgentRuntime({ ...deps, ...extra }).run(
      { sessionId: root.id, prompt: "task" },
      onEvent,
      approve,
      signal,
    );
  return {
    root,
    deps,
    records,
    locked,
    run,
    fail: (fn: (value: SessionSnapshot) => boolean) => {
      failSave = fn;
    },
  };
}
function terminal(snapshot: SessionSnapshot) {
  const event = snapshot.events.findLast(
    (item) => item.type === "run_finished",
  );
  if (!event || event.type !== "run_finished") throw Error("missing terminal");
  return event;
}
function timed(root: string) {
  let clock = 0;
  const budget = createRootRunBudget({
    rootSessionId: root,
    maxToolCalls: 20,
    timeoutMs: 1000,
    clock: () => clock,
  });
  return {
    budget,
    expire() {
      clock = 1000;
      expect(() => budget.check()).toThrow("deadline");
    },
  };
}

describe("shared root budget integration", () => {
  it("bounds four competing children plus parent attempts, preserving each child local limit", async () => {
    const ready = latch();
    let parentRequests = 0;
    let childRequests = 0;
    let executions = 0;
    const f = fixture(
      {
        listModels: async () => [],
        complete: async (_messages, _definitions, options) => {
          if (options.model === "child") {
            childRequests++;
            if (childRequests === 4) ready.release();
            await ready.work;
            return calls(
              ...Array.from({ length: 4 }, (_, i) =>
                call(`${randomUUID()}-${i}`),
              ),
            );
          }
          if (++parentRequests === 1)
            return calls(
              ...Array.from({ length: 4 }, (_, i) =>
                call(`spawn-${i}`, "spawn_agent", {
                  task: "child",
                  model: "child",
                  maxToolCalls: 2,
                }),
              ),
            );
          return answer();
        },
      },
      {
        ...tools,
        isConcurrencySafe: () => true,
        execute: async () => {
          executions++;
          return { content: "read", isError: false };
        },
      },
      { maxToolCalls: 20, maxRootToolCalls: 9 },
    );
    const result = await f.run();
    const budget = terminal(result).budget;
    expect(childRequests).toBe(4);
    expect(executions).toBe(5);
    expect(budget).toMatchObject({
      consumed: 9,
      reserved: 0,
      remaining: 0,
      stopReason: "tools",
    });
    expect(budget?.sessions).toHaveLength(5);
    expect(
      budget?.sessions
        .filter((item) => item.sessionId !== f.root.id)
        .every((item) => item.consumed <= 2),
    ).toBe(true);
    expect(
      [...f.records.values()].reduce(
        (sum, item) => sum + terminal(item).toolCalls,
        0,
      ),
    ).toBe(9);
    expect(result.status).toBe("failed");
    expect(f.locked.size).toBe(0);
  });

  it("does not start a child or another model request when spawn consumes the last slot", async () => {
    let requests = 0;
    let constructions = 0;
    const f = fixture(
      {
        listModels: async () => [],
        complete: async () => {
          requests++;
          return calls(call("spawn", "spawn_agent", { task: "child" }));
        },
      },
      tools,
      { maxRootToolCalls: 1 },
    );
    const result = await f.run({
      childToolFactory: async () => {
        constructions++;
        return tools;
      },
    });
    expect(requests).toBe(1);
    expect(constructions).toBe(0);
    expect(f.records.size).toBe(1);
    expect(terminal(result).budget).toMatchObject({
      consumed: 1,
      remaining: 0,
    });
  });

  for (const concurrent of [false, true])
    it(`releases undispatched ${concurrent ? "batch" : "serial"} reservations after durable-intent failure`, async () => {
      let executions = 0;
      let failed = false;
      const f = fixture(
        {
          listModels: async () => [],
          complete: async () => calls(call("one"), call("two")),
        },
        {
          ...tools,
          isConcurrencySafe: () => concurrent,
          execute: async () => {
            executions++;
            return { content: "ok", isError: false };
          },
        },
      );
      f.fail((value) => {
        if (
          !failed &&
          (value.pendingTool ||
            value.events.some((event) => event.type === "tool_started"))
        ) {
          failed = true;
          return true;
        }
        return false;
      });
      const result = await f.run();
      expect(failed).toBe(true);
      expect(executions).toBe(0);
      expect(terminal(result)).toMatchObject({
        status: "failed",
        toolCalls: 0,
        budget: { consumed: 0, reserved: 0, remaining: 100 },
      });
    });

  it("counts denied and failed tools as scheduled attempts, never refunds them", async () => {
    let executions = 0;
    const f = fixture(
      {
        listModels: async () => [],
        complete: async () =>
          calls(call("denied", "run_command"), call("error", "read_file")),
      },
      {
        ...tools,
        execute: async () => {
          executions++;
          return { content: "failed read", isError: true };
        },
      },
      { maxRootToolCalls: 2 },
    );
    const result = await createAgentRuntime(f.deps).run(
      { sessionId: f.root.id, prompt: "task", mode: "plan" },
      () => {},
      async () => true,
      new AbortController().signal,
    );
    expect(executions).toBe(1);
    expect(terminal(result)).toMatchObject({
      toolCalls: 2,
      budget: { consumed: 2, reserved: 0 },
    });
    expect(
      result.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(2);
  });

  it("expires approval waiting and holds the lock until the started tool cleanup joins", async () => {
    const entered = latch();
    const cleanup = latch();
    let executions = 0;
    let requests = 0;
    const f = fixture(
      {
        listModels: async () => [],
        complete: async () => {
          requests++;
          return calls(call("write", "write_file"));
        },
      },
      {
        ...tools,
        execute: async (_call, context) => {
          try {
            await context.approve(
              {
                id: randomUUID(),
                sessionId: context.sessionId,
                toolCallId: "write",
                toolName: "write_file",
                description: "fixture",
              },
              context.signal,
            );
            executions++;
            return { content: "write", isError: false };
          } finally {
            await cleanup.work;
          }
        },
      },
    );
    const t = timed(f.root.id);
    let settled = false;
    try {
      const work = f
        .run({ rootBudget: t.budget }, async () => {
          entered.release();
          return new Promise<boolean>(() => {});
        })
        .finally(() => {
          settled = true;
        });
      await entered.work;
      t.expire();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.locked.has(f.root.id)).toBe(true);
      cleanup.release();
      const result = await work;
      expect(executions).toBe(0);
      expect(requests).toBe(1);
      expect(f.locked.size).toBe(0);
      expect(terminal(result)).toMatchObject({
        status: "failed",
        budget: { stopReason: "deadline", consumed: 1, reserved: 0 },
      });
    } finally {
      cleanup.release();
      t.budget.close();
    }
  });

  it("cancels and joins every started read before reporting root timeout", async () => {
    const entered = latch();
    const cleanup = latch();
    let active = 0;
    const f = fixture(
      {
        listModels: async () => [],
        complete: async () =>
          calls(...[1, 2, 3, 4].map((id) => call(String(id)))),
      },
      {
        ...tools,
        isConcurrencySafe: () => true,
        execute: async (_call, context) => {
          if (++active === 4) entered.release();
          await abort(context.signal);
          await cleanup.work;
          active--;
          return { content: "cancelled", isError: true };
        },
      },
    );
    const t = timed(f.root.id);
    try {
      const work = f.run({ rootBudget: t.budget });
      await entered.work;
      t.expire();
      expect(active).toBe(4);
      expect(f.locked.size).toBe(1);
      cleanup.release();
      const result = await work;
      expect(active).toBe(0);
      expect(f.locked.size).toBe(0);
      expect(terminal(result)).toMatchObject({
        status: "failed",
        budget: { consumed: 4, stopReason: "deadline" },
      });
    } finally {
      cleanup.release();
      t.budget.close();
    }
  });

  it("joins child construction after timeout and does not start its provider", async () => {
    const entered = latch();
    const release = latch();
    let disposed = 0;
    let childRequests = 0;
    let rootRequests = 0;
    const f = fixture({
      listModels: async () => [],
      complete: async (_messages, _defs, options) => {
        if (options.model === "child") {
          childRequests++;
          return answer();
        }
        return ++rootRequests === 1
          ? calls(
              call("spawn", "spawn_agent", { task: "child", model: "child" }),
            )
          : answer();
      },
    });
    const t = timed(f.root.id);
    let settled = false;
    try {
      const work = f
        .run({
          rootBudget: t.budget,
          childToolFactory: async () => {
            entered.release();
            await release.work;
            return {
              ...tools,
              dispose: async () => {
                disposed++;
              },
            };
          },
        })
        .finally(() => {
          settled = true;
        });
      await entered.work;
      t.expire();
      await Promise.resolve();
      expect(settled).toBe(false);
      release.release();
      const result = await work;
      expect(disposed).toBe(1);
      expect(childRequests).toBe(0);
      expect(f.locked.size).toBe(0);
      expect(terminal(result).budget?.stopReason).toBe("deadline");
    } finally {
      release.release();
      t.budget.close();
    }
  });

  it("includes retries in the deadline and records missing usage without retrying effects", async () => {
    let requests = 0;
    const f = fixture({
      listModels: async () => [],
      complete: async () => {
        requests++;
        throw new ProviderError("timeout", "transient");
      },
    });
    const t = timed(f.root.id);
    try {
      const result = await f.run(
        { rootBudget: t.budget },
        undefined,
        undefined,
        (event) => {
          if (event.type === "provider_retry") t.expire();
        },
      );
      expect(requests).toBe(1);
      expect(terminal(result).budget).toMatchObject({
        stopReason: "deadline",
        consumed: 0,
        usage: { missingRequests: 1, reportedRequests: 0, complete: false },
      });
    } finally {
      t.budget.close();
    }
  });

  it("gives an explicit independent run a fresh ledger without reopening a closed one", async () => {
    let executions = 0;
    let requests = 0;
    const f = fixture(
      {
        listModels: async () => [],
        complete: async () => {
          requests++;
          return calls(call(`read-${requests}`));
        },
      },
      {
        ...tools,
        execute: async () => {
          executions++;
          return { content: "ok", isError: false };
        },
      },
      { maxRootToolCalls: 1 },
    );
    const first = await f.run();
    const second = await f.run();
    expect(executions).toBe(2);
    expect(requests).toBe(2);
    expect(terminal(first).budget?.rootRunId).not.toBe(
      terminal(second).budget?.rootRunId,
    );
    expect(terminal(first).budget?.consumed).toBe(1);
    expect(terminal(second).budget?.consumed).toBe(1);
    const budget = createRootRunBudget({
      rootSessionId: f.root.id,
      maxToolCalls: 1,
    });
    budget.close();
    await expect(f.run({ rootBudget: budget })).rejects.toThrow(
      "cannot be resumed",
    );
    expect(executions).toBe(2);
  });

  it("retains a cancelled dispatched attempt and joins its cleanup", async () => {
    const entered = latch();
    const cleanup = latch();
    const controller = new AbortController();
    const f = fixture(
      { listModels: async () => [], complete: async () => calls(call("read")) },
      {
        ...tools,
        execute: async (_call, context) => {
          entered.release();
          await abort(context.signal);
          await cleanup.work;
          return { content: "stopped", isError: true };
        },
      },
    );
    const work = f.run({}, undefined, controller.signal);
    await entered.work;
    controller.abort();
    expect(f.locked.size).toBe(1);
    cleanup.release();
    const result = await work;
    expect(terminal(result)).toMatchObject({
      status: "cancelled",
      budget: { consumed: 1, reserved: 0, stopReason: null },
    });
    expect(f.locked.size).toBe(0);
  });

  it("reports provider and auxiliary memory usage without pretending missing observations are estimates", async () => {
    let requests = 0;
    const f = fixture(
      {
        listModels: async () => [],
        complete: async () => ({
          ...(++requests === 1
            ? calls(call("memory", "forge_memory"))
            : answer()),
          usage,
        }),
      },
      {
        ...tools,
        execute: async (_call, context) => {
          context.onModelUsage?.({
            promptTokens: 7,
            completionTokens: 1,
            totalTokens: 8,
          });
          context.onModelUsage?.(undefined);
          return { content: "memory", isError: false };
        },
      },
    );
    const result = await f.run();
    expect(terminal(result).budget?.usage).toEqual({
      basis: "reported",
      reportedRequests: 3,
      missingRequests: 1,
      complete: false,
      promptTokens: 13,
      completionTokens: 5,
      totalTokens: 18,
      cachedPromptTokens: 0,
    });
    expect(terminal(result)).toMatchObject({
      usage: { totalTokens: 18 },
      usageComplete: false,
    });
  });

  it("keeps 32 child result summaries bounded instead of repeating the entire ledger per child", () => {
    const f = fixture({
      listModels: async () => [],
      complete: async () => answer(),
    });
    const ids = Array.from({ length: 32 }, () =>
      sessionIdSchema.parse(randomUUID()),
    );
    const budget: RootRunBudget = createRootRunBudget({
      rootSessionId: f.root.id,
      maxToolCalls: 100,
    });
    try {
      budget.enter(f.root.id);
      for (const id of ids) budget.enter(id);
      const snapshots = ids.map((id) =>
        sessionSnapshotSchema.parse({
          ...f.root,
          id,
          parentSessionId: f.root.id,
          status: "completed",
          messages: [{ role: "assistant", content: "x".repeat(10000) }],
          events: [
            {
              type: "run_finished",
              sessionId: id,
              timestamp: "2026-01-01T00:00:00Z",
              status: "completed",
              turns: 1,
              toolCalls: 0,
              budget: budget.snapshot(),
            },
          ],
        }),
      );
      const reports = boundedReports(snapshots, (snapshot, limit) =>
        agentSummary(snapshot, limit),
      );
      expect(Buffer.byteLength(reports)).toBeLessThanOrEqual(65536);
      expect(JSON.parse(reports)).toHaveLength(32);
      const first = snapshots[0];
      if (!first) throw Error("missing child");
      expect(agentSummary(first).budget?.sessions).toHaveLength(1);
      expect(terminal(first).budget?.sessions).toHaveLength(33);
    } finally {
      budget.close();
    }
  });
});
