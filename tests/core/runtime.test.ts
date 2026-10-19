import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_SCALE_CEILING,
  CONTEXT_SCALE_FLOOR,
  compactContext,
  createAgentRuntime,
  seedContextScale,
} from "../../src/core/runtime";
import type {
  AgentRuntimeDependencies,
  LocalToolRegistry,
  ModelProvider,
  SessionStore,
} from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import { measureContext } from "../../src/shared/context-usage";
import {
  defaultPublicSettings,
  agentEventSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import type {
  AgentEvent,
  Message,
  SessionSnapshot,
} from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";

const initial = (): SessionSnapshot =>
  sessionSnapshotSchema.parse({
    version: 1,
    id: "12345678-1234-4234-8234-123456789abc",
    title: "Test",
    workspace: "/workspace",
    model: "chosen",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "idle",
    messages: [],
    events: [],
    changes: [],
  });
const fixture = (
  provider: ModelProvider,
  tools: LocalToolRegistry,
  state = initial(),
) => {
  let current = state;
  let locked = false;
  const checkpoints: SessionSnapshot[] = [];
  const store: SessionStore = {
    list: async () => [],
    get: async () => current,
    create: async () => current,
    save: async (snapshot) => {
      current = sessionSnapshotSchema.parse(snapshot);
      checkpoints.push(current);
    },
    acquire: async () => {
      if (locked) throw new ForgeError("busy", "Busy.");
      locked = true;
      return async () => {
        locked = false;
      };
    },
  };
  const deps: AgentRuntimeDependencies = {
    store,
    provider,
    tools,
    settings: defaultPublicSettings,
  };
  return {
    runtime: createAgentRuntime(deps),
    deps,
    checkpoints,
    current: () => current,
  };
};
const emptyTools: LocalToolRegistry = {
  definitions: [],
  execute: async () => ({ content: "ok", isError: false }),
  dispose: async () => undefined,
};
const finalProvider: ModelProvider = {
  listModels: async () => [],
  complete: async () => ({ message: { role: "assistant", content: "done" } }),
};
const call = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "inspect", arguments: "{}" },
});
const input = { sessionId: initial().id, prompt: "work" };
const signal = () => new AbortController().signal;
/** A persisted `context_usage` event; `used` is the local estimate for the turn. */
const usageEvent = (
  index: number,
  part: Readonly<{
    basis: "projected" | "request";
    used: number;
    prompt?: number;
  }>,
): AgentEvent =>
  agentEventSchema.parse({
    sessionId: initial().id,
    timestamp: `2026-01-01T00:00:0${index}.000Z`,
    type: "context_usage",
    usage: {
      windowTokens: 300000,
      usedTokens: part.used,
      estimated: true,
      basis: part.basis,
      ...(part.basis === "projected" ? { budgetTokens: 240000 } : {}),
      parts: { instructions: 0, memory: 0, conversation: part.used, tools: 0 },
      ...(part.prompt === undefined ? {} : { promptTokens: part.prompt }),
    },
  });

