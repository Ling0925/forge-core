import { expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type {
  LocalToolRegistry,
  ModelProvider,
  SessionStore,
} from "../../src/shared/contracts";
import {
  defaultPublicSettings,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import type { AgentEvent, SessionSnapshot } from "../../src/shared/schemas";

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

const emptyTools: LocalToolRegistry = {
  definitions: [],
  execute: async () => ({ content: "ok", isError: false }),
  dispose: async () => undefined,
};

it("forwards live reasoning events and persists reasoning on the saved assistant message", async () => {
  let current = initial();
  const store: SessionStore = {
    list: async () => [],
    get: async () => current,
    create: async () => current,
    save: async (snapshot) => {
      current = sessionSnapshotSchema.parse(snapshot);
    },
    acquire: async () => async () => {},
  };
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (_messages, _definitions, options) => {
      options.onReasoning?.("thinking hard ");
      options.onReasoning?.("about the answer");
      options.onText("answer");
      return {
        message: { role: "assistant", content: "answer", reasoning: "thinking hard about the answer" },
      };
    },
  };
  const runtime = createAgentRuntime({
    store,
    provider,
    tools: emptyTools,
    settings: defaultPublicSettings,
  });
  const events: AgentEvent[] = [];
  const result = await runtime.run(
    { sessionId: initial().id, prompt: "go" },
    (event) => events.push(event),
    async () => false,
    new AbortController().signal,
  );
  const reasoning = events.filter((event) => event.type === "reasoning_delta");
  expect(reasoning.length).toBeGreaterThan(0);
  expect(reasoning.map((event) => event.text).join("")).toContain("thinking hard");
  // Live reasoning is a transient event, not durable event-log state.
  expect(result.events.some((event) => event.type === "reasoning_delta")).toBe(false);
  expect(current.events.some((event) => event.type === "reasoning_delta")).toBe(false);
  // The reasoning is persisted on the saved assistant message for a resumed view.
  const assistant = result.messages.find((message) => message.role === "assistant");
  expect(assistant?.role === "assistant" && assistant.reasoning).toBe("thinking hard about the answer");
  // The durable store snapshot carries it too, so a fresh load sees it.
  const stored = current.messages.find((message) => message.role === "assistant");
  expect(stored?.role === "assistant" && stored.reasoning).toBe("thinking hard about the answer");
  expect(assistant?.content).toBe("answer");
  // It is display-only metadata, never folded into the assistant content.
  expect(result.messages.some((message) => message.content?.includes("thinking hard"))).toBe(false);
});
