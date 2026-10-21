import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../src/core/harness";
import { createAgentRuntime } from "../src/core/runtime";
import type {
  AgentRuntimeDependencies,
  LocalToolRegistry,
  ModelProvider,
  RunControl,
  SessionStore,
  SteeringHandler,
} from "../src/shared/contracts";
import { ForgeError } from "../src/shared/errors";
import {
  defaultPublicSettings,
  sessionIdSchema,
  sessionSnapshotSchema,
} from "../src/shared/schemas";
import type {
  Message,
  PublicSettings,
  SessionId,
  SessionSnapshot,
  ToolCall,
} from "../src/shared/schemas";

const ROOT_ID = sessionIdSchema.parse("12345678-1234-4234-8234-123456789abc");

const initial = (): SessionSnapshot =>
  sessionSnapshotSchema.parse({
    version: 1,
    id: ROOT_ID,
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

const call = (id: string, name = "inspect", args = {}): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const emptyTools: LocalToolRegistry = {
  definitions: [],
  execute: async () => ({ content: "ok", isError: false }),
  dispose: async () => undefined,
};

const users = (messages: readonly Message[]): string[] =>
  messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);

const assistantTexts = (messages: readonly Message[]): string[] =>
  messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content ?? "");

const controlFor = (queue: string[]): RunControl => ({
  drainSteering: () => queue.splice(0),
});

const signal = (): AbortSignal => new AbortController().signal;
const input = { sessionId: ROOT_ID, prompt: "work" };

type FixtureOptions = Readonly<{
  state?: SessionSnapshot;
  settings?: PublicSettings;
  onSave?: (snapshot: SessionSnapshot) => void;
}>;

const fixture = (
  provider: ModelProvider,
  tools: LocalToolRegistry = emptyTools,
  options: FixtureOptions = {},
) => {
  const root = options.state ?? initial();
  const sessions = new Map<SessionId, SessionSnapshot>([[root.id, root]]);
  const locks = new Set<SessionId>();
  const checkpoints: SessionSnapshot[] = [];
  const store: SessionStore = {
    list: async () => [...sessions.values()],
    get: async (id) => {
      const snapshot = sessions.get(id);
      if (!snapshot) throw new ForgeError("not_found", "Session not found.");
      return snapshot;
    },
    create: async ({ workspace, title, model }) => {
      const snapshot = sessionSnapshotSchema.parse({
        version: 1,
        id: sessionIdSchema.parse(randomUUID()),
        title,
        workspace,
        model,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        status: "idle",
        messages: [],
        events: [],
        changes: [],
      });
      sessions.set(snapshot.id, snapshot);
      return snapshot;
    },
    save: async (snapshot) => {
      const parsed = sessionSnapshotSchema.parse(snapshot);
      sessions.set(parsed.id, parsed);
      if (parsed.id === root.id) checkpoints.push(parsed);
      options.onSave?.(parsed);
    },
    acquire: async (id) => {
      if (locks.has(id)) throw new ForgeError("busy", "Busy.");
      locks.add(id);
      return async () => {
        locks.delete(id);
      };
    },
  };
  const deps: AgentRuntimeDependencies = {
    store,
    provider,
    tools,
    settings: options.settings ?? defaultPublicSettings,
  };
  return {
    runtime: createAgentRuntime(deps),
    deps,
    checkpoints,
    current: (id: SessionId = root.id) => {
      const snapshot = sessions.get(id);
      if (!snapshot) throw new ForgeError("not_found", "Session not found.");
      return snapshot;
    },
  };
};

function liveControl() {
  let handler: SteeringHandler | undefined;
  const control: RunControl = {
    drainSteering: () => [],
    setSteeringHandler: value => { handler = value; },
  };
  return {
    control,
    send: (value: Parameters<SteeringHandler>[0]) => {
      if (!handler) throw new Error("Steering is not open");
      return handler(value);
    },
    isOpen: () => !!handler,
  };
}