describe("original runtime", () => {
  it("projects edit previews out of provider requests but keeps stored tool evidence", async () => {
    const preview = "original-file-content".repeat(100);
    const state = initial();
    const messages: Message[] = [
      { role: "user", content: "previous task" },
      { role: "assistant", content: null, tool_calls: [{ id: "edit-1", type: "function", function: { name: "edit_file", arguments: '{"path":"a.ts","old_text":"a","new_text":"b"}' } }] },
      { role: "tool", tool_call_id: "edit-1", content: JSON.stringify({ content: '{"edited":true}', isError: false, changes: [{ path: "a.ts", kind: "modified", before: preview, after: preview + "b", truncated: false }] }) },
    ];
    let sent: readonly Message[] = [];
    const provider: ModelProvider = { ...finalProvider, complete: async incoming => {
      sent = incoming;
      return { message: { role: "assistant", content: "done" } };
    } };
    const f = fixture(provider, emptyTools, { ...state, messages });
    await f.runtime.run(input, () => {}, async () => false, signal());
    expect(JSON.stringify(sent)).not.toContain(preview);
    expect(JSON.stringify(sent)).toContain("previews omitted");
    expect(f.current().messages.find(m => m.role === "tool")?.content).toBe(messages[2]?.content);
  });
  it("checkpoints native calls before effects and retains final text, model and history", async () => {
    let completions = 0;
    const received: (readonly Message[])[] = [];
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages, _definitions, options) => {
        received.push(messages);
        options.onText("partial");
        completions += 1;
        return completions === 1
          ? {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [call("a")],
              },
            }
          : { message: { role: "assistant", content: "final" } };
      },
    };
    const tools: LocalToolRegistry = {
      ...emptyTools,
      execute: async () => {
        expect(f.current().pendingTool?.id).toBe("a");
        return {
          content: "checked",
          isError: false,
          changes: [
            {
              path: "x",
              kind: "created",
              before: null,
              after: "x",
              truncated: false,
            },
          ],
        };
      },
    };
    const f = fixture(provider, tools);
    const events: AgentEvent[] = [];
    const result = await f.runtime.run(
      { ...input, model: "override" },
      (event) => {
        events.push(event);
        throw new Error("observer");
      },
      async () => false,
      signal(),
    );
    expect(result.status).toBe("completed");
    const usageEvents = events.filter((event) => event.type === "context_usage").filter(event => event.usage.basis === "projected");
    expect(usageEvents.length).toBeGreaterThanOrEqual(received.length);
    for (const usageEvent of usageEvents) {
      expect(usageEvent.usage.windowTokens).toBe(300000);
      expect(usageEvent.usage.budgetTokens).toBe(240000);
      expect(usageEvent.usage.estimated).toBe(true);
      expect(Object.values(usageEvent.usage.parts).reduce((sum, value) => sum + value, 0))
        .toBe(usageEvent.usage.usedTokens);
    }
    expect(usageEvents[1]?.usage.parts.tools).toBeGreaterThan(0);
    expect(result.pendingTool).toBeUndefined();
    expect(result.changes).toHaveLength(1);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: "final",
    });
    expect(
      events.filter((event) => event.type === "run_finished"),
    ).toHaveLength(1);
    expect(f.current().events.at(-1)?.type).toBe("run_finished");
    await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
    );
    expect(f.current().model).toBe("override");
    expect(
      received.at(-1)?.filter((message) => message.role === "system"),
    ).toHaveLength(1);
    expect(
      received.at(-1)?.filter((message) => message.role === "user"),
    ).toHaveLength(2);
  });

  it.each([1, 20])(
    "completes beyond the legacy maxTurns setting of %i while retaining turn accounting",
    async (maxTurns) => {
      let completions = 0;
      let executions = 0;
      const f = fixture(
        {
          ...finalProvider,
          complete: async () => {
            completions += 1;
            if (completions > 26) throw new Error("Unexpected extra completion");
            return completions <= 25
              ? {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [call(`inspect-${completions}`)],
                  },
                }
              : { message: { role: "assistant", content: "done" } };
          },
        },
        {
          ...emptyTools,
          execute: async () => {
            executions += 1;
            return { content: "ok", isError: false };
          },
        },
      );
      const runtime = createAgentRuntime({
        ...f.deps,
        settings: { ...defaultPublicSettings, maxTurns },
      });

      const result = await runtime.run(
        input,
        () => undefined,
        async () => false,
        signal(),
      );

      expect(result.status).toBe("completed");
      expect(completions).toBe(26);
      expect(executions).toBe(25);
      expect(result.messages.at(-1)).toEqual({
        role: "assistant",
        content: "done",
      });
      expect(result.events.filter((event) => event.type === "error")).toEqual([]);
      expect(result.events.at(-1)).toMatchObject({
        type: "run_finished",
        status: "completed",
        turns: 26,
        toolCalls: 25,
      });
    },
  );

  it("still cancels a continuing run beyond the former default turn limit", async () => {
    const controller = new AbortController();
    let completions = 0;
    const f = fixture(
      {
        ...finalProvider,
        complete: async () => {
          completions += 1;
          if (completions === 25) controller.abort();
          if (completions > 25) throw new Error("Completion after cancellation");
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [call(`inspect-${completions}`)],
            },
          };
        },
      },
      emptyTools,
    );

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      controller.signal,
    );

    expect(result.status).toBe("cancelled");
    expect(completions).toBe(25);
    expect(result.events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "cancelled",
      turns: 25,
      toolCalls: 24,
    });
  });

  it.each(["running", "awaiting_approval"] as const)("recovers orphan multi-call messages from a %s session without executing them", async status => {
    let executions = 0;
    const orphan: SessionSnapshot = {
      ...initial(),
      status,
      pendingTool: call("a"),
      messages: [
        { role: "user", content: "old" },
        {
          role: "assistant",
          content: null,
          tool_calls: [call("a"), call("b")],
        },
      ],
    };
    const f = fixture(
      {
        ...finalProvider,
        complete: async (messages) => {
          expect(
            messages
              .filter((message) => message.role === "tool")
              .map((message) => message.tool_call_id),
          ).toEqual(["a", "b"]);
          expect(JSON.stringify(messages)).toContain(
            "inspect effects before retry",
          );
          return { message: { role: "assistant", content: "done" } };
        },
      },
      {
        ...emptyTools,
        execute: async () => {
          executions += 1;
          return { content: "bad", isError: false };
        },
      },
      orphan,
    );
    await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
    );
    expect(executions).toBe(0);
    expect(f.checkpoints[0]?.status).toBe("interrupted");
    expect(f.checkpoints[0]?.pendingTool?.id).toBe("a");
    expect(f.current().status).toBe("completed");
    expect(f.current().pendingTool).toBeUndefined();
    expect(f.current().messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["old", input.prompt]);
  });

  it("cancels mid-tool, preserves uncertain checkpoint and releases the lock", async () => {
    const controller = new AbortController();
    let enter = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const provider: ModelProvider = {
      ...finalProvider,
      complete: async () => ({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [call("a"), call("b")],
        },
      }),
    };
    let cleanup = (): void => undefined;
    const cleaned = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    const f = fixture(provider, {
      ...emptyTools,
      execute: async (_call, context) => {
        enter();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        await cleaned;
        throw new ForgeError("cancelled", "Cancelled after cleanup.");
      },
    });
    const running = f.runtime.run(
      input,
      () => undefined,
      async () => false,
      controller.signal,
    );
    await entered;
    await expect(
      f.runtime.run(
        input,
        () => undefined,
        async () => false,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "busy" });
    controller.abort();
    await expect(
      f.runtime.run(
        input,
        () => undefined,
        async () => false,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "busy" });
    expect(
      f.current().events.some((event) => event.type === "run_finished"),
    ).toBe(false);
    cleanup();
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.pendingTool?.id).toBe("a");
    expect(
      result.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(2);
    const release = await f.deps.store.acquire(input.sessionId);
    await release();
  });

  it("counts denied attempts and fails the tool budget with complete protocol", async () => {
    const f = fixture(
      {
        ...finalProvider,
        complete: async () => ({
          message: {
            role: "assistant",
            content: null,
            tool_calls: [call("a"), call("b")],
          },
        }),
      },
      {
        ...emptyTools,
        execute: async () => ({ content: "denied", isError: true }),
      },
    );
    const runtime = createAgentRuntime({
      ...f.deps,
      settings: { ...defaultPublicSettings, maxToolCalls: 1 },
    });
    const result = await runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
    );
    expect(result.status).toBe("failed");
    expect(result.events.find((event) => event.type === "error")).toMatchObject(
      { error: { code: "budget" } },
    );
    expect(
      result.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(2);
    expect(result.events.at(-1)).toMatchObject({
      type: "run_finished",
      toolCalls: 1,
    });
  });

  it("removes complete old turns, preserves system/current turn and rejects oversized minima", () => {
    const messages: readonly Message[] = [
      { role: "system", content: "stable" },
      { role: "user", content: "x".repeat(5000) },
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "assistant", content: "old final" },
      { role: "user", content: "current" },
    ];
    const compacted = compactContext(messages, 1000);
    expect(compacted.messages).toEqual([messages[0], messages[5]]);
    expect(compacted.removedMessages).toBe(4);
    expect(messages).toHaveLength(6);
    expect(() => compactContext(compacted.messages, 1)).toThrowError(
      ForgeError,
    );
  });
});

