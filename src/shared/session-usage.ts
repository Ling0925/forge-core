import { z } from "zod";
import {
  type ContextDisplay,
  advanceContextDisplay,
  emptyContextDisplay,
} from "./context-display";
import { type AgentEvent, type Usage, contextUsageSchema } from "./schemas";

type Totals = Pick<Usage, "promptTokens" | "completionTokens" | "totalTokens">;
const emptyTotals = (): Totals => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});
const add = (a: Totals, b: Totals): Totals => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  totalTokens: a.totalTokens + b.totalTokens,
});

const totalsSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
const displayStateSchema = z
  .object({
    context: contextUsageSchema.optional(),
    projected: contextUsageSchema.optional(),
    model: z.string().min(1).max(256).optional(),
    compacted: z.boolean(),
  })
  .strict()
  .readonly();
const requestStateSchema = z
  .object({
    key: z.string().min(1).max(4096),
    startedAt: z.number().finite(),
  })
  .strict()
  .readonly();
const count = z.number().int().nonnegative();
const measure = z.number().finite().nonnegative();

/**
 * Fixed-size, resumable usage accumulation. It deliberately contains no event
 * array, message body, tool output or other transcript payload: a host can send
 * this across RPC as the summary of an event prefix, and a client can continue
 * accumulating from it to produce exactly the same result as a full rescan.
 */
export const sessionUsageStateSchema = z
  .object({
    display: displayStateSchema,
    speedTokens: measure,
    speedDurationMs: measure,
    speedPartial: z.boolean(),
    request: requestStateSchema.optional(),
    runHasRequests: z.boolean(),
    latestCache: measure.optional(),
    cacheInput: measure,
    cacheRead: measure,
    cacheReports: count,
    requests: count,
    partial: z.boolean(),
    total: totalsSchema,
    pending: totalsSchema,
    pendingReports: count,
    reports: count,
  })
  .strict()
  .readonly();
export type SessionUsageState = z.infer<typeof sessionUsageStateSchema>;

interface RequestState {
  readonly key: string;
  readonly startedAt: number;
}

interface UsageState {
  display: ContextDisplay;
  speedTokens: number;
  speedDurationMs: number;
  speedPartial: boolean;
  request: RequestState | undefined;
  runHasRequests: boolean;
  latestCache: number | undefined;
  cacheInput: number;
  cacheRead: number;
  cacheReports: number;
  requests: number;
  partial: boolean;
  total: Totals;
  pending: Totals;
  pendingReports: number;
  reports: number;
}

function emptyState(): UsageState {
  return {
    display: emptyContextDisplay(),
    speedTokens: 0,
    speedDurationMs: 0,
    speedPartial: false,
    request: undefined,
    runHasRequests: false,
    latestCache: undefined,
    cacheInput: 0,
    cacheRead: 0,
    cacheReports: 0,
    requests: 0,
    partial: false,
    total: emptyTotals(),
    pending: emptyTotals(),
    pendingReports: 0,
    reports: 0,
  };
}

/** Copy only schema-owned scalar values; never retain extra payload properties. */
function stateFromSeed(seed: SessionUsageState): UsageState {
  return {
    display: {
      compacted: seed.display.compacted,
      ...(seed.display.context === undefined
        ? {}
        : { context: seed.display.context }),
      ...(seed.display.projected === undefined
        ? {}
        : { projected: seed.display.projected }),
      ...(seed.display.model === undefined
        ? {}
        : { model: seed.display.model }),
    },
    speedTokens: seed.speedTokens,
    speedDurationMs: seed.speedDurationMs,
    speedPartial: seed.speedPartial,
    request:
      seed.request === undefined
        ? undefined
        : { key: seed.request.key, startedAt: seed.request.startedAt },
    runHasRequests: seed.runHasRequests,
    latestCache: seed.latestCache,
    cacheInput: seed.cacheInput,
    cacheRead: seed.cacheRead,
    cacheReports: seed.cacheReports,
    requests: seed.requests,
    partial: seed.partial,
    total: { ...seed.total },
    pending: { ...seed.pending },
    pendingReports: seed.pendingReports,
    reports: seed.reports,
  };
}