const gate = () => {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

describe("immediate runtime steering", () => {
  it("recovers the durable inbox after an interrupted tool exchange without replaying the tool", async () => {
    const requests: (readonly Message[])[] = [];
    const f = fixture({ listModels: async () => [], complete: async messages => {
      requests.push(messages); return { message: { role: "assistant", content: "done" } };
    } }, emptyTools, { state: { ...initial(), status: "running",
      messages: [{ role: "user", content: "old task" }, { role: "assistant", content: null, tool_calls: [call("old")] }],
      pendingSteering: [{ role: "user", content: "already accepted" }],
    } });
    const result = await f.runtime.run(input, () => {}, async () => true, signal());
    expect(result.status).toBe("completed");
    expect(users(requests[0] ?? [])).toEqual(["old task", "already accepted", "work"]);
    expect(requests[0]?.filter(message => message.role === "tool")).toHaveLength(1);
    expect(result.pendingSteering).toBeUndefined();
    expect(users(result.messages).filter(text => text === "already accepted")).toHaveLength(1);
  });
  it.each([false, true])("saves during model/tool flight, keeps tool exchanges intact and retains messages on cancel=%s", async (cancel) => {
    const model = gate();
    const tool = gate();
    const abort = new AbortController();
    const live = liveControl();
    const requests: (readonly Message[])[] = [];
    let executions = 0;
    const f = fixture({
      listModels: async () => [],
      complete: async messages => {
        requests.push([...messages]);
        if (requests.length === 1) {
          await model.promise;
          return { message: { role: "assistant", content: null, tool_calls: [call("once")] } };
        }
        return { message: { role: "assistant", content: "done" } };
      },
    }, {
      ...emptyTools,
      execute: async () => { executions++; await tool.promise; return { content: "ok", isError: false }; },
    });
    const work = f.runtime.run(input, () => {}, async () => true, abort.signal, live.control);
    try {
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await live.send("during provider");
      expect(users([...f.current().messages, ...(f.current().pendingSteering ?? [])])).toEqual(["work", "during provider"]);
      expect(users(requests[0] ?? [])).toEqual(["work"]);
      model.release();
      await vi.waitFor(() => expect(executions).toBe(1));
      await Promise.all([live.send("during tool"), live.send("last constraint")]);
      expect(users([...f.current().messages, ...(f.current().pendingSteering ?? [])])).toEqual(["work", "during provider", "during tool", "last constraint"]);
      expect(requests).toHaveLength(1);
      if (cancel) abort.abort();
      tool.release();
      const result = await work;
      expect(result.status).toBe(cancel ? "cancelled" : "completed");
      expect(executions).toBe(1);
      expect(requests).toHaveLength(cancel ? 1 : 2);
      const transcript = cancel ? result.messages : requests[1] ?? [];
      const toolIndex = transcript.findIndex(message => message.role === "assistant" && message.tool_calls?.length);
      expect(transcript.slice(toolIndex, toolIndex + 5).map(message => message.role)).toEqual([
        "assistant", "tool", "user", "user", "user",
      ]);
      expect(users(result.messages)).toEqual(["work", "during provider", "during tool", "last constraint"]);
      expect(f.current().messages).toEqual(result.messages);
      expect(live.isOpen()).toBe(false);
    } finally { model.release(); tool.release(); abort.abort(); await work; }
  });

  it("does not acknowledge a failed write or leak its input through a later checkpoint", async () => {
    const model = gate();
    const live = liveControl();
    let entered = false;
    const requests: string[][] = [];
    const f = fixture({
      listModels: async () => [],
      complete: async messages => {
        entered = true;
        requests.push(users(messages));
        await model.promise;
        return { message: { role: "assistant", content: "done" } };
      },
    });
    const store: SessionStore = {
      ...f.deps.store,
      save: async snapshot => {
        if (users(snapshot.pendingSteering ?? []).includes("rejected input")) throw new Error("disk full");
        await f.deps.store.save(snapshot);
      },
    };
    const runtime = createAgentRuntime({ ...f.deps, store });
    const work = runtime.run(input, () => {}, async () => true, signal(), live.control);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await live.send("accepted first");
      await expect(live.send("rejected input")).rejects.toThrow("checkpoint");
      await live.send("accepted last");
      expect(users([...f.current().messages, ...(f.current().pendingSteering ?? [])])).toEqual(["work", "accepted first", "accepted last"]);
      model.release();
      const result = await work;
      expect(users(result.messages)).toEqual(["work", "accepted first", "accepted last"]);
      expect(requests).toEqual([["work"], ["work", "accepted first", "accepted last"]]);
    } finally { model.release(); await work; }
  });

  it("acknowledges only after the write completes and joins it when cancellation races the save", async () => {
    const model = gate();
    const commit = gate();
    const live = liveControl();
    const abort = new AbortController();
    let entered = false;
    let saving = false;
    let acknowledged = false;
    const f = fixture({
      listModels: async () => [],
      complete: async () => {
        entered = true;
        await model.promise;
        return { message: { role: "assistant", content: "done" } };
      },
    });
    const runtime = createAgentRuntime({ ...f.deps, store: {
      ...f.deps.store,
      save: async snapshot => {
        if (!saving && users(snapshot.pendingSteering ?? []).includes("save before stopping")) {
          saving = true;
          await commit.promise;
        }
        await f.deps.store.save(snapshot);
      },
    } });
    const work = runtime.run(input, () => {}, async () => true, abort.signal, live.control);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const sent = live.send("save before stopping").then(() => { acknowledged = true; });
      await vi.waitFor(() => expect(saving).toBe(true));
      expect(acknowledged).toBe(false);
      expect(users([...f.current().messages, ...(f.current().pendingSteering ?? [])])).toEqual(["work"]);
      abort.abort();
      commit.release();
      await sent;
      expect(acknowledged).toBe(true);
      const result = await work;
      expect(result.status).toBe("cancelled");
      expect(users(result.messages)).toEqual(["work", "save before stopping"]);
      expect(f.current().messages).toEqual(result.messages);
    } finally { commit.release(); model.release(); abort.abort(); await work; }
  });

  it("includes durable steering in a retry request without duplicating it after the response", async () => {
    const live = liveControl();
    let retrying = false;
    const requests: string[][] = [];
    const f = fixture({
      listModels: async () => [],
      complete: async messages => {
        requests.push(users(messages));
        if (requests.length === 1)
          throw Object.assign(new ForgeError("provider", "temporary network error", true), { classification: "network" });
        return { message: { role: "assistant", content: "done" } };
      },
    });
    const work = f.runtime.run(input, event => { if (event.type === "provider_retry") retrying = true; },
      async () => true, signal(), live.control);
    await vi.waitFor(() => expect(retrying).toBe(true));
    await live.send("new constraint before retry");
    expect((await work).status).toBe("completed");
    expect(requests).toEqual([["work"], ["work", "new constraint before retry"]]);
    expect(users([...f.current().messages, ...(f.current().pendingSteering ?? [])])).toEqual(["work", "new constraint before retry"]);
  });

  it("includes steering received during hosted-search approval in the very next request", async () => {
    const approval = gate();
    const live = liveControl();
    let approving = false;
    const requests: string[][] = [];
    const f = fixture({
      apiMode: "responses",
      listModels: async () => [],
      complete: async messages => {
        requests.push(users(messages));
        return { message: { role: "assistant", content: "done" } };
      },
    });
    const work = f.runtime.run({ ...input, permission: "workspace" }, () => {}, async () => {
      approving = true;
      await approval.promise;
      return true;
    }, signal(), live.control);
    try {
      await vi.waitFor(() => expect(approving).toBe(true));
      await live.send("only use official sources");
      expect(requests).toHaveLength(0);
      expect(users([...f.current().messages, ...(f.current().pendingSteering ?? [])])).toEqual(["work", "only use official sources"]);
      approval.release();
      expect((await work).status).toBe("completed");
      expect(requests).toEqual([["work", "only use official sources"]]);
    } finally { approval.release(); await work; }
  });
});

