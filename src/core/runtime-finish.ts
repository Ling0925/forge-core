import type { AdvisorCoordinator } from "../shared/agent-coordination";
import type { AgentRuntimeDependencies, RunControl } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { HARNESS_ADAPTATION_DEFAULTS } from "../shared/harness-adaptation";
import type { RootRunBudget } from "../shared/run-budget";
import { agentEventSchema } from "../shared/schemas";
import type {
  Permission,
  RunInput,
  SessionSnapshot,
  Usage,
} from "../shared/schemas";
import { addUsage } from "../shared/usage-totals";
import type { createAgentSupervisor } from "./agent-supervisor";
import { agentSummary } from "./agents";
import type { createRunEvents } from "./runtime-events";
import type { createRuntimeJournal } from "./runtime-journal";
import { previousRunPermission } from "./runtime-permission";
import type { RunState } from "./runtime-state";
import type { createToolHookService } from "./tool-hooks";

type RunEvents = ReturnType<typeof createRunEvents>;
type RuntimeJournal = ReturnType<typeof createRuntimeJournal>;

export type RunFinishDeps = {
  run: RunState;
  input: RunInput;
  deps: AgentRuntimeDependencies;
  signal: AbortSignal;
  control: RunControl | undefined;
  rootBudget: RootRunBudget;
  hooks: ReturnType<typeof createToolHookService> | undefined;
  advisor: AdvisorCoordinator;
  supervisor: ReturnType<typeof createAgentSupervisor>;
  save: RuntimeJournal["save"];
  settleWrites: RuntimeJournal["settle"];
  includeSteering: RuntimeJournal["includeSteering"];
  closeSteering: () => void;
  event: RunEvents["event"];
  notify: RunEvents["notify"];
  now: () => string;
  closeStep: RunEvents["closeStep"];
  hookDiagnostics: RunEvents["hookDiagnostics"];
  effectivePermission: () => Permission;
};

/**
 * Terminal sequence of a run: join children, run end hooks, record the final
 * permission and run_finished, promote a verified harness experience, then
 * checkpoint recent state. Returns the terminal snapshot.
 */
