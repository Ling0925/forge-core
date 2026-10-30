import type { RootRunBudget } from "../shared/run-budget";
import type { SessionId, Usage } from "../shared/schemas";
import { addUsage } from "../shared/usage-totals";
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
    run.usage = addUsage(run.usage, incoming);
  };
  return onModelUsage;
};