describe("runtime steering", () => {
  it("injects drained steering FIFO before the next provider request and persists it", async () => {
    const queue = ["  first steer  ", "second steer"];
    let providerUsers: string[] = [];
    let persistedUsers: string[] = [];
    let savedMessages: readonly Message[] = [];
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages) => {
        providerUsers = users(messages);
        persistedUsers = users(savedMessages);
        return { message: { role: "assistant", content: "done" } };
      },
    };
    const f = fixture(provider, emptyTools, {
      onSave: (snapshot) => {
        savedMessages = snapshot.messages;
      },
    });

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
      controlFor(queue),
    );

    expect(result.status).toBe("completed");
    expect(providerUsers).toEqual(["work", "first steer", "second steer"]);
    expect(persistedUsers).toEqual(providerUsers);
    expect(users(result.messages)).toEqual(providerUsers);
    expect(queue).toEqual([]);
  });

  it("holds provider/tool-flight steering until tool results close the exchange and does not replay tools", async () => {
    const queue: string[] = [];
    const providerRequests: string[][] = [];
    let completions = 0;
    let executions = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages) => {
        completions += 1;
        providerRequests.push(users(messages));
        if (completions === 1) {
          queue.push("queued while provider was in flight");
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [call("inspect-once")],
            },
          };
        }
        return { message: { role: "assistant", content: "final" } };
      },
    };
    const tools: LocalToolRegistry = {
      ...emptyTools,
      execute: async () => {
        executions += 1;
        queue.push("queued while tool was in flight");
        return { content: "tool result", isError: false };
      },
    };
    const f = fixture(provider, tools);

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
      controlFor(queue),
    );

    expect(result.status).toBe("completed");
    expect(completions).toBe(2);
    expect(executions).toBe(1);
    expect(providerRequests).toEqual([
      ["work"],
      [
        "work",
        "queued while provider was in flight",
        "queued while tool was in flight",
      ],
    ]);
    const assistantIndex = result.messages.findIndex(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );
    const toolIndex = result.messages.findIndex(
      (message) =>
        message.role === "tool" && message.tool_call_id === "inspect-once",
    );
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBe(assistantIndex + 1);
    expect(result.messages.slice(assistantIndex + 1, toolIndex)).toEqual([]);
    expect(users(result.messages)).toEqual(providerRequests[1]);
  });

  it("drains once more after a no-tool response is persisted before finishing", async () => {
    const queue: string[] = [];
    let completions = 0;
    let steeredAfterDraft = false;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async () => {
        completions += 1;
        return completions === 1
          ? { message: { role: "assistant", content: "draft final" } }
          : { message: { role: "assistant", content: "revised final" } };
      },
    };
    const f = fixture(provider, emptyTools, {
      onSave: (snapshot) => {
        if (
          !steeredAfterDraft &&
          snapshot.id === ROOT_ID &&
          snapshot.messages.at(-1)?.role === "assistant" &&
          snapshot.messages.at(-1)?.content === "draft final"
        ) {
          steeredAfterDraft = true;
          queue.push("revise after seeing the final response");
        }
      },
    });

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
      controlFor(queue),
    );

    expect(result.status).toBe("completed");
    expect(completions).toBe(2);
    expect(users(result.messages)).toEqual([
      "work",
      "revise after seeing the final response",
    ]);
    expect(assistantTexts(result.messages)).toEqual([
      "draft final",
      "revised final",
    ]);
    expect(result.events.at(-1)).toMatchObject({ type: "run_finished" });
  });

  it("validates every steered prompt and does not call the provider for invalid steering", async () => {
    let completions = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async () => {
        completions += 1;
        return { message: { role: "assistant", content: "should not run" } };
      },
    };
    const f = fixture(provider);

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
      controlFor(["   "]),
    );

    expect(result.status).toBe("failed");
    expect(completions).toBe(0);
    expect(users(result.messages)).toEqual(["work"]);
    expect(result.events.find((event) => event.type === "error")).toMatchObject(
      {
        type: "error",
        error: { code: "invalid_input" },
      },
    );
  });

  it("does not drain or consume steering when cancellation is already requested", async () => {
    const queue = ["keep this for a later run"];
    let drains = 0;
    const controller = new AbortController();
    controller.abort();
    const f = fixture({
      listModels: async () => [],
      complete: async () => {
        throw new Error("provider must not be called");
      },
    });

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      controller.signal,
      {
        drainSteering: () => {
          drains += 1;
          return queue.splice(0);
        },
      },
    );

    expect(result.status).toBe("cancelled");
    expect(drains).toBe(0);
    expect(queue).toEqual(["keep this for a later run"]);
  });

  it("continues steered follow-up requests past the legacy turn limit", async () => {
    const queue: string[] = [];
    let completions = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async () => {
        completions += 1;
        if (completions > 2) throw new Error("Unexpected extra completion");
        return {
          message: {
            role: "assistant",
            content: completions === 1 ? "draft" : "final",
          },
        };
      },
    };
    const f = fixture(provider, emptyTools, {
      settings: { ...defaultPublicSettings, maxTurns: 1 },
      onSave: (snapshot) => {
        if (
          snapshot.id === ROOT_ID &&
          snapshot.messages.at(-1)?.role === "assistant" &&
          snapshot.messages.at(-1)?.content === "draft"
        )
          queue.push("one more turn");
      },
    });

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
      controlFor(queue),
    );

    expect(result.status).toBe("completed");
    expect(completions).toBe(2);
    expect(users(result.messages)).toEqual(["work", "one more turn"]);
    expect(assistantTexts(result.messages)).toEqual(["draft", "final"]);
    expect(result.events.filter((event) => event.type === "error")).toEqual([]);
    expect(result.events.at(-1)).toMatchObject({
      type: "run_finished",
      turns: 2,
      toolCalls: 0,
    });
  });

  it("does not let child agents inherit root steering input", async () => {
    const queue: string[] = [];
    const parentRequests: string[][] = [];
    const childRequests: string[][] = [];
    let parentCalls = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages) => {
        const requestUsers = users(messages);
        if (requestUsers.some((content) => content.startsWith("child task"))) {
          childRequests.push(requestUsers);
          return { message: { role: "assistant", content: "child done" } };
        }
        parentCalls += 1;
        parentRequests.push(requestUsers);
        if (parentCalls === 1) {
          queue.push("root-only steering while child will run");
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                call("spawn", "spawn_agent", {
                  task: "child task",
                  ownership: "child-owned files only",
                  model: "chosen",
                }),
              ],
            },
          };
        }
        return { message: { role: "assistant", content: "parent done" } };
      },
    };
    const f = fixture(provider);

    const result = await f.runtime.run(
      input,
      () => undefined,
      async () => false,
      signal(),
      controlFor(queue),
    );

    expect(result.status).toBe("completed");
    expect(childRequests).toHaveLength(1);
    expect(childRequests[0]).toEqual([
      "child task\nOwnership: child-owned files only",
    ]);
    expect(
      parentRequests.some((request) =>
        request.includes("root-only steering while child will run"),
      ),
    ).toBe(true);
    expect(JSON.stringify(childRequests)).not.toContain("root-only steering");
  });
});