function stateToSeed(state: UsageState): SessionUsageState {
  return sessionUsageStateSchema.parse({
    display: {
      compacted: state.display.compacted,
      ...(state.display.context === undefined
        ? {}
        : { context: state.display.context }),
      ...(state.display.projected === undefined
        ? {}
        : { projected: state.display.projected }),
      ...(state.display.model === undefined
        ? {}
        : { model: state.display.model }),
    },
    speedTokens: state.speedTokens,
    speedDurationMs: state.speedDurationMs,
    speedPartial: state.speedPartial,
    ...(state.request === undefined
      ? {}
      : {
          request: {
            key: state.request.key,
            startedAt: state.request.startedAt,
          },
        }),
    runHasRequests: state.runHasRequests,
    ...(state.latestCache === undefined
      ? {}
      : { latestCache: state.latestCache }),
    cacheInput: state.cacheInput,
    cacheRead: state.cacheRead,
    cacheReports: state.cacheReports,
    requests: state.requests,
    partial: state.partial,
    total: { ...state.total },
    pending: { ...state.pending },
    pendingReports: state.pendingReports,
    reports: state.reports,
  });
}

function cloneState(state: UsageState): UsageState {
  return {
    ...state,
    display: { ...state.display },
    request: state.request === undefined ? undefined : { ...state.request },
    total: { ...state.total },
    pending: { ...state.pending },
  };
}

const requestBoundaries = new Set([
  "run_started",
  "run_finished",
  "step_started",
  "step_finished",
  "tool_started",
  "approval_requested",
]);

function accumulateSpeed(state: UsageState, event: AgentEvent) {
  // Attempt numbers restart at every step/run. Never carry an unmatched request
  // into tools, approval, another step or an idle gap in an interrupted transcript.
  if (requestBoundaries.has(event.type)) {
    state.speedPartial ||= state.request !== undefined;
    state.request = undefined;
  }
  if (event.type === "run_started") state.runHasRequests = false;
  if (event.type === "run_finished") {
    state.speedPartial ||=
      event.usageComplete === false ||
      (!state.runHasRequests && (event.turns > 0 || state.pendingReports > 0));
  }
  if (event.type !== "provider_attempt") return;
  state.runHasRequests = true;
  const selection = event.selection;
  const key = JSON.stringify([
    event.sessionId,
    event.turn,
    event.step,
    selection.attempt,
    selection.groupId,
    selection.sourceId,
    selection.credentialId,
    selection.model,
    selection.apiMode,
  ]);
  const timestamp = Date.parse(selection.timestamp);
  if (selection.outcome === "started") {
    state.speedPartial ||=
      state.request !== undefined || !Number.isFinite(timestamp);
    state.request = Number.isFinite(timestamp)
      ? { key, startedAt: timestamp }
      : undefined;
    return;
  }
  const duration =
    state.request?.key === key
      ? timestamp - state.request.startedAt
      : Number.NaN;
  if (state.request?.key === key) state.request = undefined;
  const output = selection.usage?.completionTokens;
  // Match the numerator and denominator to the same measured requests. Missing
  // usage/timing is unknown, not zero, and run wall time is never a substitute.
  if (
    Number.isFinite(duration) &&
    duration > 0 &&
    output !== undefined &&
    Number.isFinite(output) &&
    output >= 0
  ) {
    state.speedTokens += output;
    state.speedDurationMs += duration;
  } else {
    state.speedPartial = true;
  }
}

