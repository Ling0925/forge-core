import type { SessionStore } from "../shared/contracts";
import type {
  DailyUsageStat,
  ModelUsageStat,
  SessionUsageStat,
  UsageFilter,
  UsageRequest,
  UsageStatsDto,
} from "../shared/ipc";
import type { ProviderAttempt } from "../shared/model-access";
import type { AgentEvent, SessionSnapshot } from "../shared/schemas";
import { createModelPricingService, estimateRequestCostUsd, findModelPrice, type ModelPricingService } from "./model-pricing";

export interface SessionRunStat {
  readonly date: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
}

export interface ComputedSessionUsage {
  readonly stat: SessionUsageStat;
  readonly runStats: readonly SessionRunStat[];
  /** Provider attempts observed in this session; never folded into billed totals. */
  readonly routing: readonly RouteUsageStat[];
  readonly requests: readonly UsageRequest[];
}

/**
 * What one route selection actually served, keyed by group/source/credential/
 * model/protocol. Every field is an id, a counter or a token count: no key,
 * endpoint or request text is ever read from an event. `unknownUsage` keeps a
 * failed attempt whose usage was not reported from being counted as free.
 */
export interface RouteUsageStat {
  readonly groupId?: string | undefined;
  readonly sourceId: string;
  readonly credentialId?: string | undefined;
  readonly model: string;
  readonly apiMode: string;
  /** Selection records written before a request was sent. */
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Terminal attempts that reported no usage: cost unknown, never zero. */
  readonly unknownUsage: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
}

type MutableRouteUsage = {
  -readonly [K in keyof RouteUsageStat]: RouteUsageStat[K];
};
type RouteIdentity = Pick<
  RouteUsageStat,
  "groupId" | "sourceId" | "credentialId" | "model" | "apiMode"
>;

const routeIdentityKey = (entry: RouteIdentity): string =>
  [
    entry.groupId ?? "",
    entry.sourceId,
    entry.credentialId ?? "",
    entry.model,
    entry.apiMode,
  ].join("\u0000");

const emptyRouteUsage = (identity: RouteIdentity): MutableRouteUsage => ({
  ...(identity.groupId === undefined ? {} : { groupId: identity.groupId }),
  sourceId: identity.sourceId,
  ...(identity.credentialId === undefined
    ? {}
    : { credentialId: identity.credentialId }),
  model: identity.model,
  apiMode: identity.apiMode,
  attempts: 0,
  succeeded: 0,
  failed: 0,
  unknownUsage: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
});

const addAttempt = (
  entry: MutableRouteUsage,
  selection: ProviderAttempt,
): void => {
  if (selection.outcome === "started") {
    entry.attempts += 1;
    return;
  }
  if (selection.outcome === "succeeded") entry.succeeded += 1;
  else entry.failed += 1;
  if (selection.usage === undefined) {
    // A failed request may have been billed; absence stays unknown, not zero.
    entry.unknownUsage += 1;
    return;
  }
  entry.promptTokens += selection.usage.promptTokens;
  entry.completionTokens += selection.usage.completionTokens;
  entry.cachedTokens += selection.usage.cachedPromptTokens ?? 0;
  entry.totalTokens += selection.usage.totalTokens;
};

const sortRouteUsage = (
  entries: readonly RouteUsageStat[],
): readonly RouteUsageStat[] =>
  [...entries].sort(
    (a, b) =>
      b.totalTokens - a.totalTokens ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.model.localeCompare(b.model) ||
      a.apiMode.localeCompare(b.apiMode),
  );

export function routeUsageStats(
  events: readonly AgentEvent[],
): readonly RouteUsageStat[] {
  const merged = new Map<string, MutableRouteUsage>();
  for (const event of events) {
    if (event.type !== "provider_attempt") continue;
    const selection = event.selection;
    const key = routeIdentityKey(selection);
    const entry = merged.get(key) ?? emptyRouteUsage(selection);
    addAttempt(entry, selection);
    merged.set(key, entry);
  }
  return sortRouteUsage([...merged.values()]);
}

