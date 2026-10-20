import { describe, expect, it, vi } from "vitest";
import { aggregateUsageStats, computeSessionUsage, createUsageStatsService, sessionRequestRecords } from "../src/core/usage-stats";
import type { SessionStore } from "../src/shared/contracts";
import { usageStatsDtoSchema } from "../src/shared/ipc";
import type { ProviderAttempt } from "../src/shared/model-access";
import { sessionIdSchema, type AgentEvent, type SessionSnapshot } from "../src/shared/schemas";

const sessionId = sessionIdSchema.parse("00000000-0000-0000-0000-000000000001");
const time = (second: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, second)).toISOString();
const usage = { promptTokens: 100, completionTokens: 20, cachedPromptTokens: 30, totalTokens: 120 };
const attempt = (outcome: ProviderAttempt["outcome"], second: number,
  selection: Partial<ProviderAttempt> = {}, step = 1): Extract<AgentEvent, { type: "provider_attempt" }> => ({
  type: "provider_attempt", sessionId, timestamp: time(second), turn: 1, step,
  selection: { sourceId: "source-a", credentialId: "default", model: "exact/model", apiMode: "responses",
    attempt: 1, reason: "direct", outcome, timestamp: time(second), ...selection },
});
const run = (type: "run_started" | "run_finished", second: number): AgentEvent => type === "run_started"
  ? { type, sessionId, timestamp: time(second), model: "selected-model", permission: "readonly" }
  : { type, sessionId, timestamp: time(second), status: "completed", turns: 1, toolCalls: 0 };
const snapshot = (events: readonly AgentEvent[], overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  version: 1, id: sessionId, title: "Request fixture", workspace: "/workspace/a", model: "selected-model",
  createdAt: time(0), updatedAt: time(60), status: "completed", messages: [], changes: [], events, ...overrides,
});

