import { describe, expect, it, vi } from "vitest";
import {
  aggregateUsageStats,
  computeSessionUsage,
  sessionRequestRecords,
} from "../src/core/usage-stats";
import { usageStatsDtoSchema } from "../src/shared/ipc";
import {
  type AgentEvent,
  type Usage,
  agentEventSchema,
  sessionSnapshotSchema,
} from "../src/shared/schemas";
import {
  appendSessionEvent,
  seedSessionUsage,
  sessionUsage,
  sessionUsageStateSchema,
  summarizeUsageState,
} from "../src/shared/session-usage";

const id = "00000000-0000-0000-0000-000000000001";
const time = (second: number) =>
  new Date(Date.UTC(2026, 9, 24, 0, 0, second)).toISOString();
const usage = (input = 100, output = 20, cached?: number): Usage => ({
  promptTokens: input,
  completionTokens: output,
  totalTokens: input + output,
  ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
});
const event = (
  type: string,
  second: number,
  fields: Record<string, unknown> = {},
): AgentEvent =>
  agentEventSchema.parse({
    type,
    sessionId: id,
    timestamp: time(second),
    ...fields,
  });
const start = (second = 0) =>
  event("run_started", second, { model: "model", permission: "readonly" });
const finish = (second: number, value?: Usage, turns = 1, complete = true) =>
  event("run_finished", second, {
    status: "completed",
    toolCalls: 0,
    turns,
    ...(value ? { usage: value } : {}),
    usageComplete: complete,
  });
const attempt = (
  outcome: "started" | "succeeded" | "failed",
  second: number,
  value?: Usage,
  step = 1,
) =>
  event("provider_attempt", second, {
    turn: 1,
    step,
    selection: {
      sourceId: "source",
      model: "model",
      apiMode: "responses",
      attempt: 0,
      reason: "direct",
      outcome,
      timestamp: time(second),
      ...(value ? { usage: value } : {}),
    },
  });
const context = (second: number, value: Usage) =>
  event("context_usage", second, {
    usage: {
      basis: "request",
      estimated: false,
      windowTokens: 100000,
      usedTokens: value.promptTokens,
      promptTokens: value.promptTokens,
      completionTokens: value.completionTokens,
      ...(value.cachedPromptTokens === undefined
        ? {}
        : { cachedPromptTokens: value.cachedPromptTokens }),
      parts: {
        instructions: 0,
        memory: 0,
        conversation: value.promptTokens,
        tools: 0,
      },
    },
  });
const tool = (second: number) =>
  event("tool_started", second, {
    call: {
      id: "call",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    },
  });
const snapshot = (events: readonly AgentEvent[], workspace = "/synthetic") =>
  sessionSnapshotSchema.parse({
    version: 1,
    id,
    title: "usage",
    workspace,
    model: "model",
    createdAt: time(-86400),
    updatedAt: time(100),
    status: "completed",
    messages: [],
    changes: [],
    events,
  });
const stats = (events: readonly AgentEvent[]) =>
  usageStatsDtoSchema.parse(
    aggregateUsageStats([computeSessionUsage(snapshot(events))]),
  );
const measured = (value: Usage, second = 1, step = 1): AgentEvent[] => [
  attempt("started", second, undefined, step),
  attempt("succeeded", second + 2, value, step),
  context(second + 2, value),
];
const expectCache = (
  events: readonly AgentEvent[],
  input: number,
  read: number | undefined,
  rate: number | undefined,
  partial: boolean,
) => {
  expect(sessionUsage(events)).toMatchObject({
    cacheInputTokens: input,
    cacheRead: read,
    averageCache: rate,
    cachePartial: partial,
  });
  expect(stats(events)).toMatchObject({
    cacheInputTokens: input,
    cacheReadTokens: read ?? 0,
    averageCacheRate: rate ?? 0,
    cachePartial: partial,
  });
};