/** Collapse start/result events into individual requests, not route totals. */
export function sessionRequestRecords(snapshot: SessionSnapshot): readonly UsageRequest[] {
  const records: UsageRequest[] = [];
  const pending = new Map<string, number>();
  for (const [index, event] of snapshot.events.entries()) {
    // Attempt numbers restart across runs and tool steps. Keep those boundaries.
    if (event.type === "run_started" || event.type === "run_finished" ||
        event.type === "step_started" || event.type === "step_finished") {
      pending.clear();
      continue;
    }
    if (event.type !== "provider_attempt") continue;
    const selection = event.selection;
    const key = JSON.stringify([
      event.turn, event.step, selection.attempt, routeIdentityKey(selection),
    ]);
    const record: UsageRequest = {
      id: `${snapshot.id}:${index}`,
      sessionId: snapshot.id,
      sessionTitle: snapshot.title,
      workspace: snapshot.workspace,
      ...(event.turn === undefined ? {} : { turn: event.turn }),
      ...(event.step === undefined ? {} : { step: event.step }),
      sourceId: selection.sourceId,
      model: selection.model,
      apiMode: selection.apiMode,
      ...(selection.credentialId === undefined ? {} : { credentialId: selection.credentialId }),
      ...(selection.groupId === undefined ? {} : { groupId: selection.groupId }),
      attempt: selection.attempt,
      reason: selection.reason,
      timestamp: selection.timestamp,
      outcome: selection.outcome === "started" ? "unknown" : selection.outcome,
      ...(selection.usage === undefined ? {} : { usage: selection.usage }),
      ...(selection.errorCode === undefined ? {} : { errorCode: selection.errorCode }),
    };
    if (selection.outcome === "started") {
      pending.set(key, records.length);
      records.push({ ...record, startedAt: selection.timestamp });
      continue;
    }
    const pendingIndex = pending.get(key);
    const started = pendingIndex === undefined ? undefined : records[pendingIndex];
    const durationMs = started?.startedAt === undefined
      ? Number.NaN
      : Date.parse(selection.timestamp) - Date.parse(started.startedAt);
    // End-to-end output throughput: includes request latency, not a fabricated
    // streaming-only rate (historical events do not record first-token time).
    const tokensPerSecond = (selection.usage?.completionTokens ?? Number.NaN) / (durationMs / 1000);
    const completed: UsageRequest = {
      ...record,
      ...(started ? { id: started.id, timestamp: started.timestamp, startedAt: started.startedAt } : {}),
      finishedAt: selection.timestamp,
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
      ...(durationMs > 0 && Number.isFinite(tokensPerSecond) && tokensPerSecond >= 0 ? { tokensPerSecond } : {}),
    };
    if (pendingIndex === undefined) records.push(completed);
    else records[pendingIndex] = completed;
    pending.delete(key);
  }
  // Missing results after a finished/interrupted run are unknown, not successful
  // or free. Only outstanding requests in the current running session are live.
  if (snapshot.status === "running") {
    for (const index of pending.values()) {
      const record = records[index];
      if (record) records[index] = { ...record, outcome: "started" };
    }
  }
  return records;
}

const matchesUsageFilter = (
  stat: SessionUsageStat,
  filter?: UsageFilter,
): boolean => {
  if (filter?.workspace && stat.workspace !== filter.workspace) return false;
  if (filter?.days && filter.days > 0) {
    const updatedTime = Date.parse(stat.updatedAt);
    if (
      Number.isFinite(updatedTime) &&
      updatedTime < Date.now() - filter.days * 86_400_000
    )
      return false;
  }
  return true;
};

