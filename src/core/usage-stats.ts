import type { SessionSnapshot } from "../shared/schemas";
import type {
  DailyUsageStat,
  ModelUsageStat,
  SessionUsageStat,
  UsageFilter,
  UsageStatsDto,
} from "../shared/ipc";
import type { SessionStore } from "../shared/contracts";

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
}

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

  return { stat, runStats };
}

export function aggregateUsageStats(
  computedList: readonly ComputedSessionUsage[],
  filter?: UsageFilter,
): UsageStatsDto {
  const filtered = computedList.filter((item) => {
    if (filter?.workspace && item.stat.workspace !== filter.workspace) {
      return false;
    }
    if (filter?.days && filter.days > 0) {
      const updatedTime = Date.parse(item.stat.updatedAt);
      if (
        Number.isFinite(updatedTime) &&
        updatedTime < Date.now() - filter.days * 86_400_000
      ) {
        return false;
      }
    }
    return true;
  });

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
  };
}

export function createUsageStatsService(store: SessionStore) {
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

      return aggregateUsageStats(computedList, filter);
    },
  };
}
