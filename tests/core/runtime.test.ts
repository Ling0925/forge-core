import { createDiffPatch } from "../../src/shared/diff";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
import { executionTurns } from "../../src/shared/execution";

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

function editEvidence(format: "legacy previews" | "patch") {
  const before = "original-file-content".repeat(200);
  const after = "replacement-file-content".repeat(200);
  const change = { path: "a.ts", kind: "modified", ...(format === "patch"
    ? { patch: createDiffPatch(before, after) }
    : { before, after, truncated: false }) };
  const evidence = JSON.stringify({ content: '{"edited":true}', isError: false, changes: [change] });
  const toolCall = { id: "edit-1", type: "function" as const, function: { name: "edit_file", arguments: '{"path":"a.ts","old_text":"a","new_text":"b"}' } };
  const messages: Message[] = [
    { role: "user", content: "previous task" },
    { role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "read_file", arguments: '{"path":"other.ts"}' } }] },
    { role: "tool", tool_call_id: "read-1", content: "unrelated evidence stays intact" },
    { role: "assistant", content: null, tool_calls: [toolCall] },
    { role: "tool", tool_call_id: toolCall.id, content: evidence },
  ];
  return { before, after, evidence, toolCall, messages };
}

describe("original runtime", () => {
  it("publishes a turn only after its prompt and boundary are checkpointed together", async () => {
    const f = fixture(finalProvider, emptyTools);
    const observed: boolean[] = [];
    await f.runtime.run(input, event => {
      if (event.type === "run_started") observed.push(f.current().events.some(saved => saved.type === "run_started" && saved.turn === event.turn));
    }, async () => false, signal());
    expect(observed).toEqual([true]);
    expect(f.checkpoints.filter(state => state.messages.some(message => message.role === "user"))
      .every(state => state.events.some(event => event.type === "run_started"))).toBe(true);
  });

  it("keeps a provider retry and multiple tools inside one step, then starts the next turn at step one", async () => {
    let requests = 0;
    const f = fixture({ ...finalProvider, complete: async () => {
      requests++;
      if (requests === 1) throw Object.assign(new ForgeError("provider", "Transient", true), { classification: "network" });
      return requests === 2
        ? { message: { role: "assistant", content: null, tool_calls: [call("a"), call("b"), call("c")] } }
        : { message: { role: "assistant", content: "done" } };
    } }, emptyTools);
    const first = await f.runtime.run(input, () => {}, async () => false, signal());
    expect(first.events.filter(event => event.type === "step_started").map(event => [event.turn, event.step])).toEqual([[1, 1], [1, 2]]);
    expect(first.events.filter(event => event.type === "step_finished").map(event => [event.turn, event.step, event.status])).toEqual([[1, 1, "completed"], [1, 2, "completed"]]);
    expect(first.events.find(event => event.type === "provider_retry")).toMatchObject({ turn: 1, step: 1 });
    expect(first.events.at(-1)).toMatchObject({ turns: 2, turn: 1, steps: 2, toolCalls: 3, retries: 1 });
    const resumed = await f.runtime.run({ ...input, prompt: "next task" }, () => {}, async () => false, signal());
    expect(resumed.events.filter(event => event.type === "step_started").at(-1)).toMatchObject({ turn: 2, step: 1 });
    expect(executionTurns(resumed).map(turn => [turn.turn, turn.steps, turn.toolCalls, turn.retries])).toEqual([[1, 2, 3, 1], [2, 1, 0, 0]]);
  });

  it("retains steering inside the current turn and records the next model step", async () => {
    let requests = 0;
    const queued: string[] = [];
    const f = fixture({ ...finalProvider, complete: async () => {
      requests++;
      if (requests === 1) queued.push("also inspect this");
      return { message: { role: "assistant", content: "done" } };
    } }, emptyTools);
    const result = await f.runtime.run(input, () => {}, async () => false, signal(), {
      drainSteering: () => queued.splice(0),
    });
    expect(result.messages.filter(message => message.role === "user")).toHaveLength(2);
    expect(executionTurns(result)).toHaveLength(1);
    expect(executionTurns(result)[0]).toMatchObject({ turn: 1, steps: 2, toolCalls: 0 });
  });

  it.each(["cancelled", "failed"] as const)("closes an entered step exactly once when %s", async status => {
    const controller = new AbortController();
    const f = fixture({ ...finalProvider, complete: async () => {
      if (status === "cancelled") controller.abort();
      throw new ForgeError("provider", "Stopped");
    } }, emptyTools);
    const result = await f.runtime.run(input, () => {}, async () => false, controller.signal);
    expect(result.events.filter(event => event.type === "step_finished")).toHaveLength(1);
    expect(result.events.find(event => event.type === "step_finished")).toMatchObject({ turn: 1, step: 1, status });
    expect(result.events.at(-1)).toMatchObject({ status, steps: 1 });
  });

  it("repairs an interrupted open step before entering a new turn without replaying tools", async () => {
    const base = initial();
    const state = sessionSnapshotSchema.parse({ ...base, status: "running",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "old task" }],
      events: [
        { type: "run_started", sessionId: base.id, timestamp: base.createdAt, turn: 1, messageIndex: 1, model: "chosen", permission: "readonly" },
        { type: "step_started", sessionId: base.id, timestamp: base.createdAt, turn: 1, step: 1, messageIndex: 2 },
      ],
    });
    const f = fixture(finalProvider, emptyTools, state);
    const result = await f.runtime.run(input, () => {}, async () => false, signal());
    expect(result.events.filter(event => event.type === "step_finished").map(event => [event.turn, event.status])).toEqual([[1, "interrupted"], [2, "completed"]]);
    expect(result.events.filter(event => event.type === "run_finished").map(event => [event.turn, event.status, event.steps])).toEqual([[1, "interrupted", 1], [2, "completed", 1]]);
  });

  it.each(["legacy previews", "patch"] as const)("projects edit previews out of provider requests with native associations (%s)", async format => {
    const original = editEvidence(format);
    // Make omission assertions non-vacuous for both stored formats.
    expect(original.evidence).toContain(original.before);
    expect(original.evidence).toContain(original.after);
    const requests: (readonly Message[])[] = [];
    const provider: ModelProvider = { ...finalProvider, complete: async incoming => {
      requests.push(incoming);
      return { message: { role: "assistant", content: "done" } };
    } };
    const f = fixture(provider, emptyTools, { ...initial(), messages: original.messages });
    expect((await f.runtime.run(input, () => {}, async () => false, signal())).status).toBe("completed");
    expect(requests).toHaveLength(1);
    const sent = requests[0] ?? [];
    const results = sent.filter(message => message.role === "tool" && message.tool_call_id === original.toolCall.id);
    expect(results).toHaveLength(1);
    const result = results[0]; if (!result || result.role !== "tool") throw new Error("Missing projected tool result");
    const projected = JSON.parse(result.content);
    expect(projected).toMatchObject({ content: '{"edited":true}', isError: false, changes: [{ path: "a.ts", kind: "modified" }], contextNote: expect.stringMatching(/\S/) });
    expect(projected.changes).toHaveLength(1);
    for (const key of ["before", "after", "patch"]) expect(projected.changes[0]).not.toHaveProperty(key);
    expect(JSON.stringify(sent)).not.toContain(original.before);
    expect(JSON.stringify(sent)).not.toContain(original.after);
    const callIndex = sent.findIndex(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === original.toolCall.id));
    const resultIndex = sent.indexOf(result);
    const currentPromptIndex = sent.findIndex(message => message.role === "user" && message.content === input.prompt);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(sent[callIndex]).toMatchObject({ tool_calls: [original.toolCall] });
    expect(resultIndex).toBe(callIndex + 1);
    expect(currentPromptIndex).toBeGreaterThan(resultIndex);
    expect(sent.find(message => message.role === "tool" && message.tool_call_id === "read-1")).toEqual(original.messages[2]);
  });

  it.each(["legacy previews", "patch"] as const)("retains original stored tool evidence independently of request projection (%s)", async format => {
    const original = editEvidence(format);
    const originalBytes = JSON.stringify(original.messages);
    const f = fixture(finalProvider, emptyTools, { ...initial(), messages: original.messages });
    const result = await f.runtime.run(input, () => {}, async () => false, signal());
    expect(result.status).toBe("completed");
    expect(f.checkpoints.length).toBeGreaterThan(0);
    for (const snapshot of [...f.checkpoints, result, f.current()]) {
      const stored = snapshot.messages.filter(message => message.role === "tool" && message.tool_call_id === original.toolCall.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.content).toBe(original.evidence);
      expect(stored[0]?.content).toContain(original.before);
      expect(stored[0]?.content).toContain(original.after);
    }
    expect(JSON.stringify(original.messages)).toBe(originalBytes);
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
      generationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
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
        generationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
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

  it("counts denied attempts without enforcing a legacy tool budget", async () => {
    let requests = 0;
    const f = fixture(
      {
        ...finalProvider,
        complete: async () => ++requests === 1 ? ({
          message: {
            role: "assistant",
            content: null,
            tool_calls: [call("a"), call("b")],
          },
        }) : ({ message: { role: "assistant", content: "done" } }),
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
    expect(result.status).toBe("completed");
    expect(result.events.find((event) => event.type === "error")).toBeUndefined();
    expect(
      result.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(2);
    expect(result.events.at(-1)).toMatchObject({
      type: "run_finished",
      toolCalls: 2,
      budget: { consumed: 2, remaining: null },
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
          timeout_ms: 2000,
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

it.each([
  { reported: 1000000, override: undefined, window: 1000000, budget: 800000 },
  { reported: 1000000, override: 64000, window: 64000, budget: 51200 },
  { reported: null, override: undefined, window: 300000, budget: 240000 },
])("uses the configured window and reserve, falling back to 300K only when unknown: $window", async ({ reported, override, window, budget }) => {
  let metadataReads = 0;
  const f = fixture({ ...finalProvider, getModelContextWindow: async () => { metadataReads++; return reported; } }, emptyTools);
  const runtime = createAgentRuntime({ ...f.deps, settings: {
    ...defaultPublicSettings,
    ...(override === undefined ? {} : { modelContextWindows: { chosen: override } }),
  } });
  const result = await runtime.run(input, () => {}, async () => false, signal());
  expect(result.status).toBe("completed");
  expect(metadataReads).toBe(override === undefined ? 1 : 0);
  for (const event of result.events.filter(event => event.type === "context_usage")) {
    expect(event.usage).toMatchObject({ windowTokens: window, budgetTokens: budget });
  }
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
  // The latest real input must not be hidden by an older median or a 2x cap.
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 10000 }),
    usage(1, { basis: "request", used: 12000, prompt: 12000 }),
    usage(2, { basis: "projected", used: 10000 }),
    usage(3, { basis: "request", used: 15000, prompt: 15000 }),
    usage(4, { basis: "projected", used: 10000 }),
    usage(5, { basis: "request", used: 40000, prompt: 40000 }),
  ])).toBe(4);
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 10000 }),
    usage(1, { basis: "request", used: 1000, prompt: 1000 }),
  ])).toBe(CONTEXT_SCALE_FLOOR);
  expect(seedContextScale([
    usage(0, { basis: "projected", used: 10000 }),
    usage(1, { basis: "request", used: 900000, prompt: 900000 }),
  ])).toBe(90);
});