describe("shared cache accounting", () => {
  it("uses the same known-sample denominator in session and statistics, without duplicate reports", () => {
    const a = usage(100, 20, 80);
    const b = usage(900, 20);
    const events = [
      start(),
      ...measured(a),
      ...measured(b, 5, 2),
      finish(8, usage(1000, 40, 80), 2),
    ];
    expectCache(events, 100, 80, 0.8, true);
    expect(stats(events).totalPromptTokens).toBe(1000);
    expect(sessionUsage(events).latestCache).toBeUndefined();
  });

  it("distinguishes a reported zero from a missing cache counter and entirely absent usage", () => {
    const zero = usage(100, 20, 0);
    expectCache(
      [start(), ...measured(zero), finish(5, zero)],
      100,
      0,
      0,
      false,
    );
    const unknown = usage();
    expectCache(
      [start(), ...measured(unknown), finish(5, unknown)],
      0,
      undefined,
      undefined,
      true,
    );
    const missing = [
      start(),
      attempt("started", 1),
      attempt("succeeded", 3),
      finish(5, undefined, 1, false),
    ];
    expectCache(missing, 0, undefined, undefined, true);
  });

  it("marks an omitted usage report partial during the run, not just at run_finished", () => {
    const a = usage(100, 20, 80);
    const events = [
      start(),
      ...measured(a),
      attempt("started", 5, undefined, 2),
      attempt("succeeded", 7, undefined, 2),
    ];
    expectCache(events, 100, 80, 0.8, true);
    expect(sessionUsage(events).latestCache).toBeUndefined();
  });

  it("accounts for result-only logs and reported failed attempts without waiting for a context event", () => {
    const a = usage(100, 20, 80);
    const b = usage(300, 10, 120);
    const events = [
      start(),
      attempt("started", 1),
      attempt("failed", 3, a),
      attempt("started", 5, undefined, 2),
      attempt("succeeded", 7, b, 2),
      finish(8, b),
    ];
    expectCache(events, 400, 200, 0.5, false);
  });

  it("keeps failed attempts without usage unknown rather than free", () => {
    const a = usage(100, 20, 80);
    const events = [
      start(),
      attempt("started", 1),
      attempt("failed", 2),
      ...measured(a, 3, 2),
      finish(6, a, 1, false),
    ];
    expectCache(events, 100, 80, 0.8, true);
  });

  it("supports legacy context and aggregate records and refreshes the latest cache from a legacy aggregate", () => {
    const a = usage(100, 20, 80);
    const b = usage(300, 20, 120);
    expectCache([start(), context(2, a), finish(3, a)], 100, 80, 0.8, false);
    const events = [start(), finish(3, a), start(10), finish(13, b)];
    expectCache(events, 400, 200, 0.5, false);
    expect(sessionUsage(events).latestCache).toBe(0.4);
  });

  it("marks multi-request legacy aggregates partial and clears a stale latest rate after an unknown run", () => {
    const a = usage(100, 20, 80);
    expectCache([start(), finish(4, a, 2)], 100, 80, 0.8, true);
    const events = [
      start(),
      ...measured(a),
      finish(4, a),
      start(10),
      finish(13, undefined, 1, false),
    ];
    expectCache(events, 100, 80, 0.8, true);
    expect(sessionUsage(events).latestCache).toBeUndefined();
  });

  it("does not let a mixed run total overwrite known request samples or conceal auxiliary usage", () => {
    const a = usage(100, 20, 80);
    const events = [start(), ...measured(a), finish(4, usage(1000, 200, 200))];
    expectCache(events, 100, 80, 0.8, true);
    expect(stats(events).totalPromptTokens).toBe(1000);
  });

  it("does not count projected context or clear cache history on manual compaction", () => {
    const a = usage(100, 20, 80);
    const events = [
      start(),
      ...measured(a),
      finish(4, a),
      event("context_usage", 5, {
        usage: {
          basis: "projected",
          estimated: true,
          windowTokens: 100000,
          usedTokens: 10,
          parts: { instructions: 0, memory: 0, conversation: 10, tools: 0 },
        },
      }),
    ];
    expectCache(events, 100, 80, 0.8, false);
    expect(sessionUsage(events).latestCache).toBe(0.8);
  });

  it("excludes impossible cache counts instead of returning more than 100 percent", () => {
    const invalid = usage(100, 20, 200);
    const a = usage(100, 20, 80);
    const events = [
      start(),
      ...measured(invalid),
      ...measured(a, 4, 2),
      finish(7, usage(200, 40, 280), 2),
    ];
    expectCache(events, 100, 80, 0.8, true);
  });

  it("keeps empty and zero-input rates unavailable, with numeric wire compatibility", () => {
    expectCache([], 0, undefined, undefined, false);
    const zero = usage(0, 20, 0);
    expectCache(
      [start(), ...measured(zero), finish(4, zero)],
      0,
      0,
      undefined,
      false,
    );
    const { cacheInputTokens, cacheReadTokens, cachePartial, ...legacyDto } =
      stats([]);
    expect(usageStatsDtoSchema.parse(legacyDto)).not.toHaveProperty(
      "cachePartial",
    );
  });

  it("applies workspace and request-time filters to numerator, denominator and missing-report markers together", () => {
    vi.useFakeTimers();
    vi.setSystemTime(time(86400));
    try {
      const a = usage(100, 20, 80);
      const old = [
        start(-100),
        ...measured(usage(), -99),
        finish(-96, usage()),
      ];
      const recent = [start(1), ...measured(a, 2), finish(5, a)];
      const computed = computeSessionUsage(snapshot([...old, ...recent]));
      const unrelated = computeSessionUsage(
        snapshot(
          [start(1), ...measured(usage(), 2), finish(5, usage())],
          "/other",
        ),
      );
      const filtered = aggregateUsageStats([computed, unrelated], {
        workspace: "/synthetic",
        days: 1,
      });
      expect(filtered).toMatchObject({
        cacheInputTokens: 100,
        cacheReadTokens: 80,
        averageCacheRate: 0.8,
        cachePartial: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resumable session metrics", () => {
  it("has identical full replay, incremental append and every serialized prefix/suffix split", () => {
    const a = usage(100, 20, 80);
    const events = [
      start(),
      ...measured(a),
      tool(4),
      attempt("started", 10, undefined, 2),
      attempt("succeeded", 12, undefined, 2),
      finish(13, a, 2, false),
      start(20),
      ...measured(a, 21),
      finish(24, a),
    ];
    const expected = sessionUsage(events);
    let appended: readonly AgentEvent[] = [];
    for (const value of events) appended = appendSessionEvent(appended, value);
    expect(sessionUsage(appended)).toEqual(expected);
    for (let split = 0; split <= events.length; split++) {
      const prefix = sessionUsageStateSchema.parse(
        JSON.parse(JSON.stringify(summarizeUsageState(events.slice(0, split)))),
      );
      const suffix = events.slice(split);
      seedSessionUsage(suffix, prefix);
      expect(sessionUsage(suffix)).toEqual(expected);
      seedSessionUsage(suffix, prefix);
      expect(sessionUsage(suffix)).toEqual(expected);
    }
  });

  it("accepts older prefix states without claiming their missing-attempt coverage is complete", () => {
    const a = usage(100, 20, 80);
    const { cacheState, ...legacy } = summarizeUsageState([
      start(),
      ...measured(a),
      finish(4, a),
    ]);
    const suffix: AgentEvent[] = [];
    seedSessionUsage(suffix, sessionUsageStateSchema.parse(legacy));
    expect(sessionUsage(suffix)).toMatchObject({
      averageCache: 0.8,
      cacheRead: 80,
      cachePartial: true,
    });
  });

  it("does not mutate the previous summary when an unknown request is appended", () => {
    const a = usage(100, 20, 80);
    const events = [start(), ...measured(a)];
    const before = sessionUsage(events);
    const next = appendSessionEvent(
      events,
      attempt("started", 4, undefined, 2),
    );
    expect(before.cachePartial).toBe(false);
    expect(sessionUsage(next).cachePartial).toBe(true);
  });
});

describe("request-based session speed", () => {
  it("computes a weighted session throughput, excluding local tool time and idle gaps", () => {
    const a = usage(100, 100, 80);
    const events = [
      start(),
      attempt("started", 1),
      attempt("succeeded", 2, a),
      context(2, a),
      tool(3),
      attempt("started", 100, undefined, 2),
      attempt("succeeded", 109, a, 2),
      context(109, a),
      finish(110, usage(200, 200, 160), 2),
    ];
    expect(sessionUsage(events).speed).toMatchObject({
      outputTokens: 200,
      durationMs: 10000,
      tokensPerSecond: 20,
      partial: false,
    });
    expect(
      sessionRequestRecords(snapshot(events)).map(
        (value) => value.tokensPerSecond,
      ),
    ).toEqual([100, 100 / 9]);
  });

  it("does not mix an in-flight duration with completed output tokens", () => {
    const a = usage(100, 100, 80);
    const first = [start(), attempt("started", 1)];
    expect(sessionUsage(first).speed.tokensPerSecond).toBeUndefined();
    const active = [
      ...first,
      attempt("succeeded", 3, a),
      context(3, a),
      attempt("started", 4, undefined, 2),
    ];
    expect(sessionUsage(active).speed).toMatchObject({
      outputTokens: 100,
      durationMs: 2000,
      tokensPerSecond: 50,
      requestStartedAt: Date.parse(time(4)),
    });
  });

  it.each(["tool_started", "approval_requested"])(
    "never matches a result across %s in either statistics path",
    (type) => {
      const boundary =
        type === "tool_started"
          ? tool(2)
          : event("approval_requested", 2, {
              request: {
                id,
                sessionId: id,
                toolCallId: "call",
                toolName: "read_file",
                description: "test",
              },
            });
      const a = usage(100, 100, 80);
      const events = [
        start(),
        attempt("started", 1),
        boundary,
        attempt("succeeded", 10, a),
        finish(11, a),
      ];
      const rows = sessionRequestRecords(snapshot(events));
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.tokensPerSecond === undefined)).toBe(true);
      expect(sessionUsage(events).speed).toMatchObject({
        durationMs: 0,
        tokensPerSecond: undefined,
        partial: true,
      });
      expectCache(events, 100, 80, 0.8, true);
    },
  );

  it("keeps historical untimed output out of both numerator and denominator", () => {
    const a = usage(100, 100, 80);
    const events = [
      start(),
      context(100, usage(100, 10000, 80)),
      finish(200, usage(100, 10000, 80)),
      start(300),
      attempt("started", 301),
      attempt("succeeded", 303, a),
      context(303, a),
      finish(304, a),
    ];
    expect(sessionUsage(events).speed).toMatchObject({
      outputTokens: 100,
      durationMs: 2000,
      tokensPerSecond: 50,
      partial: true,
    });
  });

  it("retains explicit zero throughput but rejects zero and negative request durations", () => {
    const zero = usage(100, 0, 80);
    const events = [
      start(),
      attempt("started", 1),
      attempt("succeeded", 3, zero),
      context(3, zero),
      attempt("started", 5, undefined, 2),
      attempt("succeeded", 5, zero, 2),
      attempt("started", 10, undefined, 3),
      attempt("succeeded", 9, zero, 3),
    ];
    expect(sessionUsage(events).speed).toMatchObject({
      durationMs: 2000,
      tokensPerSecond: 0,
      partial: true,
    });
    expect(
      sessionRequestRecords(snapshot(events)).map(
        (value) => value.tokensPerSecond,
      ),
    ).toEqual([0, undefined, undefined]);
  });
});
