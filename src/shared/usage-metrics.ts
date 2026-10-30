import { z } from "zod";
import type { AgentEvent, Usage } from "./schemas";

const requestBoundaries = new Set<AgentEvent["type"]>([
  "run_started",
  "run_finished",
  "step_started",
  "step_finished",
  "tool_started",
  "approval_requested",
]);
export const isUsageRequestBoundary = (event: AgentEvent): boolean =>
  requestBoundaries.has(event.type);

export const providerRequestKey = (
  event: Extract<AgentEvent, { type: "provider_attempt" }>,
): string =>
  JSON.stringify([
    event.sessionId,
    event.turn,
    event.step,
    event.selection.attempt,
    event.selection.groupId,
    event.selection.sourceId,
    event.selection.credentialId,
    event.selection.model,
    event.selection.apiMode,
  ]);

/** End-to-end throughput, not streaming speed. Never substitute run wall time. */
export function outputTokensPerSecond(
  output: number | undefined,
  durationMs: number,
): number | undefined {
  if (
    output === undefined ||
    !Number.isFinite(output) ||
    output < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  )
    return undefined;
  const rate = output / (durationMs / 1000);
  return Number.isFinite(rate) ? rate : undefined;
}

const count = z.number().int().nonnegative();
export const cacheUsageStateSchema = z
  .object({
    inputTokens: count,
    readTokens: count,
    reports: count,
    requests: count,
    partial: z.boolean(),
    latestRate: z.number().min(0).max(1).optional(),
    pending: z
      .object({ key: z.string().max(4096), timestamp: z.string() })
      .strict()
      .optional(),
    awaitingContext: z.boolean(),
    runReports: count,
    runPromptTokens: count,
    runReadTokens: count,
    runSuccesses: count,
  })
  .strict();
export type CacheUsageState = z.infer<typeof cacheUsageStateSchema>;

export const emptyCacheUsage = (): CacheUsageState => ({
  inputTokens: 0,
  readTokens: 0,
  reports: 0,
  requests: 0,
  partial: false,
  awaitingContext: false,
  runReports: 0,
  runPromptTokens: 0,
  runReadTokens: 0,
  runSuccesses: 0,
});

/** Only matched, provider-reported input/cache pairs contribute to this rate. */
export function summarizeCacheUsage(
  state: Pick<
    CacheUsageState,
    | "inputTokens"
    | "readTokens"
    | "reports"
    | "requests"
    | "partial"
    | "pending"
  >,
) {
  return {
    inputTokens: state.inputTokens,
    readTokens: state.reports ? state.readTokens : undefined,
    rate:
      state.inputTokens > 0 ? state.readTokens / state.inputTokens : undefined,
    partial:
      state.partial ||
      state.reports < state.requests ||
      state.pending !== undefined,
  };
}

export interface CacheUsageRecord {
  readonly timestamp: string;
  readonly inputTokens: number;
  readonly readTokens: number;
  readonly reports: number;
  readonly requests: number;
  readonly partial: boolean;
}

/**
 * Shared by live/paged session summaries and filtered usage statistics. Attempts
 * are authoritative; their following context report and run total are repeats.
 * Older logs fall back to individual context reports, then to a run aggregate.
 * The state is fixed-size and contains no transcript payload.
 */