describe("runtime lifetime and long-turn projection", () => {
  it("joins real local approval checkpoint cleanup before terminal save and unlock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-approval-"));
    const tools = await createLocalToolRegistry(directory);
    const controller = new AbortController();
    let entered!: () => void;
    const approvalEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let checkpointEntered!: () => void;
    const checkpointWaiting = new Promise<void>((resolve) => {
      checkpointEntered = resolve;
    });
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const command = {
      id: "command",
      type: "function" as const,
      function: {
        name: "run_command",
        arguments: JSON.stringify({
          argv: ["node", "-e", "throw new Error('must not execute')"],
        }),
      },
    };
    const f = fixture(
      {
        ...finalProvider,
        complete: async () => ({
          message: { role: "assistant", content: null, tool_calls: [command] },
        }),
      },
      tools,
      { ...initial(), workspace: directory },
    );
    const originalSave = f.deps.store.save;
    let released = false;
    let writesAfterRelease = 0;
    const originalAcquire = f.deps.store.acquire;
    f.deps.store.acquire = async (...args) => {
      const release = await originalAcquire(...args);
      return async () => {
        released = true;
        await release();
      };
    };
    f.deps.store.save = async (snapshot) => {
      if (
        snapshot.events.at(-1)?.type === "state_changed" &&
        snapshot.status === "running"
      ) {
        checkpointEntered();
        await gate;
      }
      if (released) writesAfterRelease += 1;
      await originalSave(snapshot);
    };
    try {
      const running = f.runtime.run(
        { ...input, permission: "workspace" },
        () => undefined,
        () => {
          entered();
          return new Promise<boolean>(() => {}); // External UI need not honor abort.
        },
        controller.signal,
      );
      await approvalEntered;
      controller.abort();
      await checkpointWaiting;
      expect(released).toBe(false);
      expect(
        f.current().events.some((event) => event.type === "run_finished"),
      ).toBe(false);
      await expect(originalAcquire(input.sessionId)).rejects.toMatchObject({
        code: "busy",
      });
      unblock();
      expect((await running).status).toBe("cancelled");
      expect(f.current().status).toBe("cancelled");
      expect(f.current().events.at(-1)?.type).toBe("run_finished");
      expect(released).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writesAfterRelease).toBe(0);
    } finally {
      unblock();
      await tools.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds a single long turn without mutating history or breaking native pairing", () => {
    const messages: Message[] = [
      { role: "system", content: "stable instructions" },
      { role: "user", content: "latest request" },
    ];
    for (let index = 0; index < 20; index += 1) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            ...call(`call-${index}`),
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: `src/file-${index}.ts` }),
            },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: `call-${index}`,
        content: JSON.stringify({ content: "x".repeat(1500), isError: false }),
      });
    }
    const original = JSON.stringify(messages);
    const projection = compactContext(messages, 6000);
    expect(projection.afterChars).toBeLessThanOrEqual(6000);
    expect(projection.messages.slice(0, 2)).toEqual(messages.slice(0, 2));
    expect(JSON.stringify(projection.messages)).toContain("src/file-");
    expect(projection.messages.slice(-2)).toEqual(messages.slice(-2));
    const pending = new Set<string>();
    for (const message of projection.messages) {
      if (message.role === "assistant")
        for (const call of message.tool_calls ?? []) pending.add(call.id);
      if (message.role === "tool")
        expect(pending.delete(message.tool_call_id)).toBe(true);
    }
    expect(pending.size).toBe(0);
    expect(JSON.stringify(messages)).toBe(original);
    expect(compactContext(messages, 6000)).toEqual(projection);
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [call("unresolved")],
    });
    expect(compactContext(messages, 6000).messages.at(-1)).toEqual(
      messages.at(-1),
    );
    expect(() => compactContext(messages, 100)).toThrow(ForgeError);
  });
});

