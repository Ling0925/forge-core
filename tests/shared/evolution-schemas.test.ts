import { expect, it } from "vitest";
import {
  approvalRequestSchema,
  assistantMessageSchema,
  providerConfigSchema,
  providerStateSchema,
  runInputSchema,
  sessionSnapshotSchema,
  taskPlanSchema,
  toolDefinitionSchema,
} from "../../src/shared/schemas";
it("accepts legacy snapshots and enforces plan invariants", () => {
  const old = {
    version: 1,
    id: "12345678-1234-4234-8234-123456789abc",
    title: "old",
    workspace: "/workspace",
    model: "model",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    messages: [],
    events: [],
    changes: [],
  };
  expect(sessionSnapshotSchema.parse(old).plan).toBeUndefined();
  expect(
    runInputSchema.parse({ sessionId: old.id, prompt: "plan", mode: "plan" })
      .mode,
  ).toBe("plan");
  expect(taskPlanSchema.safeParse({ explanation: "", steps: [] }).success).toBe(
    false,
  );
  expect(
    providerConfigSchema.parse({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
      requestTimeoutMs: 1000,
      apiMode: "responses",
    }).apiMode,
  ).toBe("responses");
  expect(
    providerConfigSchema.parse({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "",
      requestTimeoutMs: 1000,
    }).apiMode,
  ).toBeUndefined();
});

it("bounds opaque continuation and keeps child provenance only in approval envelopes", () => {
  const state = {
    version: 1,
    apiMode: "responses",
    baseUrl: "https://example.invalid/v1",
    model: "actual",
    output: [{ type: "reasoning", id: "r" }],
  };
  expect(
    assistantMessageSchema.parse({
      role: "assistant",
      content: "ok",
      providerState: state,
    }).providerState,
  ).toEqual(state);
  expect(
    assistantMessageSchema.parse({ role: "assistant", content: "old" })
      .providerState,
  ).toBeUndefined();
  expect(
    providerStateSchema.safeParse({
      ...state,
      baseUrl: "https://user:password@example.invalid/v1",
    }).success,
  ).toBe(false);
  expect(
    providerStateSchema.safeParse({
      ...state,
      output: Array.from({ length: 257 }, () => ({ type: "message" })),
    }).success,
  ).toBe(false);
  expect(
    providerStateSchema.safeParse({
      ...state,
      output: [{ text: "界".repeat(90000) }],
    }).success,
  ).toBe(false);
  const id = "12345678-1234-4234-8234-123456789abc";
  expect(
    toolDefinitionSchema.safeParse({
      type: "function",
      function: {
        name: "test",
        description: "d",
        parameters: {},
        childSessionId: id,
      },
    }).success,
  ).toBe(false);
  expect(
    approvalRequestSchema.parse({
      id,
      sessionId: id,
      childSessionId: id,
      toolCallId: "call",
      toolName: "run_command",
      description: "child",
    }).childSessionId,
  ).toBe(id);
});
