import { expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type { ModelProvider, SessionStore } from "../../src/shared/contracts";
import {
  type Message,
  type SessionSnapshot,
  type ToolDefinition,
  defaultPublicSettings,
  sessionIdSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";

// Regression: every step's system prompt must describe the same delegation
// capability as the tool list sent with it (fixed per-step rebuild that
// dropped canDelegate and fell back to "is the primary agent").
const parentId = sessionIdSchema.parse("22345678-1234-4234-8234-123456789abc");
const snapshot = (id: string, parent?: string): SessionSnapshot =>
  sessionSnapshotSchema.parse({
    version: 1,
    id,
    title: "delegation",
    workspace: "/workspace",
    model: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "idle",
    messages: [],
    events: [],
    changes: [],
    ...(parent ? { parentSessionId: parent, agentTask: "inspect" } : {}),
  });

async function requests(maxAgentDepth: number, child: boolean) {
  const sessions = new Map<string, SessionSnapshot>([
    [parentId, snapshot(parentId)],
  ]);
  const id = sessionIdSchema.parse("12345678-1234-4234-8234-123456789abc");
  sessions.set(id, snapshot(id, child ? parentId : undefined));
  const store: SessionStore = {
    list: async () => [...sessions.values()],
    get: async (key) => {
      const found = sessions.get(key);
      if (!found) throw new Error("missing");
      return found;
    },
    create: async () => {
      throw new Error("unused");
    },
    save: async (next) => {
      sessions.set(next.id, sessionSnapshotSchema.parse(next));
    },
    acquire: async () => async () => {},
  };
  const seen: { system: string; tools: string[] }[] = [];
  let turn = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages: readonly Message[], tools) => {
      const system = messages.find((message) => message.role === "system");
      seen.push({
        system: typeof system?.content === "string" ? system.content : "",
        tools: (tools ?? []).map((tool) => tool.function.name),
      });
      return turn++ === 0
        ? {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "noop", arguments: "{}" },
                },
              ],
            },
          }
        : { message: { role: "assistant", content: "done" } };
    },
  };
  const noop: ToolDefinition = {
    type: "function",
    function: {
      name: "noop",
      description: "No effect.",
      parameters: { type: "object", properties: {} },
    },
  };
  await createAgentRuntime({
    store,
    provider,
    settings: { ...defaultPublicSettings, maxAgentDepth },
    tools: {
      definitions: [noop],
      execute: async () => ({ content: "ok", isError: false }),
      dispose: async () => {},
    },
  }).run(
    { sessionId: id, prompt: "go", permission: "readonly" },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  return seen;
}

it("tells a delegating child it may delegate on every step, matching spawn_agent", async () => {
  const seen = await requests(2, true);
  expect(seen).toHaveLength(2);
  for (const request of seen) {
    expect(request.tools).toContain("spawn_agent");
    expect(request.system).toContain("delegate only bounded parts");
    expect(request.system).not.toContain("do not spawn further agents");
  }
});

it("keeps a child at the depth limit without delegation tools or guidance on every step", async () => {
  const seen = await requests(1, true);
  expect(seen).toHaveLength(2);
  for (const request of seen) {
    expect(request.tools).not.toContain("spawn_agent");
    expect(request.system).toContain("do not spawn further agents");
    expect(request.system).not.toContain("# Delegation");
  }
});

it("keeps primary-agent delegation guidance on every step", async () => {
  const seen = await requests(1, false);
  for (const request of seen) {
    expect(request.tools).toContain("spawn_agent");
    expect(request.system).toContain("# Delegation");
  }
});