export function computeSessionUsage(
  snapshot: SessionSnapshot,
): ComputedSessionUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let runCount = 0;

  const runStats: SessionRunStat[] = [];
  let pendingPrompt = 0;
  let pendingCompletion = 0;
  let pendingCached = 0;
  let pendingReports = 0;
  let currentRunDate = snapshot.updatedAt.slice(0, 10);

  for (const event of snapshot.events) {
    if (event.type === "run_started") {
      runCount++;
      pendingPrompt = 0;
      pendingCompletion = 0;
      pendingCached = 0;
      pendingReports = 0;
      if (event.timestamp) {
        currentRunDate = event.timestamp.slice(0, 10);
      }
    } else if (event.type === "context_usage") {
      const u = event.usage;
      if (u.basis !== "projected" && u.promptTokens !== undefined) {
        pendingPrompt += u.promptTokens;
        pendingCompletion += u.completionTokens ?? 0;
        if (u.cachedPromptTokens !== undefined) {
          pendingCached += u.cachedPromptTokens;
        }
        pendingReports++;
      }
    } else if (event.type === "run_finished") {
      const runDate = event.timestamp
        ? event.timestamp.slice(0, 10)
        : currentRunDate;
      let runPrompt = 0;
      let runCompletion = 0;
      let runCached = 0;

      if (event.usage) {
        runPrompt = event.usage.promptTokens ?? 0;
        runCompletion = event.usage.completionTokens ?? 0;
        runCached = event.usage.cachedPromptTokens ?? 0;
      } else if (pendingReports > 0) {
        runPrompt = pendingPrompt;
        runCompletion = pendingCompletion;
        runCached = pendingCached;
      }

      promptTokens += runPrompt;
      completionTokens += runCompletion;
      cachedTokens += runCached;

      runStats.push({
        date: runDate,
        promptTokens: runPrompt,
        completionTokens: runCompletion,
        cachedTokens: runCached,
        totalTokens: runPrompt + runCompletion,
      });

      pendingPrompt = 0;
      pendingCompletion = 0;
      pendingCached = 0;
      pendingReports = 0;
    }
  }

  // If there's an ongoing run with pending reports
  if (pendingReports > 0) {
    promptTokens += pendingPrompt;
    completionTokens += pendingCompletion;
    cachedTokens += pendingCached;
    runStats.push({
      date: currentRunDate,
      promptTokens: pendingPrompt,
      completionTokens: pendingCompletion,
      cachedTokens: pendingCached,
      totalTokens: pendingPrompt + pendingCompletion,
    });
  }

  const stat: SessionUsageStat = {
    sessionId: snapshot.id,
    title: snapshot.title,
    workspace: snapshot.workspace,
    model: snapshot.model,
    updatedAt: snapshot.updatedAt,
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
    runCount,
  };

  return { stat, runStats, routing: routeUsageStats(snapshot.events), requests: sessionRequestRecords(snapshot) };
}

export function aggregateRouteUsageStats(
  computedList: readonly ComputedSessionUsage[],
  filter?: UsageFilter,
): readonly RouteUsageStat[] {
  const merged = new Map<string, MutableRouteUsage>();
  for (const item of computedList) {
    if (!matchesUsageFilter(item.stat, filter)) continue;
    for (const observed of item.routing) {
      const key = routeIdentityKey(observed);
      const entry = merged.get(key) ?? emptyRouteUsage(observed);
      entry.attempts += observed.attempts;
      entry.succeeded += observed.succeeded;
      entry.failed += observed.failed;
      entry.unknownUsage += observed.unknownUsage;
      entry.promptTokens += observed.promptTokens;
      entry.completionTokens += observed.completionTokens;
      entry.cachedTokens += observed.cachedTokens;
      entry.totalTokens += observed.totalTokens;
      merged.set(key, entry);
    }
  }
  return sortRouteUsage([...merged.values()]);
}

