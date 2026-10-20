import { afterEach, expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import {
  aggregateRouteUsageStats,
  computeSessionUsage,
  routeUsageStats,
} from "../../src/core/usage-stats";
import { ProviderError } from "../../src/provider/errors";
import {
  createRouteState,
  createRoutedProvider,
} from "../../src/provider/routing";
import type {
  ApprovalHandler,
  LocalToolRegistry,
  ModelProvider,
  SessionStore,
} from "../../src/shared/contracts";
import type {
  ProviderAttempt,
  RouteGroup,
  RouteMember,
} from "../../src/shared/model-access";
import { routeGroupSchema } from "../../src/shared/model-access";
import {
  defaultPublicSettings,
  providerConfigSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import type {
  AgentEvent,
  ProviderResponse,
  PublicSettings,
} from "../../src/shared/schemas";

afterEach(() => {
  vi.useRealTimers();
});

const sessionId = "11111111-1111-4111-8111-111111111111";

const providerOf = (complete: ModelProvider["complete"]): ModelProvider => ({
  listModels: async () => [],
  complete,
});

const answer = (content: string, totalTokens?: number): ProviderResponse => ({
  message: { role: "assistant", content },
  ...(totalTokens === undefined
    ? {}
    : {
        usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens },
      }),
});

const toolCall = (id: string, name: string): ProviderResponse => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  },
});

function fixture(options: {
  readonly providers: readonly ModelProvider[];
  readonly strategy?: RouteGroup["strategy"];
  readonly sticky?: boolean;
  readonly apiMode?: ModelProvider["apiMode"];
  readonly settings?: PublicSettings;
  readonly approve?: ApprovalHandler;
  readonly execute?: LocalToolRegistry["execute"];
}) {
  const members: RouteMember[] = options.providers.map((_provider, index) => ({
    sourceId: `src-${index}`,
    model: `model-${index}`,
  }));
  const group = routeGroupSchema.parse({
    id: "group-1",
    label: "Primary",
    strategy: options.strategy ?? "order",
    ...(options.sticky === true ? { sticky: true } : {}),
    members,
  });
  const provider = createRoutedProvider({
    group,
    state: createRouteState(),
    ...(options.apiMode === undefined ? {} : { apiMode: options.apiMode }),
    resolve: (candidate) => {
      const index = members.findIndex(
        (member) => member.sourceId === candidate.sourceId,
      );
      const resolved = index < 0 ? undefined : options.providers[index];
      if (resolved === undefined)
        throw new Error("Fixture has no provider for the member");
      return {
        provider: resolved,
        config: providerConfigSchema.parse({
          baseUrl: "https://example.test/v1",
          apiKey: "sk-test-secret",
          apiMode: "chat-completions",
          requestTimeoutMs: 60_000,
        }),
      };
    },
  });
  let snapshot = sessionSnapshotSchema.parse({
    version: 1,
    id: sessionId,
    title: "Routed fixture",
    workspace: "/tmp",
    model: "same-model",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    events: [],
    changes: [],
  });
  const store: SessionStore = {
    list: async () => [],
    get: async () => snapshot,
    create: async () => snapshot,
    save: async (value) => {
      snapshot = sessionSnapshotSchema.parse(value);
    },
    acquire: async () => async () => {},
  };
  const tools: LocalToolRegistry = {
    definitions: [],
    execute:
      options.execute ?? (async () => ({ content: "ok", isError: false })),
    dispose: async () => {},
  };
  const runtime = createAgentRuntime({
    store,
    tools,
    provider,
    settings: options.settings ?? defaultPublicSettings,
  });
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  return {
    events,
    controller,
    snapshot: () => snapshot,
    run: () =>
      runtime.run(
        { sessionId: snapshot.id, prompt: "do work" },
        (event) => {
          events.push(event);
        },
        options.approve ?? (async () => false),
        controller.signal,
      ),
  };
}

const selections = (events: readonly AgentEvent[]): ProviderAttempt[] =>
  events.flatMap((event) =>
    event.type === "provider_attempt" ? [event.selection] : [],
  );