it("does not reuse calibration across model changes, compaction or mismatched requests", () => {
  const start = (model: string): AgentEvent => agentEventSchema.parse({
    type: "run_started", sessionId: initial().id, timestamp: initial().createdAt, model, permission: "readonly",
  });
  const projected = usageEvent(0, { basis: "projected", used: 10000 });
  const reported = usageEvent(1, { basis: "request", used: 40000, prompt: 40000 });
  const old = [start("a"), projected, reported];
  expect(seedContextScale(old, "a")).toBe(4);
  expect(seedContextScale([...old, start("a")], "a")).toBe(4);
  expect(seedContextScale(old, "b")).toBe(CONTEXT_SCALE_FLOOR);
  expect(seedContextScale([...old, start("b")], "b")).toBe(CONTEXT_SCALE_FLOOR);
  const compacted: AgentEvent = agentEventSchema.parse({
    type: "context_compacted", sessionId: initial().id, timestamp: initial().updatedAt,
    removedMessages: 2, beforeChars: 10000, afterChars: 1000,
  });
  expect(seedContextScale([...old, compacted, reported], "a")).toBe(CONTEXT_SCALE_FLOOR);
  expect(seedContextScale([{ ...projected, step: 1 }, { ...reported, step: 2 }])).toBe(CONTEXT_SCALE_FLOOR);
});

