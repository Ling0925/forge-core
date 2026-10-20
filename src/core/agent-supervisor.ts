import type {
  AgentRuntime,
  AgentRuntimeDependencies,
  ApprovalHandler,
} from "../shared/contracts";
import type {
  AgentEvent,
  ApprovalRequest,
  SessionId,
  SessionSnapshot,
} from "../shared/schemas";
import { toolActivity } from "../shared/tool-activity";
import {
  type AgentEnvironment,
  type ChildOperation,
  boundedReports,
  childReport,
} from "./agent-operations";
import type { ApprovalQueue } from "./approval-queue";
import { withCancellation } from "./cancellation";

type AgentUpdate = Omit<
  Extract<AgentEvent, { type: "agent_update" }>,
  "sessionId" | "timestamp" | "turn" | "step"
>;
interface SupervisorOptions {
  deps: AgentRuntimeDependencies;
  parentSessionId: SessionId;
  parentModel(): string;
  signal: AbortSignal;
  approvalQueue: ApprovalQueue;
  approve: ApprovalHandler;
  emitUpdate(update: AgentUpdate): void;
  emitApproval(request: ApprovalRequest): void;
  /** Inject construction to keep this lifecycle owner independent of the coordinator. */
  createRuntime(deps: AgentRuntimeDependencies): AgentRuntime;
}

/**
 * Own current-run child operations and their tool/context resources. Native agent
 * operations remain the single owner of registration, limits and delivery state.
 * No parent snapshot access: the coordinator commits reports and chooses terminal.
 */
export function createAgentSupervisor(options: SupervisorOptions) {
  const { deps, signal } = options;
  const children = new Map<string, ChildOperation>();
  const runChild: AgentEnvironment["runChild"] = async (
    input,
    approve,
    childSignal,
    control,
    maxToolCalls,
  ) => {
    let tools: typeof deps.tools | undefined;
    try {
      deps.rootBudget?.checkAdmission();
      if (childSignal.aborted) throw new Error("Child construction cancelled.");
      const workspace = (await deps.store.get(input.sessionId)).workspace;
      deps.rootBudget?.checkAdmission();
      const context = await deps.childContextFactory?.(workspace);
      tools = context?.tools;
      deps.rootBudget?.checkAdmission();
      if (childSignal.aborted) throw new Error("Child construction cancelled.");
      tools ??= deps.childToolFactory
        ? await deps.childToolFactory(workspace)
        : deps.tools;
      deps.rootBudget?.checkAdmission();
      if (childSignal.aborted) throw new Error("Child construction cancelled.");
      return await options
        .createRuntime({
          ...deps,
          tools,
          ...(context ? { projectInstructions: context.instructions } : {}),
          settings: {
            ...deps.settings,
            maxToolCalls: maxToolCalls ?? deps.settings.maxToolCalls,
          },
        })
        .run(
          input,
          (childEvent) => {
            if (childEvent.type === "run_finished") {
              const operation = children.get(input.sessionId);
              if (operation) {
                if (childEvent.usage) operation.usage = childEvent.usage;
                if (childEvent.usageComplete !== undefined)
                  operation.usageComplete = childEvent.usageComplete;
              }
            }
            if (
              childEvent.type === "tool_started" ||
              childEvent.type === "tool_finished"
            ) {
              // Bounded progress only. Arguments/results stay in the child transcript.
              options.emitUpdate({
                type: "agent_update",
                childSessionId: input.sessionId,
                model: input.model ?? options.parentModel(),
                status: "running",
                summary: "",
                ...(childEvent.type === "tool_started"
                  ? { currentTool: toolActivity(childEvent.call) }
                  : {}),
              });
            }
            // Completion must wait for disposal; a cleanup failure is not success.
            if (childEvent.type === "run_started")
              options.emitUpdate({
                type: "agent_update",
                childSessionId: input.sessionId,
                model: input.model ?? options.parentModel(),
                status: "running",
                summary: "Agent started",
              });
          },
          approve,
          childSignal,
          control,
        );
    } catch (error) {
      if (!tools) {
        const release = await deps.store.acquire(input.sessionId);
        try {
          const child = await deps.store.get(input.sessionId);
          const status = childSignal.aborted ? "cancelled" : "failed";
          await deps.store.save({ ...child, status });
          options.emitUpdate({
            type: "agent_update",
            childSessionId: child.id,
            model: child.model,
            status,
            summary: "Child tool construction failed",
          });
        } finally {
          await release();
        }
      }
      throw error;
    } finally {
      if (tools && tools !== deps.tools) await tools.dispose();
    }
  };
  const approveChild: AgentEnvironment["approveChild"] =
    (childId) => (request, approvalSignal) =>
      options.approvalQueue.enqueue(async () => {
        if (signal.aborted || approvalSignal.aborted) return false;
        const envelope = {
          ...request,
          sessionId: options.parentSessionId,
          childSessionId: childId,
          description: `[Child ${childId}] ${request.description}`.slice(
            0,
            8192,
          ),
        };
        options.emitApproval(envelope);
        return withCancellation(
          options.approve(envelope, approvalSignal),
          AbortSignal.any([signal, approvalSignal]),
        );
      });
  const onSettled: NonNullable<AgentEnvironment["onSettled"]> = (id, child) =>
    options.emitUpdate({
      type: "agent_update",
      childSessionId: id,
      model: child.model,
      status: child.executionError
        ? "failed"
        : (child.result?.status ?? "failed"),
      summary:
        "Agent settled after cleanup; result available through wait_agents/get_agent_result",
    });
  return {
    /** Mutable operations are exposed only to existing native agent operations. */
    native: { children, runChild, approveChild, onSettled },
    get size(): number {
      return children.size;
    },
    operations(): readonly Readonly<ChildOperation>[] {
      return [...children.values()];
    },
    async joinPending(): Promise<
      { reports: string; commitDelivery(): void } | undefined
    > {
      const pending = [...children.entries()].filter(
        ([, child]) => !child.delivered,
      );
      if (!pending.length) return undefined;
      await Promise.allSettled(pending.map(([, child]) => child.work));
      return {
        reports: boundedReports(pending, ([id, child], limit) =>
          childReport(id, child, limit),
        ),
        // Caller invokes only after its durable report commit succeeds.
        commitDelivery() {
          for (const [, child] of pending) child.delivered = true;
        },
      };
    },
    async settle(cancel: boolean): Promise<{
      snapshots: readonly SessionSnapshot[];
      unhandledFailure: boolean;
    }> {
      if (cancel)
        for (const child of children.values()) child.controller.abort();
      const joined = await Promise.allSettled(
        [...children.values()].map((child) => child.work),
      );
      return {
        snapshots: joined.flatMap((item) =>
          item.status === "fulfilled" ? [item.value] : [],
        ),
        unhandledFailure: [...children.values()].some(
          (child) =>
            !child.resolution &&
            (child.executionError || child.result?.status !== "completed"),
        ),
      };
    },
  };
}