describe("harness steering", () => {
  it("forwards optional run control to the runtime", async () => {
    const state = await mkdtemp(join(tmpdir(), "forge-steering-state-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "forge-steering-workspace-"),
    );
    const queue = ["steered through harness"];
    const providerRequests: string[][] = [];
    const service = await createHarness({
      stateDir: state,
      providerFactory: (): ModelProvider => ({
        listModels: async () => ["fixture-model"],
        complete: async (messages) => {
          providerRequests.push(users(messages));
          return { message: { role: "assistant", content: "done" } };
        },
      }),
      toolFactory: async () => emptyTools,
    });
    try {
      await service.updateSettings({
        apiKey: "fixture-key",
        settings: {
          baseUrl: "http://127.0.0.1:1",
          model: "fixture-model",
        },
      });
      const session = await service.createSession({ workspace, title: "manual" });

      const result = await service.run(
        { sessionId: session.id, prompt: "work" },
        () => undefined,
        async () => false,
        signal(),
        controlFor(queue),
      );

      expect(result.status).toBe("completed");
      expect(providerRequests).toEqual([["work", "steered through harness"]]);
      expect(users(result.messages)).toEqual([
        "work",
        "steered through harness",
      ]);
      expect(queue).toEqual([]);
    } finally {
      await service.dispose();
      await rm(state, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