export function aggregateUsageStats(
  computedList: readonly ComputedSessionUsage[],
  filter?: UsageFilter,
): UsageStatsDto {
  const filtered = computedList.filter((item) =>
    matchesUsageFilter(item.stat, filter),
  );

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;
  let totalRuns = 0;

  const modelMap = new Map<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      totalTokens: number;
      runCount: number;
      sessionCount: number;
    }
  >();

  const dailyMap = new Map<
    string,
    {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      totalTokens: number;
      runCount: number;
    }
  >();

  for (const item of filtered) {
    const { stat, runStats } = item;
    totalPromptTokens += stat.promptTokens;
    totalCompletionTokens += stat.completionTokens;
    totalCachedTokens += stat.cachedTokens;
    totalRuns += stat.runCount;

    // Aggregate by model
    const m = modelMap.get(stat.model) ?? {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      runCount: 0,
      sessionCount: 0,
    };
    m.promptTokens += stat.promptTokens;
    m.completionTokens += stat.completionTokens;
    m.cachedTokens += stat.cachedTokens;
    m.totalTokens += stat.totalTokens;
    m.runCount += stat.runCount;
    m.sessionCount += 1;
    modelMap.set(stat.model, m);

    // Aggregate by day
    for (const r of runStats) {
      if (filter?.days && filter.days > 0) {
        const runTime = Date.parse(r.date);
        if (
          Number.isFinite(runTime) &&
          runTime < Date.now() - filter.days * 86_400_000
        ) {
          continue;
        }
      }
      const d = dailyMap.get(r.date) ?? {
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        runCount: 0,
      };
      d.promptTokens += r.promptTokens;
      d.completionTokens += r.completionTokens;
      d.cachedTokens += r.cachedTokens;
      d.totalTokens += r.totalTokens;
      d.runCount += 1;
      dailyMap.set(r.date, d);
    }
  }

  const models: ModelUsageStat[] = Array.from(modelMap.entries())
    .map(([model, data]) => ({
      model,
      ...data,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const daily: DailyUsageStat[] = Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      ...data,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topSessions: SessionUsageStat[] = [...filtered]
    .map((item) => item.stat)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 20);

  const routes = aggregateRouteUsageStats(filtered);
  const cutoff = filter?.days ? Date.now() - filter.days * 86_400_000 : undefined;
  const requests = computedList.flatMap(item => item.requests).filter(request =>
    (!filter?.workspace || request.workspace === filter.workspace) &&
    (cutoff === undefined || Date.parse(request.timestamp) >= cutoff),
  ).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
  const averageCacheRate =
    totalPromptTokens > 0
      ? Math.min(1, Math.max(0, totalCachedTokens / totalPromptTokens))
      : 0;

  return {
    totalPromptTokens,
    totalCompletionTokens,
    totalCachedTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    totalSessions: filtered.length,
    totalRuns,
    averageCacheRate,
    models,
    daily,
    topSessions,
    ...(routes.length ? { routes } : {}),
    requests,
  };
}

export function createUsageStatsService(
  store: SessionStore,
  pricing: ModelPricingService = createModelPricingService(),
) {
  const cache = new Map<
    string,
    { updatedAt: string; computed: ComputedSessionUsage }
  >();

  return {
    async getUsageStats(filter?: UsageFilter): Promise<UsageStatsDto> {
      const summaries = await store.list();
      const targetSummaries = summaries.filter((s) => {
        if (filter?.workspace && s.workspace !== filter.workspace) return false;
        if (filter?.days && filter.days > 0) {
          const updatedTime = Date.parse(s.updatedAt);
          if (
            Number.isFinite(updatedTime) &&
            updatedTime < Date.now() - filter.days * 86_400_000
          ) {
            return false;
          }
        }
        return true;
      });

      const computedList: ComputedSessionUsage[] = [];

      for (const summary of targetSummaries) {
        const cached = cache.get(summary.id);
        if (cached && cached.updatedAt === summary.updatedAt) {
          computedList.push(cached.computed);
        } else {
          try {
            const snapshot = await store.get(summary.id);
            const computed = computeSessionUsage(snapshot);
            cache.set(summary.id, {
              updatedAt: summary.updatedAt,
              computed,
            });
            computedList.push(computed);
          } catch {
            // If session fails to load, skip gracefully
          }
        }
      }

      const stats = aggregateUsageStats(computedList, filter);
      if (!stats.requests?.some(request => request.usage !== undefined)) return stats;
      const prices = await pricing.getPrices();
      return {
        ...stats,
        requests: stats.requests.map(request => {
          const estimatedCostUsd = estimateRequestCostUsd(request.usage, findModelPrice(prices, request.model));
          return estimatedCostUsd === undefined ? request : { ...request, estimatedCostUsd };
        }),
      };
    },
  };
}
