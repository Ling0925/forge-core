import { advisorRequestSchema } from "../shared/agent-coordination";
import type {
  AgentRuntimeDependencies,
  ApprovalHandler,
} from "../shared/contracts";
import { ForgeError, toErrorInfo } from "../shared/errors";
import { recordPlan } from "../shared/plans";
import type { RootRunBudget } from "../shared/run-budget";
import { sessionIdSchema } from "../shared/schemas";
import type {
  Permission,
  ProviderResponse,
  RunInput,
  ToolCall,
  Usage,
} from "../shared/schemas";
import type { createAgentSupervisor } from "./agent-supervisor";
import { executeNative, nativeDefinitions } from "./agents";
import type { createApprovalQueue } from "./approval-queue";
import type { createRunEvents } from "./runtime-events";
import type { createGenerationStream } from "./runtime-generation";
import type { createRuntimeJournal } from "./runtime-journal";
import type { LoadedRunState } from "./runtime-state";
import {
  executeReadBatch,
  executeToolCall,
  planReadBatch,
} from "./tool-executor";
import type { createToolFailureGuard } from "./tool-failure-guard";
import type { createToolHookService } from "./tool-hooks";

type RunEvents = ReturnType<typeof createRunEvents>;

/** Run collaborators used while executing one response's tool calls. */
export type RunToolScope = {
  run: LoadedRunState;
  input: RunInput;
  deps: AgentRuntimeDependencies;
  runtimeDeps: AgentRuntimeDependencies & { rootBudget: RootRunBudget };
  signal: AbortSignal;
  rootBudget: RootRunBudget;
  hooks: ReturnType<typeof createToolHookService> | undefined;
  hasToolHooks: boolean;
  approvalQueue: ReturnType<typeof createApprovalQueue>;
  approve: ApprovalHandler;
  supervisor: ReturnType<typeof createAgentSupervisor>;
  check: () => void;
  save: ReturnType<typeof createRuntimeJournal>["save"];
  event: RunEvents["event"];
  ephemeral: RunEvents["ephemeral"];
  closeStep: RunEvents["closeStep"];
  hookDiagnostics: RunEvents["hookDiagnostics"];
  effectivePermission: () => Permission;
  onModelUsage: (usage: Usage | undefined) => void;
  checkToolFailure: ReturnType<typeof createToolFailureGuard>;
};

/**
 * Execute every tool call of one provider response and persist each result:
 * a lone-advisor violation rejects the whole batch, adjacent safe reads run
 * concurrently, everything else runs one by one with durable intent.
 * Closes the current step when done.
 */
