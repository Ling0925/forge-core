import type { AgentRuntimeDependencies } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { RootRunBudget } from "../shared/run-budget";
import type { RunInput, Usage } from "../shared/schemas";
import { projectSummary } from "./context";
import { HARNESS_PROBE_TOOLS, adaptHarness } from "./harness-adaptation";
import { buildSystemInstructions } from "./prompts";
import type { createRunEvents } from "./runtime-events";
import type { LoadedRunState } from "./runtime-state";

/** Run collaborators used by the Harness adaptation preflight. */
export type RunPreflightScope = {
  run: LoadedRunState;
  input: RunInput;
  deps: AgentRuntimeDependencies;
  signal: AbortSignal;
  rootBudget: RootRunBudget;
  check: () => void;
  save: () => Promise<void>;
  event: ReturnType<typeof createRunEvents>["event"];
  onModelUsage: (usage: Usage | undefined) => void;
};

/**
 * Harness adaptation preflight: read-only probes under plan permission pick a
 * strategy (or keep the baseline) before the formal task's first step.
 */
export const runHarnessPreflight = async (
  {
    run,
    input,
    deps,
    signal,
    rootBudget,
    check,
    save,
    event,
    onModelUsage,
  }: RunPreflightScope,
  harness: NonNullable<RunInput["harness"]>,
): Promise<void> => {
  const host = deps.harnessAdaptation;
  if (!host)
    throw new ForgeError(
      "invalid_input",
      "This runtime host does not support Harness adaptation.",
    );
  if (run.snapshot.routeGroupId)
    throw new ForgeError(
      "invalid_input",
      "Harness adaptation requires a direct model selection, not a route group.",
    );
  if (harness.experience === "read-write" && !host.experiences)
    throw new ForgeError(
      "invalid_input",
      "This runtime host does not support Harness experience persistence.",
    );
  run.phase = "provider";
  run.adaptation = await adaptHarness({
    input: harness,
    host,
    provider: deps.provider,
    sessionId: input.sessionId,
    workspace: run.snapshot.workspace,
    model: run.snapshot.model,
    messages: projectSummary(run.snapshot),
    signal,
    systemInstructions: buildSystemInstructions({
      session: run.snapshot,
      permission: "readonly",
      mode: "plan",
      projectInstructions: deps.projectInstructions,
      toolNames: HARNESS_PROBE_TOOLS,
    }),
    onUsage: onModelUsage,
    onToolCall: () => {
      check();
      const reservation = rootBudget.reserve(input.sessionId, 1);
      try {
        reservation.dispatch();
      } finally {
        reservation.release();
      }
    },
    onProgress: async (progress) => {
      check();
      event({ type: "harness_adaptation", progress });
      await save();
    },
  });
  check();
};
