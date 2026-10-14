import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "../src/core/runtime";
import type {
  AgentRuntimeDependencies,
  LocalToolRegistry,
  ModelProvider,
  RunControl,
  SessionStore,
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

describe("runtime steering", () => {
  it("injects drained steering FIFO before the next provider request and persists it", async () => {
    const queue = ["  first steer  ", "second steer"];
    let providerUsers: string[] = [];
    let persistedUsers: string[] = [];
    let f!: ReturnType<typeof fixture>;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async (messages) => {
        providerUsers = users(messages);
        persistedUsers = users(f.current().messages);
        return { message: { role: "assistant", content: "done" } };
      },
    };
    f = fixture(provider);

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
      (message) => message.role === "tool" && message.tool_call_id === "inspect-once",
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
    expect(result.events.find((event) => event.type === "error")).toMatchObject({
      type: "error",
      error: { code: "invalid_input" },
    });
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

  it("counts steered follow-up requests against the normal turn budget", async () => {
    const queue: string[] = [];
    let completions = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async () => {
        completions += 1;
        return { message: { role: "assistant", content: "draft" } };
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

    expect(result.status).toBe("failed");
    expect(completions).toBe(1);
    expect(users(result.messages)).toEqual(["work", "one more turn"]);
    expect(result.events.find((event) => event.type === "error")).toMatchObject({
      type: "error",
      error: { code: "budget" },
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
    expect(parentRequests.some((request) => request.includes("root-only steering while child will run"))).toBe(
      true,
    );
    expect(JSON.stringify(childRequests)).not.toContain("root-only steering");
  });
});