describe("individual usage request records", () => {
  it("pairs start/result once and keeps repeated attempts separate across steps and runs", () => {
    const computed = computeSessionUsage(snapshot([
      run("run_started", 0), attempt("started", 1), attempt("succeeded", 3, { usage }),
      attempt("started", 4, {}, 2), attempt("succeeded", 5, { usage }, 2), run("run_finished", 6),
      run("run_started", 7), attempt("started", 8), attempt("succeeded", 10, { usage }), run("run_finished", 11),
    ]));
    expect(computed.requests).toHaveLength(3);
    expect(computed.requests[0]).toMatchObject({
      id: `${sessionId}:1`, sessionId, sessionTitle: "Request fixture", sourceId: "source-a",
      model: "exact/model", credentialId: "default", apiMode: "responses", reason: "direct",
      outcome: "succeeded", timestamp: time(1), startedAt: time(1), finishedAt: time(3), durationMs: 2000, usage,
    });
    expect(computed.requests.map(item => item.durationMs)).toEqual([2000, 1000, 2000]);
    expect(new Set(computed.requests.map(item => item.id)).size).toBe(3);
    expect(computed.routing[0]?.attempts).toBe(3);
    const stats = aggregateUsageStats([computed]);
    expect(stats.requests?.map(item => item.timestamp)).toEqual([time(8), time(4), time(1)]);
    expect(usageStatsDtoSchema.parse(stats).requests).toEqual(stats.requests);
    // This projection does not count provider_attempt usage again in run totals.
    expect(stats.totalTokens).toBe(0);
  });

  it("retains each retry's actual route, credential, model, error and unknown usage", () => {
    const records = sessionRequestRecords(snapshot([
      attempt("started", 0, { groupId: "group", reason: "order:first" }),
      attempt("failed", 1, { groupId: "group", reason: "order:first", errorCode: "rate_limit" }),
      attempt("started", 2, { groupId: "group", sourceId: "source-b", credentialId: "other", model: "model-b", attempt: 2 }),
      attempt("succeeded", 4, { groupId: "group", sourceId: "source-b", credentialId: "other", model: "model-b", attempt: 2, usage }),
    ]));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ outcome: "failed", errorCode: "rate_limit", reason: "order:first", durationMs: 1000 });
    expect(records[0]).not.toHaveProperty("usage");
    expect(records[1]).toMatchObject({ sourceId: "source-b", credentialId: "other", model: "model-b", attempt: 2, usage });
  });

  it("does not invent start times, durations or tokens when an event is missing", () => {
    const records = sessionRequestRecords(snapshot([
      attempt("succeeded", 1, { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
      attempt("started", 2), run("run_finished", 3),
      run("run_started", 4), attempt("failed", 5, { errorCode: "cancelled" }),
    ]));
    expect(records).toHaveLength(3);
    expect(records[0]).not.toHaveProperty("startedAt");
    expect(records[0]).not.toHaveProperty("durationMs");
    expect(records[0]?.usage?.totalTokens).toBe(0);
    expect(records[1]).toMatchObject({ outcome: "unknown", startedAt: time(2) });
    expect(records[1]).not.toHaveProperty("finishedAt");
    expect(records[1]).not.toHaveProperty("usage");
    expect(records[2]).toMatchObject({ outcome: "failed", finishedAt: time(5), errorCode: "cancelled" });
    expect(records[2]).not.toHaveProperty("durationMs");
  });

  it("marks only the current outstanding request as in progress", () => {
    const events = [attempt("started", 0), run("run_finished", 1), run("run_started", 2), attempt("started", 3)];
    expect(sessionRequestRecords(snapshot(events, { status: "running" })).map(item => item.outcome)).toEqual(["unknown", "started"]);
    expect(sessionRequestRecords(snapshot(events, { status: "interrupted" })).map(item => item.outcome)).toEqual(["unknown", "unknown"]);
    const stepBoundary: AgentEvent = { type: "step_started", sessionId, timestamp: time(1), turn: 1, step: 2, messageIndex: 0 };
    expect(sessionRequestRecords(snapshot([attempt("started", 0), stepBoundary, attempt("started", 2, {}, 2)], { status: "running" }))
      .map(item => item.outcome)).toEqual(["unknown", "started"]);
  });

  it("filters request time, not the time the enclosing session was last updated", () => {
    vi.useFakeTimers();
    vi.setSystemTime(time(86400));
    try {
      const old = { timestamp: time(-86400) };
      const first = computeSessionUsage(snapshot([
        attempt("started", 0, old), attempt("succeeded", 0, { ...old, usage }),
        attempt("started", 10), attempt("succeeded", 20, { usage }),
      ], { updatedAt: time(86400) }));
      const other = computeSessionUsage(snapshot([attempt("succeeded", 30, { usage })], {
        id: sessionIdSchema.parse("00000000-0000-0000-0000-000000000002"), workspace: "/workspace/b", updatedAt: time(86400),
      }));
      const all = aggregateUsageStats([first, other]);
      expect(all.requests).toHaveLength(3);
      const filtered = aggregateUsageStats([first, other], { days: 1, workspace: "/workspace/a" });
      expect(filtered.requests).toHaveLength(1);
      expect(filtered.requests?.[0]?.timestamp).toBe(time(10));
    } finally { vi.useRealTimers(); }
  });

  it("keeps the service cache fresh and supports snapshots with no attempt events", async () => {
    let current = snapshot([attempt("started", 0)], { status: "running" });
    const get = vi.fn(async () => current);
    const store = { list: async () => [current], get } as unknown as SessionStore;
    const service = createUsageStatsService(store);
    expect((await service.getUsageStats()).requests?.[0]?.outcome).toBe("started");
    await service.getUsageStats();
    expect(get).toHaveBeenCalledTimes(1);
    current = snapshot([attempt("started", 0), attempt("succeeded", 2, { usage })], { updatedAt: time(61) });
    expect((await service.getUsageStats()).requests?.[0]?.outcome).toBe("succeeded");
    expect(get).toHaveBeenCalledTimes(2);
    // A freshly opened service rebuilds the same rows from persisted events.
    expect((await createUsageStatsService(store).getUsageStats()).requests).toEqual((await service.getUsageStats()).requests);
    expect(aggregateUsageStats([computeSessionUsage(snapshot([]))]).requests).toEqual([]);
  });

  it("projects metadata only, omitting conversation and arbitrary upstream material", () => {
    const withExtra = { ...attempt("succeeded", 0, { usage }),
      selection: { ...attempt("succeeded", 0).selection, usage, body: "PRIVATE_BODY", apiKey: "PRIVATE_KEY" },
    } as AgentEvent;
    const records = sessionRequestRecords(snapshot([withExtra], {
      messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
    }));
    const serialized = JSON.stringify(records);
    expect(serialized).not.toMatch(/PRIVATE_BODY|PRIVATE_KEY|PRIVATE_PROMPT/);
    expect(records[0]?.usage).toEqual(usage);
  });
});