export function accumulateCacheUsage(
  state: CacheUsageState,
  event: AgentEvent,
  onRecord?: (record: CacheUsageRecord) => void,
): void {
  const markPartial = (timestamp: string) => {
    state.partial = true;
    onRecord?.({
      timestamp,
      inputTokens: 0,
      readTokens: 0,
      reports: 0,
      requests: 0,
      partial: true,
    });
  };
  const observe = (
    usage: Pick<Usage, "promptTokens" | "cachedPromptTokens"> | undefined,
    timestamp: string,
    success: boolean,
  ) => {
    const input = usage?.promptTokens;
    const read = usage?.cachedPromptTokens;
    // Malformed cache counts must not produce >100% or dilute valid samples.
    const known =
      input !== undefined &&
      Number.isSafeInteger(input) &&
      input >= 0 &&
      read !== undefined &&
      Number.isSafeInteger(read) &&
      read >= 0 &&
      read <= input;
    const record: CacheUsageRecord = {
      timestamp,
      inputTokens: known ? input : 0,
      readTokens: known ? read : 0,
      reports: known ? 1 : 0,
      requests: 1,
      partial: !known,
    };
    state.inputTokens += record.inputTokens;
    state.readTokens += record.readTokens;
    state.reports += record.reports;
    state.requests++;
    state.runReports++;
    if (success) {
      state.runSuccesses++;
      state.runPromptTokens += input ?? 0;
      state.runReadTokens += record.readTokens;
    }
    state.latestRate = known && input > 0 ? read / input : undefined;
    onRecord?.(record);
  };

  if (isUsageRequestBoundary(event)) {
    if (state.pending) markPartial(state.pending.timestamp);
    state.pending = undefined;
    state.awaitingContext = false;
  }
  if (event.type === "run_started") {
    state.runReports = 0;
    state.runPromptTokens = 0;
    state.runReadTokens = 0;
    state.runSuccesses = 0;
  } else if (event.type === "provider_attempt") {
    const { selection } = event;
    const key = providerRequestKey(event);
    if (selection.outcome === "started") {
      if (state.pending) markPartial(state.pending.timestamp);
      state.pending = { key, timestamp: selection.timestamp };
      state.awaitingContext = false;
    } else {
      const timestamp =
        state.pending?.key === key
          ? state.pending.timestamp
          : selection.timestamp;
      if (state.pending && state.pending.key !== key)
        markPartial(state.pending.timestamp);
      state.pending = undefined;
      observe(selection.usage, timestamp, selection.outcome === "succeeded");
      state.awaitingContext = selection.outcome === "succeeded";
    }
  } else if (
    event.type === "context_usage" &&
    event.usage.basis !== "projected" &&
    event.usage.promptTokens !== undefined
  ) {
    if (!state.awaitingContext) {
      observe(
        {
          promptTokens: event.usage.promptTokens,
          ...(event.usage.cachedPromptTokens === undefined
            ? {}
            : { cachedPromptTokens: event.usage.cachedPromptTokens }),
        },
        event.timestamp,
        true,
      );
    }
    state.awaitingContext = false;
  } else if (event.type === "run_finished") {
    if (state.runReports === 0) {
      if (event.usage && (event.turns > 0 || event.usage.totalTokens > 0)) {
        observe(event.usage, event.timestamp, true);
        // An old mixed aggregate cannot prove cache coverage for every request.
        if (event.turns > 1) markPartial(event.timestamp);
      } else if (event.turns > 0) {
        state.latestRate = undefined;
        markPartial(event.timestamp);
      }
    } else if (
      event.turns > state.runSuccesses ||
      (event.usage && event.usage.promptTokens !== state.runPromptTokens) ||
      (event.usage?.cachedPromptTokens !== undefined &&
        event.usage.cachedPromptTokens !== state.runReadTokens)
    ) {
      // Missing/auxiliary requests or conflicting counters cannot be
      // reconstructed from a mixed total.
      markPartial(event.timestamp);
    }
    if (event.usageComplete === false) markPartial(event.timestamp);
    state.runReports = 0;
    state.runPromptTokens = 0;
    state.runReadTokens = 0;
    state.runSuccesses = 0;
  }
}

/** Request timestamps preserve the same time-filter boundary as request rows. */
export function cacheUsageRecords(
  events: readonly AgentEvent[],
): readonly CacheUsageRecord[] {
  const state = emptyCacheUsage();
  const records: CacheUsageRecord[] = [];
  for (const event of events)
    accumulateCacheUsage(state, event, (record) => records.push(record));
  if (state.pending)
    records.push({
      timestamp: state.pending.timestamp,
      inputTokens: 0,
      readTokens: 0,
      reports: 0,
      requests: 0,
      partial: true,
    });
  return records;
}