export const createRunFinish = ({
  run,
  input,
  deps,
  signal,
  control,
  rootBudget,
  hooks,
  advisor,
  supervisor,
  save,
  settleWrites,
  includeSteering,
  closeSteering,
  event,
  notify,
  now,
  closeStep,
  hookDiagnostics,
  effectivePermission,
}: RunFinishDeps) => {
  const finish = async (
    requestedStatus: "completed" | "cancelled" | "failed",
  ): Promise<SessionSnapshot> => {
    closeSteering();
    await settleWrites();
    let status = requestedStatus;
    if (!run.snapshot)
      throw new ForgeError("internal", "Session has not loaded.");
    await advisor.close(status === "cancelled" ? "cancelled" : "interrupted");
    const joined = await supervisor.settle(status !== "completed");
    for (const c of joined.snapshots) {
      const report = agentSummary(c, 256);
      event({
        type: "agent_update",
        childSessionId: c.id,
        model: c.model,
        status: c.status,
        summary: JSON.stringify({
          id: c.id,
          status: c.status,
          summary: report.summary,
          truncated: report.truncated,
          errors: report.errors,
        }),
      });
    }
    if (status === "completed" && joined.unhandledFailure) status = "failed";
    if (signal.aborted) status = "cancelled";
    if (status === "completed" && run.hookFailed) status = "failed";
    if (hooks?.configured && !run.ranEndHooks) {
      run.ranEndHooks = true;
      hookDiagnostics(
        await hooks.runEnd(
          {
            session: {
              sessionId: input.sessionId,
              workspace: run.snapshot.workspace,
              permission: effectivePermission(),
            },
            run: {
              status,
              toolCalls: run.toolCalls,
              steps: run.steps + (run.activeStep === undefined ? 0 : 1),
            },
          },
          { signal },
        ),
      );
    }
    if (status === "completed" && run.hookFailed) status = "failed";
    if (signal.aborted) status = "cancelled";
    closeStep(status);
    // Cancellation/failure must not erase messages already acknowledged to the
    // sender. Keep them in history, without starting another run implicitly.
    includeSteering();
    const childUsage = supervisor
      .operations()
      .reduce(
        (sum, child) => (child.usage ? addUsage(sum, child.usage) : sum),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as Usage,
      );
    rootBudget.finishSession(
      input.sessionId,
      status,
      status !== "completed" && run.stopReason === "completed"
        ? "child_or_hook_failure"
        : run.stopReason,
    );
    // Completion notifications must not inherit the permission from run start
    // after the user lowered it during inference. Freeze host updates before
    // the final checkpoint; no acknowledged change can race that snapshot.
    control?.onFinalizing?.();
    const finalPermission = effectivePermission();
    if (previousRunPermission(run.snapshot.events) !== finalPermission)
      event({ type: "permission_changed", permission: finalPermission });
    const terminal = agentEventSchema.parse({
      type: "run_finished",
      budget: rootBudget.snapshot(
        run.snapshot.parentSessionId ? input.sessionId : undefined,
      ),
      sessionId: input.sessionId,
      timestamp: now(),
      status,
      ...(run.turn === undefined ? {} : { turn: run.turn }),
      turns: run.turns,
      steps: run.steps,
      retries: run.retries,
      messageIndex: run.snapshot.messages.length,
      toolCalls: run.toolCalls,
      usage: run.usage,
      usageComplete:
        run.auxiliaryUsageComplete &&
        !run.hadProviderRetries &&
        run.reportedUsageTurns === run.turns,
      ...(supervisor.size
        ? {
            childUsage,
            totalUsage: addUsage(run.usage, childUsage),
            childUsageComplete: supervisor
              .operations()
              .every((child) => child.usageComplete === true),
          }
        : {}),
    });
    run.snapshot = {
      ...run.snapshot,
      status,
      events: [...run.snapshot.events, terminal],
    };
    await save();
    // Library promotion happens only after the formal task's successful
    // terminal state is durable. Plan/readonly and failed runs cannot promote.
    if (
      status === "completed" &&
      !signal.aborted &&
      effectivePermission() !== "readonly" &&
      input.harness?.experience === "read-write" &&
      run.adaptation?.status === "adopted" &&
      deps.harnessAdaptation?.experiences
    ) {
      try {
        const verified = run.adaptation.probes.find(
          (probe) => probe.id === "composed",
        );
        const experience = await deps.harnessAdaptation.experiences.save({
          scope: {
            workspace: run.snapshot.workspace,
            model: run.snapshot.model,
            domain: input.harness.domain ?? HARNESS_ADAPTATION_DEFAULTS.domain,
          },
          sessionId: input.sessionId,
          reportId: run.adaptation.id,
          strategy: run.adaptation.strategy,
          lesson: run.adaptation.rationale,
          evidence: (verified?.evidence ?? [])
            .filter(
              (item) =>
                !item.isError && run.adaptation?.evidenceIds.includes(item.id),
            )
            .slice(0, 4)
            .map((item) => `${item.tool}: ${item.observation}`.slice(0, 2048)),
        });
        event({
          type: "harness_adaptation",
          progress: { phase: "experience", experienceId: experience.id },
        });
        await save();
      } catch {
        // Completed user effects are not replayed because optional learning
        // failed. Surface the storage failure without disguising task success.
        notify(
          agentEventSchema.parse({
            type: "error",
            sessionId: run.snapshot.id,
            timestamp: now(),
            error: {
              code: "storage",
              message:
                "Harness experience could not be recorded; the completed task was not replayed.",
              retryable: false,
            },
          }),
        );
      }
    }
    try {
      await deps.runMemory?.record(run.snapshot);
    } catch {
      notify(
        agentEventSchema.parse({
          type: "error",
          sessionId: run.snapshot.id,
          timestamp: now(),
          error: {
            code: "storage",
            message:
              "Recent-state checkpoint could not be saved; original session history is intact.",
            retryable: true,
          },
        }),
      );
    }
    notify(terminal);
    return run.snapshot;
  };
  return finish;
};
