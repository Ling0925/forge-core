import { describe, expect, it } from "vitest";
import {
  aggregateUsageStats,
  computeSessionUsage,
  createUsageStatsService,
} from "../src/core/usage-stats";
import type { SessionSnapshot } from "../src/shared/schemas";

function createMockSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: 1,
    id: "00000000-0000-0000-0000-000000000001",
    title: "Test Session",
    workspace: "/test/workspace",
    model: "test-model-1",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T12:00:00.000Z",
    status: "completed",
    messages: [],
    events: [
      {
        sessionId: "00000000-0000-0000-0000-000000000001",
        type: "run_started",
        model: overrides.model ?? "test-model-1",
        permission: "read_only",
        prompt: "Hello",
        timestamp: "2025-01-01T10:00:00.000Z",
      },
      {
        sessionId: "00000000-0000-0000-0000-000000000001",
        type: "context_usage",
        usage: {
          basis: "request",
          promptTokens: 100,
          completionTokens: 20,
          cachedPromptTokens: 30,
        },
      },
      {
        sessionId: "00000000-0000-0000-0000-000000000001",
        type: "run_finished",
        status: "completed",
        timestamp: "2025-01-01T10:01:00.000Z",
        usage: {
          promptTokens: 100,
          completionTokens: 25,
          totalTokens: 125,
          cachedPromptTokens: 40,
        },
      },
    ],
    changes: [],
    ...overrides,
  };
}

describe("usage-stats", () => {
  it("computes session usage correctly from events", () => {
    const snapshot = createMockSnapshot();
    const { stat, runStats } = computeSessionUsage(snapshot);

    expect(stat.sessionId).toBe(snapshot.id);
    expect(stat.runCount).toBe(1);
    expect(stat.promptTokens).toBe(100);
    expect(stat.completionTokens).toBe(25);
    expect(stat.cachedTokens).toBe(40);
    expect(stat.totalTokens).toBe(125);
    expect(runStats).toHaveLength(1);
    expect(runStats[0]?.date).toBe("2025-01-01");
  });

  it("aggregates multiple sessions and models properly", () => {
    const s1 = computeSessionUsage(
      createMockSnapshot({
        id: "00000000-0000-0000-0000-000000000001",
        model: "model-a",
        workspace: "/ws1",
      }),
    );
    const s2 = computeSessionUsage(
      createMockSnapshot({
        id: "00000000-0000-0000-0000-000000000002",
        model: "model-b",
        workspace: "/ws2",
        events: [
          {
            sessionId: "00000000-0000-0000-0000-000000000002",
            type: "run_started",
            model: "model-b",
            permission: "read_only",
            prompt: "Test",
            timestamp: "2025-01-02T10:00:00.000Z",
          },
          {
            sessionId: "00000000-0000-0000-0000-000000000002",
            type: "run_finished",
            status: "completed",
            timestamp: "2025-01-02T10:01:00.000Z",
            usage: {
              promptTokens: 200,
              completionTokens: 50,
              totalTokens: 250,
              cachedPromptTokens: 100,
            },
          },
        ],
      }),
    );

    const stats = aggregateUsageStats([s1, s2]);
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalRuns).toBe(2);
    expect(stats.totalPromptTokens).toBe(300);
    expect(stats.totalCompletionTokens).toBe(75);
    expect(stats.totalCachedTokens).toBe(140);
    expect(stats.totalTokens).toBe(375);
    expect(stats.averageCacheRate).toBeCloseTo(140 / 300, 4);

    expect(stats.models).toHaveLength(2);
    expect(stats.models[0]?.model).toBe("model-b");
    expect(stats.models[1]?.model).toBe("model-a");

    expect(stats.daily).toHaveLength(2);
    expect(stats.daily[0]?.date).toBe("2025-01-01");
    expect(stats.daily[1]?.date).toBe("2025-01-02");

    // Filter by workspace
    const ws1Stats = aggregateUsageStats([s1, s2], { workspace: "/ws1" });
    expect(ws1Stats.totalSessions).toBe(1);
    expect(ws1Stats.totalPromptTokens).toBe(100);
  });

  it("handles service caching and store retrieval", async () => {
    const snap1 = createMockSnapshot();
    const store = {
      list: async () => [
        {
          version: 1 as const,
          id: snap1.id,
          title: snap1.title,
          workspace: snap1.workspace,
          model: snap1.model,
          createdAt: snap1.createdAt,
          updatedAt: snap1.updatedAt,
          status: snap1.status,
        },
      ],
      get: async (id: string) => {
        if (id === snap1.id) return snap1;
        throw new Error("Not found");
      },
      create: async () => { throw new Error("not implemented"); },
      save: async () => {},
      acquire: async () => async () => {},
    };

    const service = createUsageStatsService(store);
    const stats1 = await service.getUsageStats();
    expect(stats1.totalSessions).toBe(1);
    expect(stats1.totalTokens).toBe(125);

    // Call again to verify cache
    const stats2 = await service.getUsageStats();
    expect(stats2.totalSessions).toBe(1);
    expect(stats2.totalTokens).toBe(125);
  });
});