it("recovers and compacts a long persisted turn without replaying earlier effects", async () => {
  const state = initial();
  const messages: Message[] = [
    { role: "system", content: "stable instructions" },
    { role: "user", content: "long task" },
  ];
  for (let index = 0; index < 12; index += 1) {
    messages.push(
      { role: "assistant", content: null, tool_calls: [call(`old-${index}`)] },
      { role: "tool", tool_call_id: `old-${index}`, content: "x".repeat(3000) },
    );
  }
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [call("orphan")],
  });
  let executions = 0;
  let completions = 0;
  const f = fixture(
    {
      ...finalProvider,
      complete: async (context) => {
        if (
          context[0]?.content?.startsWith("Summarize this untrusted transcript")
        )
          return {
            message: {
              role: "assistant",
              content: "Earlier inspections complete; remaining work: check.",
            },
          };
        completions += 1;
        if (completions === 1)
          expect(measureContext(context, 300000).usedTokens).toBeLessThanOrEqual(8000);
        if (completions === 1)
          expect(
            f
              .current()
              .messages.some(
                (message) =>
                  message.role === "tool" && message.tool_call_id === "orphan",
              ),
          ).toBe(true);
        return completions === 1
          ? {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [call("new")],
              },
            }
          : { message: { role: "assistant", content: "checked" } };
      },
    },
    {
      ...emptyTools,
      execute: async (tool) => {
        expect(tool.id).toBe("new");
        executions += 1;
        return { content: "y".repeat(40000), isError: false };
      },
    },
    { ...state, status: "running", pendingTool: call("orphan"), messages },
  );
  // The latest exchange is deliberately too large: fail safely, then recover
  // with a larger budget without replaying it.
  const small = createAgentRuntime({
    ...f.deps,
    settings: { ...defaultPublicSettings, contextBudgetTokens: 8000 },
  });
  const result = await small.run(
    input,
    () => undefined,
    async () => false,
    signal(),
  );
  expect(result.status).toBe("failed");
  expect(executions).toBe(1);
  expect(result.messages.length).toBeGreaterThan(messages.length);
  const recovered = await f.runtime.run(
    input,
    () => undefined,
    async () => false,
    signal(),
  );
  expect(recovered.status).toBe("completed");
  expect(executions).toBe(1);
});