function accumulate(state: UsageState, event: AgentEvent) {
  state.display = advanceContextDisplay(state.display, event);
  accumulateSpeed(state, event);
  if (event.type === "run_started") {
    state.pending = emptyTotals();
    state.pendingReports = 0;
  }
  if (event.type === "context_usage") {
    const usage = event.usage;
    if (usage.basis !== "projected" && usage.promptTokens !== undefined) {
      state.requests++;
      state.latestCache =
        usage.cachedPromptTokens !== undefined && usage.promptTokens > 0
          ? usage.cachedPromptTokens / usage.promptTokens
          : undefined;
      if (usage.cachedPromptTokens !== undefined) {
        state.cacheInput += usage.promptTokens;
        state.cacheRead += usage.cachedPromptTokens;
        state.cacheReports++;
      }
      state.pending = add(state.pending, {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens ?? 0,
        totalTokens: usage.promptTokens + (usage.completionTokens ?? 0),
      });
      state.pendingReports++;
    }
  }
  if (event.type === "run_finished") {
    if (state.pendingReports === 0 && event.usage) {
      state.requests++;
      if (event.usage.cachedPromptTokens !== undefined) {
        state.cacheInput += event.usage.promptTokens;
        state.cacheRead += event.usage.cachedPromptTokens;
        state.cacheReports++;
      }
    }
    state.total = add(state.total, event.usage ?? state.pending);
    state.reports += event.usage ? 1 : state.pendingReports;
    state.partial ||= !event.usage || event.usageComplete === false;
    state.pending = emptyTotals();
    state.pendingReports = 0;
  }
}

function summarize(state: UsageState) {
  return {
    context: state.display.context,
    projected: state.display.projected,
    compacted: state.display.compacted,
    total:
      state.reports + state.pendingReports
        ? add(state.total, state.pending)
        : undefined,
    partial: state.partial,
    latestCache: state.latestCache,
    averageCache:
      state.cacheInput > 0 ? state.cacheRead / state.cacheInput : undefined,
    cacheRead: state.cacheReports ? state.cacheRead : undefined,
    cachePartial: state.cacheReports < state.requests,
    speed: {
      outputTokens: state.speedTokens,
      durationMs: state.speedDurationMs,
      partial: state.speedPartial,
      requestStartedAt: state.request?.startedAt,
    },
  };
}

type UsageSummary = ReturnType<typeof summarize>;

interface CacheEntry {
  readonly state: UsageState;
  readonly result: UsageSummary;
  /** Provenance for idempotent seeding; it is never part of the exported state. */
  readonly seed: SessionUsageState | undefined;
}

// Event arrays are immutable snapshots. Weak keys release cached data with the snapshot.
const cache = new WeakMap<readonly AgentEvent[], CacheEntry>();

function entry(events: readonly AgentEvent[]): CacheEntry {
  const existing = cache.get(events);
  if (existing) return existing;
  const state = emptyState();
  for (const event of events) accumulate(state, event);
  const value = { state, result: summarize(state), seed: undefined };
  cache.set(events, value);
  return value;
}

export function sessionUsage(events: readonly AgentEvent[]) {
  return entry(events).result;
}

/**
 * Accumulate exactly this event slice from a fixed-size prefix summary. The
 * summary is associated with the array so `sessionUsage(events)` returns the
 * prefix + slice result without a second scan. Re-seeding the same array with
 * the same seed reference is a no-op.
 */
export function seedSessionUsage(
  events: readonly AgentEvent[],
  before: SessionUsageState | undefined,
): void {
  const existing = cache.get(events);
  if (existing?.seed === before) return;
  const state = before === undefined ? emptyState() : stateFromSeed(before);
  for (const event of events) accumulate(state, event);
  cache.set(events, { state, result: summarize(state), seed: before });
}

/** Compute the fixed-size accumulated state for an event prefix on the host. */
export function summarizeUsageState(
  events: readonly AgentEvent[],
): SessionUsageState {
  const state = emptyState();
  for (const event of events) accumulate(state, event);
  return stateToSeed(state);
}

/** The reducer owns append provenance; fetched/replaced arrays always get a fresh scan. */
export function appendSessionEvent(
  events: readonly AgentEvent[],
  event: AgentEvent,
): readonly AgentEvent[] {
  const previous = entry(events);
  const next = [...events, event];
  if (
    event.type !== "context_usage" &&
    event.type !== "context_compacted" &&
    event.type !== "provider_attempt" &&
    !requestBoundaries.has(event.type)
  )
    cache.set(next, previous);
  else {
    const state = cloneState(previous.state);
    accumulate(state, event);
    cache.set(next, {
      state,
      result: summarize(state),
      seed: previous.seed,
    });
  }
  return next;
}

const tokenFormatter = Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export function compactTokens(value: number): string {
  return tokenFormatter.format(value);
}
