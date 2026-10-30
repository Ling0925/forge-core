import type { RootRunBudget } from "../shared/run-budget";
import type { SessionId, Usage } from "../shared/schemas";
import type { RunState } from "./runtime-state";

/**
 * Accounts auxiliary model usage (summaries, tools, preflight) to the root
 * budget and to the run's own totals; a missing report marks usage incomplete.
 */
export const createModelUsageObserver = (
  run: RunState,
  rootBudget: RootRunBudget,
  sessionId: SessionId,
) => {
  const onModelUsage = (incoming: Usage | undefined) => {
    rootBudget.observeUsage(sessionId, incoming);
    if (!incoming) {
      run.auxiliaryUsageComplete = false;
      return;
    }
    const cached =
      incoming.cachedPromptTokens === undefined
        ? run.usage.cachedPromptTokens
        : (run.usage.cachedPromptTokens ?? 0) + incoming.cachedPromptTokens;
    run.usage = {
      promptTokens: run.usage.promptTokens + incoming.promptTokens,
      completionTokens: run.usage.completionTokens + incoming.completionTokens,
      totalTokens: run.usage.totalTokens + incoming.totalTokens,
      ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    };
  };
  return onModelUsage;
};