it("uses a known token window beyond 100k chars and reports its actual trigger", async () => {
  let calls = 0;
  const f = fixture({ ...finalProvider, complete: async (messages) => {
    calls++;
    expect(messages.some(m => m.content?.includes("x".repeat(150000)))).toBe(true);
    return { message: { role: "assistant", content: "done" } };
  } }, emptyTools);
  const result = await f.runtime.run({ ...input, model: "gpt-4o", prompt: "x".repeat(150000) }, () => {}, async () => false, signal());
  expect(result.status).toBe("completed");
  expect(calls).toBe(1);
  expect(result.contextSummary).toBeUndefined();
  expect(result.events.filter(e => e.type === "context_usage")).toEqual(expect.arrayContaining([
    expect.objectContaining({ usage: expect.objectContaining({ windowTokens: 128000, budgetTokens: 102400 }) }),
  ]));
});

it("summarizes old history while keeping three recent human turns in the real request", async () => {
  const messages: Message[] = [];
  for (let i = 0; i < 7; i++) messages.push({ role: "user", content: `request-${i}` }, { role: "assistant", content: "中".repeat(5000) });
  let summaryCalls = 0;
  let request: readonly Message[] = [];
  const f = fixture({ ...finalProvider, getModelContextWindow: async () => 32000, complete: async (incoming, definitions) => {
    if (!definitions.length) {
      summaryCalls++;
      return { message: { role: "assistant", content: JSON.stringify({ goal: "continue", constraints: [], decisions: [], completed: [], nextSteps: [], verification: [], uncertainties: [] }) } };
    }
    request = incoming;
    return { message: { role: "assistant", content: "done" } };
  } }, emptyTools, { ...initial(), messages });
  const result = await f.runtime.run(input, () => {}, async () => false, signal());
  expect(result.status).toBe("completed");
  expect(summaryCalls).toBeGreaterThan(0);
  expect(request.filter(m => m.role === "user").map(m => m.content)).toEqual(["request-5", "request-6", "work"]);
  expect(result.messages).toHaveLength(messages.length + 3); // inserted system, current user, response
  expect(result.contextSummary?.fallback).toBe(false);
});

