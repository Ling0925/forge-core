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
import type { AgentEvent, SessionSnapshot, Usage } from "../shared/schemas";
import { createModelPricingService, estimateRequestCostUsd, findModelPrice, type ModelPricingService } from "./model-pricing";

type TokenUsageStat = Pick<SessionUsageStat, "promptTokens" | "completionTokens" | "cachedTokens" | "totalTokens">;
type MutableTokenUsage = { -readonly [K in keyof TokenUsageStat]: TokenUsageStat[K] };

interface SessionUsageEntry extends TokenUsageStat {
  readonly model: string;
  readonly timestamp: string;
  /** Absent for legacy run usage not covered by individual request records. */
  readonly requestId?: string;
}

export interface SessionRunStat extends TokenUsageStat {
  readonly date: string;
  readonly entries: readonly SessionUsageEntry[];
}

const tokenUsage = (usage?: Usage): MutableTokenUsage => ({
  promptTokens: usage?.promptTokens ?? 0,
  completionTokens: usage?.completionTokens ?? 0,
  cachedTokens: usage?.cachedPromptTokens ?? 0,
  totalTokens: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
});

const sumTokenUsage = (entries: readonly TokenUsageStat[]): MutableTokenUsage => {
  const total = tokenUsage();
  for (const entry of entries) {
    total.promptTokens += entry.promptTokens;
    total.completionTokens += entry.completionTokens;
    total.cachedTokens += entry.cachedTokens;
    total.totalTokens += entry.totalTokens;
  }
  return total;
};

export interface ComputedSessionUsage {
  readonly stat: SessionUsageStat;
  readonly runStats: readonly SessionRunStat[];
  /** Separate route projection; never added on top of the deduplicated usage. */
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
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
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
      ...(started?.reasoningEffort === undefined ? {} : { reasoningEffort: started.reasoningEffort }),
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
  const requests = sessionRequestRecords(snapshot);
  const requestsByEvent = new Map(requests.map(request => [request.id, request]));
  const runStats: SessionRunStat[] = [];
  let current: {
    model: string;
    timestamp: string;
    requests: UsageRequest[];
    context: MutableTokenUsage;
  } | undefined;

  const ensureRun = (timestamp?: string) => current ??= {
    model: snapshot.model,
    timestamp: timestamp ?? snapshot.updatedAt,
    requests: [],
    context: tokenUsage(),
  };
  const finishRun = (usage?: Usage, timestamp?: string) => {
    if (!current) return;
    const reported = usage ? tokenUsage(usage) : current.context;
    const entries: SessionUsageEntry[] = current.requests.map(request => ({
      model: request.model,
      timestamp: request.timestamp,
      requestId: request.id,
      ...tokenUsage(request.usage),
    }));
    // context_usage and run_finished repeat successful request usage. Retain only
    // their uncovered remainder; failed attempts with reported usage are separate.
    const covered = sumTokenUsage(current.requests
      .filter(request => request.outcome === "succeeded")
      .map(request => tokenUsage(request.usage)));
    const remainder = {
      promptTokens: Math.max(0, reported.promptTokens - covered.promptTokens),
      completionTokens: Math.max(0, reported.completionTokens - covered.completionTokens),
      cachedTokens: Math.max(0, reported.cachedTokens - covered.cachedTokens),
    };
    const remainderTotal = remainder.promptTokens + remainder.completionTokens;
    if (remainderTotal > 0 || entries.length === 0) {
      entries.push({
        model: current.model,
        timestamp: timestamp ?? current.timestamp,
        ...remainder,
        cachedTokens: Math.min(remainder.promptTokens, remainder.cachedTokens),
        totalTokens: remainderTotal,
      });
    }
    runStats.push({
      date: (timestamp ?? current.timestamp).slice(0, 10),
      entries,
      ...sumTokenUsage(entries),
    });
    current = undefined;
  };

  for (const [index, event] of snapshot.events.entries()) {
    if (event.type === "run_started") {
      // An interrupted run may not have a finish event before the next starts.
      finishRun();
      ensureRun(event.timestamp).model = event.model;
    }
    const request = requestsByEvent.get(`${snapshot.id}:${index}`);
    if (request) ensureRun(request.timestamp).requests.push(request);
    if (event.type === "context_usage") {
      const u = event.usage;
      if (u.basis !== "projected" && u.promptTokens !== undefined) {
        const context = ensureRun(event.timestamp).context;
        context.promptTokens += u.promptTokens;
        context.completionTokens += u.completionTokens ?? 0;
        context.cachedTokens += u.cachedPromptTokens ?? 0;
        context.totalTokens = context.promptTokens + context.completionTokens;
      }
    } else if (event.type === "run_finished") {
      ensureRun(event.timestamp);
      finishRun(event.usage, event.timestamp);
    }
  }
  finishRun();

