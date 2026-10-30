import {
  type ContextBudget,
  budgetUsage,
  measureContext,
} from "../shared/context-usage";
import type { AgentRuntimeDependencies } from "../shared/contracts";
import type { RootRunBudget } from "../shared/run-budget";
import type {
  ContextUsage,
  Message,
  SessionSnapshot,
  ToolDefinition,
  Usage,
} from "../shared/schemas";
import { summaryBoundary } from "./context";
import { compactContext, isHumanTurn } from "./runtime-context";
import type { createRunEvents } from "./runtime-events";
import type { LoadedRunState } from "./runtime-state";
import { summarizeWorkingState } from "./working-memory";

/** Run collaborators used to fit one step's request into the context budget. */
export type RunCompactionScope = {
  run: LoadedRunState;
  deps: AgentRuntimeDependencies;
  signal: AbortSignal;
  rootBudget: RootRunBudget;
  save: () => Promise<void>;
  event: ReturnType<typeof createRunEvents>["event"];
  onModelUsage: (usage: Usage | undefined) => void;
};

/**
 * Fit the next request into the budget: summarize older turns into working
 * memory when over the limit, then hard-trim the projection, and report the
 * projected context usage for the step.
 */
export const prepareStepContext = async (
  {
    run,
    deps,
    signal,
    rootBudget,
    save,
    event,
    onModelUsage,
  }: RunCompactionScope,
  {
    project,
    contextSize,
    calibratedSize,
    rawLimit,
    rawTarget,
    budget,
    windowTokens,
    definitions,
    currentInstructions,
  }: {
    project: (state: SessionSnapshot) => Message[];
    contextSize: (messages: readonly Message[]) => number;
    calibratedSize: (messages: readonly Message[]) => number;
    rawLimit: number;
    rawTarget: number;
    budget: ContextBudget;
    windowTokens: number;
    definitions: readonly ToolDefinition[];
    /** The step's system instructions; summaryBoundary measures with them. */
    currentInstructions: string;
  },
): Promise<{
  context: ReturnType<typeof compactContext>;
  projectedUsage: ContextUsage;
}> => {
  const before = project(run.snapshot);
  if (calibratedSize(before) > budget.limit) {
    // Search for a boundary in raw-estimate units: that is what the
    // estimator reports, and the hard trim below uses the same units.
    let boundary = summaryBoundary(
      run.snapshot,
      (messages) =>
        contextSize(
          messages.map((m, i) =>
            i === 0 && m.role === "system"
              ? { role: "system", content: currentInstructions }
              : m,
          ),
        ),
      rawTarget,
    );
    // If three recent turns alone exceed the hard budget, retain fewer
    // whole turns rather than silently discarding their meaning.
    if (boundary === null) {
      const latest = run.snapshot.messages.findLastIndex(isHumanTurn);
      if (
        latest > (run.snapshot.contextSummary?.boundary ?? 0) &&
        run.snapshot.messages
          .slice(run.snapshot.contextSummary?.boundary ?? 0, latest)
          .some((m) => m.role !== "system")
      )
        boundary = latest;
    }
    if (boundary !== null) {
      rootBudget.checkAdmission();
      const summarized = await summarizeWorkingState(
        run.snapshot,
        deps.provider,
        signal,
        boundary,
        Math.floor(windowTokens * 0.8),
        onModelUsage,
      );
      run.snapshot = {
        ...run.snapshot,
        contextSummary: summarized.contextSummary,
      };
      await save();
      event({
        type: "context_compacted",
        removedMessages: Math.max(
          0,
          before.length - project(run.snapshot).length,
        ),
        beforeChars: JSON.stringify(before).length,
        afterChars: JSON.stringify(project(run.snapshot)).length,
      });
    }
  }
  const context = compactContext(project(run.snapshot), rawLimit, contextSize);
  if (context.removedMessages > 0)
    event({
      type: "context_compacted",
      removedMessages: context.removedMessages,
      beforeChars: context.beforeChars,
      afterChars: context.afterChars,
    });
  const projectedUsage = {
    ...measureContext(context.messages, windowTokens, definitions),
    ...budgetUsage(budget),
  };
  event({ type: "context_usage", usage: projectedUsage });
  return { context, projectedUsage };
};