it("restores calibration from real step events instead of requiring adjacent usage records", async () => {
  const f = fixture({ ...finalProvider, complete: async (messages, definitions) => {
    const promptTokens = measureContext(messages, 300000, definitions).usedTokens * 2;
    return { message: { role: "assistant", content: "done" },
      usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 } };
  } }, emptyTools);

  const result = await f.runtime.run(input, () => {}, async () => false, signal());

  expect(result.status).toBe("completed");
  expect(seedContextScale(result.events)).toBe(2);
});

it("applies newly observed calibration before the next generation in the same run", async () => {
  const previous: Message[] = [
    { role: "user", content: "prior request" },
    { role: "assistant", content: "x".repeat(6000) },
  ];
  const sent: number[] = [];
  const f = fixture({ ...finalProvider, complete: async (messages, definitions) => {
    if (!definitions.length) return { message: { role: "assistant", content: JSON.stringify({
      goal: "continue", constraints: [], decisions: [], completed: [], nextSteps: [], verification: [], uncertainties: [],
    }) } };
    const promptTokens = measureContext(messages, 64000, definitions).usedTokens * 2;
    sent.push(promptTokens);
    return { message: sent.length === 1
      ? { role: "assistant", content: null, tool_calls: [call("inspect")] }
      : { role: "assistant", content: "done" },
      usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 } };
  } }, { ...emptyTools, execute: async () => ({ content: "x".repeat(6000), isError: false }) },
  { ...initial(), messages: previous });
  const runtime = createAgentRuntime({ ...f.deps,
    settings: { ...defaultPublicSettings, modelContextWindows: { chosen: 64000 }, contextBudgetTokens: 12000 } });

  const result = await runtime.run(input, () => {}, async () => false, signal());

  expect(result.status).toBe("completed");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBeLessThanOrEqual(12000);
  expect(result.events.some(event => event.type === "context_compacted")).toBe(true);
  expect(result.messages.filter(message => message.role !== "system").slice(0, 2)).toEqual(previous);
});