export const executeResponseToolCalls = async (
  {
    run,
    input,
    deps,
    runtimeDeps,
    signal,
    rootBudget,
    hooks,
    hasToolHooks,
    approvalQueue,
    approve,
    supervisor,
    check,
    save,
    event,
    ephemeral,
    closeStep,
    hookDiagnostics,
    effectivePermission,
    onModelUsage,
    checkToolFailure,
  }: RunToolScope,
  {
    calls,
    response,
    previews,
    allowTool,
  }: {
    calls: readonly ToolCall[];
    response: ProviderResponse;
    previews: ReturnType<typeof createGenerationStream>["previews"];
    allowTool: (name: string, args?: unknown) => boolean;
  },
): Promise<void> => {
  if (new Set(calls.map((call) => call.id)).size !== calls.length)
    throw new ForgeError(
      "provider",
      "Provider returned duplicate tool call identifiers.",
    );
  if (
    calls.length > 1 &&
    calls.some((call) => call.function.name === "advisor")
  ) {
    const result = {
      isError: true,
      content:
        "advisor must be the ONLY tool call in a response. No call in this batch executed. Submit the question alone, then inspect its answer before further actions.",
    };
    for (const [callIndex, call] of calls.entries()) {
      event({
        type: "tool_started",
        call,
        generationId: response.message.generationId,
        callIndex,
      });
      run.snapshot = {
        ...run.snapshot,
        messages: [
          ...run.snapshot.messages,
          {
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          },
        ],
      };
      event({
        type: "tool_finished",
        toolCallId: call.id,
        generationId: response.message.generationId,
        callIndex,
        result,
      });
    }
    if (previews.size)
      ephemeral({
        type: "tool_preview_reset",
        generationId: response.message.generationId,
      });
    closeStep("completed");
    await save();
    const advisorCall = calls.find((call) => call.function.name === "advisor");
    if (advisorCall) checkToolFailure(advisorCall, result);
    return;
  }
  // All parameters are now complete and validated; queued calls are no
  // longer generating while an earlier call executes or waits for approval.
  if (previews.size)
    ephemeral({
      type: "tool_preview_reset",
      generationId: response.message.generationId,
    });
  for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
    const call = calls[callIndex];
    if (!call) throw new ForgeError("internal", "Missing tool call.");
    check();
    rootBudget.checkAdmission();
    const readBatch = planReadBatch(calls, callIndex, {
      hasHooks: hasToolHooks,
      permission: effectivePermission,
      tools: deps.tools,
      allowTool,
    });
    if (readBatch.length > 1) {
      const reservation = rootBudget.reserve(input.sessionId, readBatch.length);
      let outcomes: PromiseSettledResult<
        import("../shared/schemas").ToolResult
      >[];
      try {
        for (const [offset, read] of readBatch.entries()) {
          const previewId = previews.id(callIndex + offset);
          event({
            type: "tool_started",
            call: read,
            generationId: response.message.generationId,
            callIndex: callIndex + offset,
            ...(previewId ? { previewId } : {}),
          });
        }
        await save();
        check();
        reservation.dispatch(readBatch.length);
        run.toolCalls += readBatch.length;
        run.phase = "tool";
        outcomes = await executeReadBatch(readBatch, {
          tools: deps.tools,
          sessionId: input.sessionId,
          workspace: run.snapshot.workspace,
          permission: effectivePermission,
          signal,
          onModelUsage,
          allowTool,
        });
      } finally {
        reservation.release();
      }
      check();
      run.phase = "storage";
      for (const [offset, outcome] of outcomes.entries()) {
        const read = readBatch[offset];
        if (!read) throw new ForgeError("internal", "Missing read result.");
        const result =
          outcome.status === "fulfilled"
            ? outcome.value
            : {
                content: JSON.stringify(toErrorInfo(outcome.reason)),
                isError: true,
              };
        run.snapshot = {
          ...run.snapshot,
          messages: [
            ...run.snapshot.messages,
            {
              role: "tool",
              tool_call_id: read.id,
              content: JSON.stringify(result),
            },
          ],
        };
        event({
          type: "tool_finished",
          toolCallId: read.id,
          generationId: response.message.generationId,
          callIndex: callIndex + offset,
          result,
        });
      }
      await save();
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected")
        throw new ForgeError(
          "tool",
          "Concurrent read failed; all reads have settled.",
        );
      for (const [offset, outcome] of outcomes.entries()) {
        const read = readBatch[offset];
        if (read && outcome.status === "fulfilled")
          checkToolFailure(read, outcome.value);
      }
      callIndex += readBatch.length - 1;
      continue;
    }
    const reservation = rootBudget.reserve(input.sessionId, 1);
    try {
      run.snapshot = { ...run.snapshot, pendingTool: call };
      await save();
      check();
      reservation.dispatch();
      run.toolCalls += 1;
    } finally {
      reservation.release();
    }
    const previewId = previews.id(callIndex);
    event({
      type: "tool_started",
      call,
      generationId: response.message.generationId,
      callIndex,
      ...(previewId ? { previewId } : {}),
    });
    run.phase = "tool";
    const toolSnapshot = run.snapshot;
    const executed = await executeToolCall({
      call,
      sessionId: input.sessionId,
      workspace: run.snapshot.workspace,
      tools: deps.tools,
      permission: effectivePermission,
      signal,
      check,
      hooks,
      onModelUsage,
      allowTool,
      diagnostics: (items) => hookDiagnostics(items, call.id),
      checkpointApproval: async (status) => {
        if (!run.snapshot)
          throw new ForgeError("internal", "Session has not loaded.");
        run.snapshot = { ...run.snapshot, status };
        event({ type: "state_changed", status });
        await save();
      },
      requestApproval: (request, approvalSignal) =>
        approvalQueue.enqueue(() => {
          check();
          event({ type: "approval_requested", request });
          return approve(request, approvalSignal);
        }),
      native: nativeDefinitions.some(
        (item) => item.function.name === call.function.name,
      )
        ? () =>
            executeNative(
              call.function.name,
              JSON.parse(call.function.arguments),
              {
                deps: runtimeDeps,
                snapshot: toolSnapshot,
                input,
                get permission() {
                  return effectivePermission();
                },
                signal,
                toolCallId: call.id,
                canDelegate: run.canDelegate,
                ...supervisor.native,
                saveResolution: async (id, childUpdatedAt, resolution) => {
                  if (!run.snapshot)
                    throw new ForgeError("internal", "Session unavailable");
                  run.snapshot = {
                    ...run.snapshot,
                    agentResolutions: [
                      ...(run.snapshot.agentResolutions ?? []).filter(
                        (item) => item.id !== id,
                      ),
                      {
                        id: sessionIdSchema.parse(id),
                        childUpdatedAt,
                        resolution,
                      },
                    ],
                  };
                  await save();
                },
                savePlan: async (plan) => {
                  if (!run.snapshot)
                    throw new ForgeError("internal", "Session unavailable");
                  run.snapshot = {
                    ...run.snapshot,
                    ...recordPlan(run.snapshot, plan),
                  };
                  event({ type: "plan_updated", plan });
                  await save();
                },
              },
            )
        : undefined,
    });
    const { result } = executed;
    check();
    run.phase = "storage";
    const { pendingTool: _completed, ...withoutPending } = run.snapshot;
    run.snapshot = {
      ...withoutPending,
      messages: [
        ...run.snapshot.messages,
        {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        },
      ],
      changes: [...run.snapshot.changes, ...(result.changes ?? [])],
    };
    event({
      type: "tool_finished",
      toolCallId: call.id,
      generationId: response.message.generationId,
      callIndex,
      result,
    });
    await save();
    if (
      call.function.name === "advisor" &&
      !result.isError &&
      deps.advisorParent
    ) {
      const request = advisorRequestSchema.parse(JSON.parse(result.content));
      if (request.status === "answered")
        await deps.advisorParent.delivered(request.id);
    }
    if (executed.afterCommit) {
      await executed.afterCommit();
      await save();
    }
    checkToolFailure(call, result);
  }
  closeStep("completed");
  await save();
};