it("seeds the estimate scale from recorded usage pairs and ignores unusable ones", () => {
  const usage = usageEvent;
  expect(seedContextScale([])).toBe(CONTEXT_SCALE_FLOOR);
  // A lone projected estimate with no following report cannot calibrate anything.
  expect(seedContextScale([usage(0, { basis: "projected", used: 1000 })])).toBe(CONTEXT_SCALE_FLOOR);
  // Two projected events in a row describe two estimates, not an observation.
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 1000 }),
    usage(1, { basis: "projected", used: 1400 }),
  ])).toBe(CONTEXT_SCALE_FLOOR);
  // 10000 estimated against 14000 really sent is a 1.4x error.
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 10000 }),
    usage(1, { basis: "request", used: 14000, prompt: 14000 }),
  ])).toBeCloseTo(1.4, 5);
  // The median resists one wild turn, and the result never leaves its bounds.
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 10000 }),
    usage(1, { basis: "request", used: 12000, prompt: 12000 }),
    usage(2, { basis: "projected", used: 10000 }),
    usage(3, { basis: "request", used: 15000, prompt: 15000 }),
    usage(4, { basis: "projected", used: 10000 }),
    usage(5, { basis: "request", used: 900000, prompt: 900000 }),
  ])).toBeCloseTo(1.5, 5);
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 10000 }),
    usage(1, { basis: "request", used: 1000, prompt: 1000 }),
  ])).toBe(CONTEXT_SCALE_FLOOR);
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 10000 }),
    usage(1, { basis: "request", used: 900000, prompt: 900000 }),
  ])).toBe(CONTEXT_SCALE_CEILING);
});

it("compacts a long run before the provider sees the oversized request", async () => {
  // The local heuristic under-counts CJK against the real tokenizer. Real usage
  // is simulated at 1.6x the local estimate, inside the recorded error
  // distribution, and the resumed session already records one such pair so the
  // run starts calibrated. Without calibration the raw estimate still fits the
  // budget, so these requests would leave Forge over the provider window.
  const window = 32000;
  const limit = Math.floor(window * 0.8);
  const realInputFor = (messages: readonly Message[]) => measureContext(messages, window).usedTokens * 1.6;
  const provider: ModelProvider = {
    ...finalProvider,
    getModelContextWindow: async () => window,
    complete: async (incoming, definitions) => {
      if (!definitions.length) return {
        message: { role: "assistant", content: JSON.stringify({ goal: "continue", constraints: [], decisions: [], completed: [], nextSteps: [], verification: [], uncertainties: [] }) },
      };
      // The provider's own view of this exact request must fit its real window.
      const realInput = realInputFor(incoming);
      expect(realInput).toBeLessThanOrEqual(limit);
      return { message: { role: "assistant", content: "done" }, usage: {
        promptTokens: Math.round(realInput), completionTokens: 1, totalTokens: Math.round(realInput) + 1,
      } };
    },
  };
  const messages: Message[] = [];
  for (let index = 0; index < 8; index += 1)
    messages.push(
      { role: "user", content: `request-${index}` },
      { role: "assistant", content: "中".repeat(1500) },
    );
  // A prior turn in this session recorded a 1.6x estimate error.
  const prior: AgentEvent[] = [
    usageEvent(0, { basis: "projected", used: 20000 }),
    usageEvent(1, { basis: "request", used: 32000, prompt: 32000 }),
  ];
  const f = fixture(provider, emptyTools, { ...initial(), messages, events: prior });
  const sent: number[] = [];
  const result = await f.runtime.run(
    { ...input, prompt: "中".repeat(2000) },
    event => { if (event.type === "context_usage" && event.usage.promptTokens !== undefined) sent.push(event.usage.promptTokens); },
    async () => false,
    signal(),
  );
  expect(result.status).toBe("completed");
  expect(sent.length).toBeGreaterThan(0);
  expect(Math.max(...sent)).toBeLessThanOrEqual(limit);
  expect(result.events.some(event => event.type === "context_compacted")).toBe(true);
  // The recorded history itself is never rewritten or reordered by compaction;
  // the only addition is the injected system instructions at the front.
  const history = result.messages.filter(message => message.role !== "system");
  const original = messages.filter(message => message.role !== "system");
  expect(history.slice(0, original.length)).toEqual(original);
});