it("moves a routed turn to the next member only for a request that never ran, once per tool", async () => {
  vi.useFakeTimers();
  const seen: string[] = [];
  let secondCalls = 0;
  let executions = 0;
  const first = providerOf(async (_messages, _tools, request) => {
    seen.push(request.model);
    throw new ProviderError("network", "The provider connection failed.", true);
  });
  const second = providerOf(async (_messages, _tools, request) => {
    seen.push(request.model);
    secondCalls += 1;
    return secondCalls === 1
      ? toolCall("effect", "inspect")
      : answer("done", 5);
  });
  const run = fixture({
    providers: [first, second],
    execute: async () => {
      executions += 1;
      return { content: "one effect", isError: false };
    },
  });

  const running = run.run();
  await vi.runAllTimersAsync();
  await running;

  expect(seen).toEqual(["model-0", "model-1", "model-1"]);
  expect(executions).toBe(1);
  expect(run.snapshot().status).toBe("completed");
  expect(
    run.snapshot().messages.filter((message) => message.role === "tool"),
  ).toHaveLength(1);
  expect(
    run.events.filter((event) => event.type === "provider_retry"),
  ).toHaveLength(1);
  expect(
    selections(run.snapshot().events).map((selection) => [
      selection.sourceId,
      selection.attempt,
      selection.outcome,
    ]),
  ).toEqual([
    ["src-0", 0, "started"],
    ["src-0", 0, "failed"],
    ["src-1", 1, "started"],
    ["src-1", 1, "succeeded"],
    ["src-1", 0, "started"],
    ["src-1", 0, "succeeded"],
  ]);
  expect(
    run.events.findLast((event) => event.type === "run_finished"),
  ).toMatchObject({
    turns: 2,
    toolCalls: 1,
  });
});

it("never replays a routed attempt that already streamed partial output", async () => {
  vi.useFakeTimers();
  let secondCalls = 0;
  const first = providerOf(async (_messages, _tools, request) => {
    request.onText("half an answer");
    throw new ProviderError("protocol", "Incomplete fixture response.", true);
  });
  const second = providerOf(async () => {
    secondCalls += 1;
    return answer("must not run");
  });
  const run = fixture({ providers: [first, second] });

  const running = run.run();
  await vi.runAllTimersAsync();
  await running;

  expect(secondCalls).toBe(0);
  expect(run.snapshot().status).toBe("failed");
  expect(run.events.some((event) => event.type === "provider_retry")).toBe(
    false,
  );
  expect(
    selections(run.snapshot().events).map((selection) => selection.outcome),
  ).toEqual(["started", "failed"]);
  expect(
    run.events.findLast((event) => event.type === "run_finished"),
  ).toMatchObject({
    usageComplete: false,
  });
});

it("does not switch members when the run is cancelled during a routed attempt", async () => {
  vi.useFakeTimers();
  let secondCalls = 0;
  let cancelRun = (): void => undefined;
  const first = providerOf(async () => {
    cancelRun();
    throw new ProviderError("network", "The provider connection failed.", true);
  });
  const second = providerOf(async () => {
    secondCalls += 1;
    return answer("must not run");
  });
  const run = fixture({ providers: [first, second] });
  cancelRun = () => {
    run.controller.abort();
  };

  const running = run.run();
  await vi.runAllTimersAsync();
  await running;

  expect(secondCalls).toBe(0);
  expect(run.snapshot().status).toBe("cancelled");
  expect(
    selections(run.snapshot().events).map((selection) => selection.outcome),
  ).toEqual(["started", "failed"]);
});

it("does not replay a routed request after a hosted search started", async () => {
  vi.useFakeTimers();
  let secondCalls = 0;
  const first = providerOf(async (_messages, _tools, request) => {
    request.onWebSearch?.({ id: "search-1", status: "searching" });
    throw new ProviderError("network", "The provider connection failed.", true);
  });
  const second = providerOf(async () => {
    secondCalls += 1;
    return answer("must not run");
  });
  const run = fixture({
    providers: [first, second],
    apiMode: "responses",
    settings: { ...defaultPublicSettings, webSearch: "cached" },
    approve: async () => true,
  });

  const running = run.run();
  await vi.runAllTimersAsync();
  await running;

  expect(secondCalls).toBe(0);
  expect(run.snapshot().status).toBe("failed");
  expect(run.events.some((event) => event.type === "provider_retry")).toBe(
    false,
  );
});

