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

it("forwards reasoning as a transient display event and never persists it", async () => {
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
      return { message: { role: "assistant", content: "answer" } };
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
  // Persisted transcript and event log must not contain the ephemeral preview.
  expect(result.messages.some((message) => message.content?.includes("thinking hard"))).toBe(false);
  expect(result.events.some((event) => event.type === "reasoning_delta")).toBe(false);
  expect(current.events.some((event) => event.type === "reasoning_delta")).toBe(false);
});