it.each(["tool continuation", "resumed session"])("honors input above the 300K reserve despite a >2x estimate error: %s", async (mode) => {
  const previous: Message[] = [
    { role: "user", content: "prior task" },
    { role: "assistant", content: "x".repeat(280000) },
  ];
  const sent: number[] = [];
  let summaries = 0;
  let executions = 0;
  const f = fixture({ ...finalProvider, complete: async (messages, definitions) => {
    if (!definitions.length) {
      summaries++;
      return { message: { role: "assistant", content: JSON.stringify({
        goal: "continue", constraints: [], decisions: [], completed: [], nextSteps: [], verification: [], uncertainties: [],
      }) } };
    }
    const promptTokens = measureContext(messages, 300000, definitions).usedTokens * 4;
    sent.push(promptTokens);
    return { message: sent.length === 1 && mode === "tool continuation"
      ? { role: "assistant", content: null, tool_calls: [call("once")] }
      : { role: "assistant", content: "done" },
      usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 } };
  } }, { ...emptyTools, execute: async () => {
    executions++;
    return { content: "small result", isError: false };
  } }, { ...initial(), messages: previous });

  let result = await f.runtime.run(input, () => {}, async () => false, signal());
  if (mode === "resumed session") result = await f.runtime.run(input, () => {}, async () => false, signal());

  expect(result.status).toBe("completed");
  expect(sent).toHaveLength(2);
  expect(sent[0]).toBeGreaterThan(240000);
  expect(sent[1]).toBeLessThanOrEqual(240000);
  expect(summaries).toBeGreaterThan(0);
  expect(executions).toBe(mode === "tool continuation" ? 1 : 0);
  expect(result.contextSummary).toBeDefined();
  expect(result.events.some(event => event.type === "context_compacted")).toBe(true);
  expect(result.messages.filter(message => message.role !== "system").slice(0, 2)).toEqual(previous);
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
