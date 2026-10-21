import { describe, expect, it, vi } from "vitest";
import { aggregateUsageStats, computeSessionUsage, createUsageStatsService } from "../src/core/usage-stats";
import { parseModelPrices } from "../src/core/model-pricing";
import type { SessionStore } from "../src/shared/contracts";
import { usageStatsDtoSchema } from "../src/shared/ipc";
import type { ProviderAttempt } from "../src/shared/model-access";
import { sessionIdSchema, type AgentEvent, type SessionSnapshot, type Usage } from "../src/shared/schemas";

const id = sessionIdSchema.parse("00000000-0000-0000-0000-000000000001");
const timestamp = (hour: number) => new Date(Date.UTC(2026, 9, 20, hour)).toISOString();
const usage: Usage = { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 30, totalTokens: 120 };
const start = (model: string, hour: number): AgentEvent => ({
  type: "run_started", sessionId: id, model, permission: "readonly", timestamp: timestamp(hour),
});
const finish = (hour: number, tokens?: Usage): AgentEvent => ({
  type: "run_finished", sessionId: id, status: "completed", turns: 1, toolCalls: 0,
  timestamp: timestamp(hour), ...(tokens ? { usage: tokens } : {}),
});
const attempt = (model: string, hour: number, extra: Partial<ProviderAttempt> = {}): AgentEvent => ({
  type: "provider_attempt", sessionId: id, timestamp: timestamp(hour),
  selection: { model, sourceId: "source", apiMode: "responses", attempt: 1, reason: "direct",
    outcome: "succeeded", timestamp: timestamp(hour), usage, ...extra },
});
const snapshot = (events: readonly AgentEvent[], overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  version: 1, id, title: "Model attribution", workspace: "/workspace/a", model: "current-unused-model",
  createdAt: timestamp(-100), updatedAt: timestamp(24), status: "completed", events, messages: [], changes: [], ...overrides,
});
const prices = parseModelPrices({ vendor: { models: {
  "model-a": { cost: { input: 3, output: 15, cache_read: 0.3 } },
  "model-b": { cost: { input: 1, output: 2, cache_read: 0.1 } },
  free: { cost: { input: 0, output: 0 } },
} } });
const serviceFor = (snapshots: readonly SessionSnapshot[]) => createUsageStatsService({
  list: async () => snapshots,
  get: async (sessionId: string) => snapshots.find(s => s.id === sessionId),
} as unknown as SessionStore, { getPrices: async () => prices });

function expectReconciled(stats: ReturnType<typeof aggregateUsageStats>) {
  for (const [field, totalField] of [
    ["totalTokens", "totalTokens"], ["promptTokens", "totalPromptTokens"],
    ["completionTokens", "totalCompletionTokens"], ["cachedTokens", "totalCachedTokens"],
  ] as const) {
    expect(stats.models.reduce((sum, model) => sum + model[field], 0)).toBe(stats[totalField]);
    expect(stats.daily.reduce((sum, day) => sum + day[field], 0)).toBe(stats[totalField]);
    expect(stats.topSessions.reduce((sum, session) => sum + session[field], 0)).toBe(stats[totalField]);
  }
  expect(usageStatsDtoSchema.safeParse(stats).success).toBe(true);
}