it("spends one shared budget across group members and reports unknown failure cost", async () => {
  vi.useFakeTimers();
  let firstCalls = 0;
  let secondCalls = 0;
  const first = providerOf(async () => {
    firstCalls += 1;
    throw new ProviderError("network", "The provider connection failed.", true);
  });
  const second = providerOf(async () => {
    secondCalls += 1;
    throw new ProviderError("network", "The provider connection failed.", true);
  });
  const run = fixture({ providers: [first, second] });

  const running = run.run();
  await vi.runAllTimersAsync();
  await running;

  expect(firstCalls + secondCalls).toBe(6);
  expect(firstCalls).toBe(3);
  expect(secondCalls).toBe(3);
  expect(
    run.events.filter((event) => event.type === "provider_retry"),
  ).toHaveLength(5);
  expect(
    selections(run.snapshot().events)
      .filter((selection) => selection.outcome === "started")
      .map((selection) => selection.attempt),
  ).toEqual([0, 1, 2, 3, 4, 5]);
  expect(run.snapshot().status).toBe("failed");
  expect(routeUsageStats(run.snapshot().events)).toEqual([
    {
      groupId: "group-1",
      sourceId: "src-0",
      model: "model-0",
      apiMode: "chat-completions",
      attempts: 3,
      succeeded: 0,
      failed: 3,
      unknownUsage: 3,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    },
    {
      groupId: "group-1",
      sourceId: "src-1",
      model: "model-1",
      apiMode: "chat-completions",
      attempts: 3,
      succeeded: 0,
      failed: 3,
      unknownUsage: 3,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    },
  ]);
  for (const selection of selections(run.snapshot().events))
    if (selection.outcome === "failed")
      expect(selection).not.toHaveProperty("usage");
});

it("aggregates routed usage by group, source and credential without inventing cost", () => {
  const attempt = (
    selection: Partial<ProviderAttempt> &
      Pick<ProviderAttempt, "attempt" | "outcome" | "reason">,
    timestamp: string,
  ) => ({
    sessionId,
    type: "provider_attempt" as const,
    timestamp,
    selection: {
      sourceId: "src-a",
      model: "model-a",
      credentialId: "cred-1",
      apiMode: "chat-completions",
      groupId: "group-1",
      timestamp,
      ...selection,
    },
  });
  const snapshot = sessionSnapshotSchema.parse({
    version: 1,
    id: sessionId,
    title: "Routed usage",
    workspace: "/tmp",
    model: "model-a",
    status: "failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    changes: [],
    events: [
      attempt(
        { attempt: 0, outcome: "started", reason: "order:first" },
        "2026-01-01T00:00:01.000Z",
      ),
      attempt(
        { attempt: 0, outcome: "failed", reason: "order:first" },
        "2026-01-01T00:00:02.000Z",
      ),
      attempt(
        { attempt: 1, outcome: "started", reason: "usage" },
        "2026-01-01T00:00:03.000Z",
      ),
      attempt(
        {
          attempt: 1,
          outcome: "succeeded",
          reason: "usage",
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        },
        "2026-01-01T00:00:04.000Z",
      ),
      {
        sessionId,
        type: "run_finished",
        status: "failed",
        turns: 1,
        toolCalls: 0,
        timestamp: "2026-01-01T00:00:05.000Z",
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      },
    ],
  });

  const computed = computeSessionUsage(snapshot);

  expect(computed.stat.totalTokens).toBe(12);
  expect(computed.routing).toEqual([
    {
      groupId: "group-1",
      sourceId: "src-a",
      credentialId: "cred-1",
      model: "model-a",
      apiMode: "chat-completions",
      attempts: 2,
      succeeded: 1,
      failed: 1,
      unknownUsage: 1,
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 0,
      totalTokens: 12,
    },
  ]);
  expect(aggregateRouteUsageStats([computed, computed])[0]).toMatchObject({
    attempts: 4,
    succeeded: 2,
    failed: 2,
    unknownUsage: 2,
    totalTokens: 24,
  });
});