  const stat: SessionUsageStat = {
    sessionId: snapshot.id,
    title: snapshot.title,
    workspace: snapshot.workspace,
    model: snapshot.model,
    updatedAt: snapshot.updatedAt,
    ...sumTokenUsage(runStats),
    runCount: runStats.length,
  };

  return { stat, runStats, routing: routeUsageStats(snapshot.events), requests };
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
  const cutoff = filter?.days ? Date.now() - filter.days * 86_400_000 : undefined;
  const inPeriod = (timestamp: string) => cutoff === undefined || Date.parse(timestamp) >= cutoff;
  const filtered = computedList
    .filter(item => !filter?.workspace || item.stat.workspace === filter.workspace)
    .map(item => {
      const runStats = item.runStats.map(run => {
        const entries = run.entries.filter(entry => inPeriod(entry.timestamp));
        return { ...run, entries, ...sumTokenUsage(entries) };
      }).filter(run => run.entries.length > 0);
      return { ...item, runStats, stat: {
        ...item.stat, ...sumTokenUsage(runStats), runCount: runStats.length,
      } };
    })
    .filter(item => cutoff === undefined || item.runStats.length > 0);

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
      requestCount: number;
      costIncomplete: boolean;
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

    const sessionModels = new Set<string>();
    for (const run of runStats) {
      const runModels = new Set<string>();
      const runDates = new Set<string>();
      for (const entry of run.entries) {
        const m = modelMap.get(entry.model) ?? {
          ...tokenUsage(), runCount: 0, sessionCount: 0, requestCount: 0, costIncomplete: false,
        };
        m.promptTokens += entry.promptTokens;
        m.completionTokens += entry.completionTokens;
        m.cachedTokens += entry.cachedTokens;
        m.totalTokens += entry.totalTokens;
        if (!runModels.has(entry.model)) m.runCount += 1;
        if (!sessionModels.has(entry.model)) m.sessionCount += 1;
        if (entry.requestId) m.requestCount += 1;
        else if (entry.totalTokens > 0) m.costIncomplete = true;
        runModels.add(entry.model);
        sessionModels.add(entry.model);
        modelMap.set(entry.model, m);

        const date = entry.timestamp.slice(0, 10);
        const d = dailyMap.get(date) ?? { ...tokenUsage(), runCount: 0 };
        d.promptTokens += entry.promptTokens;
        d.completionTokens += entry.completionTokens;
        d.cachedTokens += entry.cachedTokens;
        d.totalTokens += entry.totalTokens;
        if (!runDates.has(date)) d.runCount += 1;
        runDates.add(date);
        dailyMap.set(date, d);
      }
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
  const requests = filtered.flatMap(item => item.requests).filter(request =>
    inPeriod(request.timestamp),
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
      const prices = stats.requests?.some(request => request.usage !== undefined)
        ? await pricing.getPrices() : new Map();
      const modelCosts = new Map<string, { estimatedCostUsd: number; pricedRequestCount: number }>();
      const requests = (stats.requests ?? []).map(request => {
        // Price lookup intentionally strips source/vendor prefixes. Accounting
        // still uses the exact recorded model, never the first short-name match.
        const estimatedCostUsd = estimateRequestCostUsd(request.usage, findModelPrice(prices, request.model));
        if (estimatedCostUsd === undefined) return request;
        const cost = modelCosts.get(request.model) ?? { estimatedCostUsd: 0, pricedRequestCount: 0 };
        cost.estimatedCostUsd += estimatedCostUsd;
        cost.pricedRequestCount += 1;
        modelCosts.set(request.model, cost);
        return { ...request, estimatedCostUsd };
      });
      return {
        ...stats,
        requests,
        models: stats.models.map(model => {
          const cost = modelCosts.get(model.model);
          const pricedRequestCount = cost?.pricedRequestCount ?? 0;
          return {
            ...model,
            ...(cost ? { estimatedCostUsd: cost.estimatedCostUsd } : {}),
            pricedRequestCount,
            costIncomplete: model.costIncomplete || pricedRequestCount < (model.requestCount ?? 0),
          };
        }),
      };
    },
  };
}