describe("model consumption accounting", () => {
  it("attributes legacy runs to their historical model, not the current session selection", async () => {
    const stats = await serviceFor([snapshot([
      start("model-a", 1), finish(2, usage),
      start("model-b", 3), finish(4, usage),
      start("model-a", 5), finish(6, usage),
    ])]).getUsageStats();
    expect(stats.models).toEqual([
      expect.objectContaining({ model: "model-a", totalTokens: 240, runCount: 2, sessionCount: 1,
        requestCount: 0, pricedRequestCount: 0, costIncomplete: true }),
      expect.objectContaining({ model: "model-b", totalTokens: 120, runCount: 1, sessionCount: 1 }),
    ]);
    expect(stats.models.every(model => model.estimatedCostUsd === undefined)).toBe(true);
    expect(stats.totalRuns).toBe(3);
    expectReconciled(stats);
  });

  it("keeps every actual routed model and exact cost bucket while preserving truncated price IDs", async () => {
    const totals = { promptTokens: 300, completionTokens: 60, cachedPromptTokens: 90, totalTokens: 360 };
    const stats = await serviceFor([snapshot([
      start("route-group", 1),
      attempt("cn:vendor/model-a", 2),
      attempt("relay/vendor/model-a", 3),
      attempt("model-b", 4),
      { type: "context_usage", sessionId: id, timestamp: timestamp(4), usage: { basis: "request", ...totals } } as AgentEvent,
      finish(5, totals),
    ])]).getUsageStats();
    expect(stats.totalTokens).toBe(360); // Not requests + context + run total.
    expect(stats.models.map(model => model.model).sort()).toEqual(["cn:vendor/model-a", "model-b", "relay/vendor/model-a"]);
    for (const model of stats.models) {
      expect(model).toMatchObject({ totalTokens: 120, requestCount: 1, pricedRequestCount: 1, costIncomplete: false });
      expect(model.estimatedCostUsd).toBeCloseTo(model.model === "model-b" ? 0.000113 : 0.000519, 10);
    }
    expect(stats.models.reduce((sum, model) => sum + (model.estimatedCostUsd ?? 0), 0))
      .toBeCloseTo(stats.requests!.reduce((sum, request) => sum + (request.estimatedCostUsd ?? 0), 0), 10);
    expectReconciled(stats);
  });

  it("includes request-only/ongoing usage and unknown models without making missing prices free", async () => {
    const stats = await serviceFor([snapshot([
      start("route", 1),
      attempt("model-a", 2, { outcome: "started", usage: undefined }),
      attempt("model-a", 3),
      attempt("unpriced", 4),
      attempt("failed-model", 5, { outcome: "failed", usage: undefined }),
      attempt("free", 6),
    ], { status: "running" })]).getUsageStats();
    expect(stats.totalTokens).toBe(360);
    expect(stats.requests).toHaveLength(4);
    expect(stats.models.find(model => model.model === "unpriced"))
      .toMatchObject({ totalTokens: 120, requestCount: 1, pricedRequestCount: 0, costIncomplete: true });
    expect(stats.models.find(model => model.model === "failed-model"))
      .toMatchObject({ totalTokens: 0, requestCount: 1, costIncomplete: true });
    expect(stats.models.find(model => model.model === "free"))
      .toMatchObject({ estimatedCostUsd: 0, pricedRequestCount: 1, costIncomplete: false });
    expect(stats.models.find(model => model.model === "unpriced")?.estimatedCostUsd).toBeUndefined();
    expectReconciled(stats);
  });

  it("retains uncovered legacy usage once and marks the known request subtotal as partial", async () => {
    const doubled = { promptTokens: 200, completionTokens: 40, cachedPromptTokens: 60, totalTokens: 240 };
    const stats = await serviceFor([snapshot([
      start("model-a", 1), attempt("model-a", 2), finish(3, doubled),
      start("model-a", 4), attempt("model-a", 5, { outcome: "failed", usage: undefined }), finish(6),
    ])]).getUsageStats();
    expect(stats.totalTokens).toBe(240);
    expect(stats.models).toEqual([expect.objectContaining({ model: "model-a", totalTokens: 240,
      requestCount: 2, pricedRequestCount: 1, costIncomplete: true, estimatedCostUsd: 0.000519,
      runCount: 2, sessionCount: 1 })]);
    expectReconciled(stats);
  });

  it("does not lose an interrupted legacy run when a new model run starts", () => {
    const stats = aggregateUsageStats([computeSessionUsage(snapshot([
      start("model-a", 1),
      { type: "context_usage", sessionId: id, timestamp: timestamp(2), usage: { basis: "request", ...usage } } as AgentEvent,
      start("model-b", 3), attempt("model-b", 4), finish(5, usage),
    ]))]);
    expect(stats.models.map(model => [model.model, model.totalTokens])).toEqual([["model-a", 120], ["model-b", 120]]);
    expectReconciled(stats);
  });

  it("filters models, tokens, daily totals and costs on the same timestamps in long-lived sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(timestamp(24));
    try {
      const current = snapshot([
        start("legacy-old", -60), finish(-59, usage),
        start("model-a", -30), attempt("model-a", -29), attempt("model-a", 2),
        finish(3, { promptTokens: 200, completionTokens: 40, cachedPromptTokens: 60, totalTokens: 240 }),
        start("model-b", 4), finish(5, usage),
      ]);
      const other = snapshot([start("other", 3), finish(4, usage)], {
        id: sessionIdSchema.parse("00000000-0000-0000-0000-000000000002"), workspace: "/workspace/b",
      });
      const stats = await serviceFor([current, other]).getUsageStats({ days: 1, workspace: "/workspace/a" });
      expect(stats.totalTokens).toBe(240);
      expect(stats.totalRuns).toBe(2);
      expect(stats.totalSessions).toBe(1);
      expect(stats.models.map(model => model.model)).toEqual(["model-a", "model-b"]);
      expect(stats.models[0]?.estimatedCostUsd).toBeCloseTo(0.000519, 10);
      expect(stats.requests).toHaveLength(1);
      expect(stats.daily).toHaveLength(1);
      expectReconciled(stats);
    } finally { vi.useRealTimers(); }
  });
});
