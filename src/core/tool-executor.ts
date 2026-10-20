import type { ApprovalHandler, LocalToolRegistry } from "../shared/contracts";
import { ForgeError, toErrorInfo } from "../shared/errors";
import {
  type Permission,
  type SessionId,
  type ToolCall,
  type ToolResult,
  agentEventSchema,
  toolResultSchema,
} from "../shared/schemas";
import type { ToolHookDiagnostic, ToolHookService } from "../shared/tool-hooks";
import { invalidToolInput } from "../shared/tool-input";
import { nativeDefinitions } from "./agents";
import { withCancellation } from "./cancellation";
import { toToolHookOutcome } from "./tool-hooks";

const readonlyToolNames = new Set([
  "list_files",
  "read_file",
  "read_command_output",
  "search_files",
  "project_context",
  "load_skill",
  "git_status",
  "git_diff",
  "git_log",
]);

/** Pure admission: no effects, budget mutation, event emission or persistence. */
export function planReadBatch(
  calls: readonly ToolCall[],
  index: number,
  remaining: number,
  options: {
    hasHooks: boolean;
    permission(): Permission;
    tools: LocalToolRegistry;
  },
): ToolCall[] {
  const batch: ToolCall[] = [];
  for (const candidate of calls.slice(index, index + Math.min(4, remaining))) {
    if (
      options.hasHooks ||
      nativeDefinitions.some(
        (item) => item.function.name === candidate.function.name,
      ) ||
      (options.permission() === "readonly" &&
        !readonlyToolNames.has(candidate.function.name)) ||
      options.tools.isConcurrencySafe?.(candidate) !== true
    )
      break;
    batch.push(candidate);
  }
  return batch;
}
/** Own and join every started read. The coordinator alone commits ordered outcomes. */
export function executeReadBatch(
  calls: readonly ToolCall[],
  options: {
    tools: LocalToolRegistry;
    sessionId: SessionId;
    workspace: string;
    permission(): Permission;
    signal: AbortSignal;
  },
): Promise<PromiseSettledResult<ToolResult>[]> {
  return Promise.allSettled(
    calls.map(async (call) => {
      const result = toolResultSchema.parse(
        await options.tools.execute(call, {
          sessionId: options.sessionId,
          toolCallId: call.id,
          workspace: options.workspace,
          get permission() {
            return options.permission();
          },
          signal: options.signal,
          approve: async () => {
            throw new ForgeError(
              "tool",
              "Concurrent read requested an approval.",
            );
          },
          onEvent: () => undefined,
        }),
      );
      if (result.changes?.length)
        throw new ForgeError("tool", "Concurrent read reported file changes.");
      return result;
    }),
  );
}
interface ToolExecution {
  call: ToolCall;
  sessionId: SessionId;
  workspace: string;
  tools: LocalToolRegistry;
  signal: AbortSignal;
  permission(): Permission;
  check(): void;
  /** Explicit storage transitions; executor never reads/mutates the snapshot. */
  checkpointApproval(status: "awaiting_approval" | "running"): Promise<void>;
  requestApproval: ApprovalHandler;
  native?: (() => Promise<ToolResult>) | undefined;
  hooks?: ToolHookService | undefined;
  diagnostics(items: readonly ToolHookDiagnostic[]): void;
}
/**
 * Own one tool attempt, its approval/checkpoint work and hook invocation lifetime.
 * Caller must commit intent first, then commit returned result before afterCommit.
 */
export async function executeToolCall(options: ToolExecution): Promise<{
  result: ToolResult;
  afterCommit?: () => Promise<void>;
}> {
  const { call, signal, hooks } = options;
  let acceptingEvents = true;
  let requested = false;
  let toolEvents = 0;
  let approvalWork: Promise<boolean> | undefined;
  const approval: ApprovalHandler = (request, approvalSignal) => {
    const work = (async () => {
      options.check();
      if (
        !acceptingEvents ||
        requested ||
        request.sessionId !== options.sessionId ||
        request.toolCallId !== call.id
      )
        throw new ForgeError("tool", "Invalid or repeated approval request.");
      requested = true;
      await options.checkpointApproval("awaiting_approval");
      try {
        return await withCancellation(
          options.requestApproval(request, approvalSignal),
          AbortSignal.any([signal, approvalSignal]),
        );
      } finally {
        await options.checkpointApproval("running");
      }
    })();
    void work.catch(() => undefined);
    if (!approvalWork) approvalWork = work;
    return work;
  };
  const hookInput = {
    session: {
      sessionId: options.sessionId,
      workspace: options.workspace,
      get permission() {
        return options.permission();
      },
    },
    tool: {
      name: call.function.name,
      callId: call.id,
      arguments: call.function.arguments,
    },
  };
  const gate = await hooks?.beforeTool(hookInput, { signal });
  if (gate) options.diagnostics(gate.diagnostics);
  options.check();
  // Promise entry also captures synchronous adapter throws, so an approval that
  // started immediately before that throw still joins its checkpoint finally.
  const result = await Promise.resolve()
    .then(() => {
      if (gate?.allowed === false)
        return {
          content: gate.denialReason ?? "Tool denied by beforeTool hook.",
          isError: true,
        };
      if (options.native)
        return Promise.resolve()
          .then(options.native)
          .catch((error) =>
            error instanceof SyntaxError
              ? invalidToolInput(error)
              : {
                  content: JSON.stringify(toErrorInfo(error)),
                  isError: true,
                },
          );
      if (
        options.permission() === "readonly" &&
        !readonlyToolNames.has(call.function.name)
      )
        return {
          content:
            "Core readonly policy denies this tool; no approval can override plan mode.",
          isError: true,
        };
      return options.tools.execute(call, {
        sessionId: options.sessionId,
        toolCallId: call.id,
        workspace: options.workspace,
        get permission() {
          return options.permission();
        },
        signal,
        approve: approval,
        onEvent: (raw) => {
          if (!acceptingEvents || toolEvents >= 16) return;
          const parsed = agentEventSchema.safeParse(raw);
          if (
            !parsed.success ||
            parsed.data.type !== "approval_requested" ||
            parsed.data.sessionId !== options.sessionId ||
            parsed.data.request.sessionId !== options.sessionId ||
            parsed.data.request.toolCallId !== call.id ||
            toolEvents > 0
          )
            return;
          toolEvents++;
          // Only requestApproval emits when the root queue owns the display slot.
        },
      });
    })
    .then(toolResultSchema.parse)
    .catch(async (error) => {
      if (hooks?.configured) {
        const safe = toErrorInfo(error);
        options.diagnostics(
          await hooks.toolError(
            {
              ...hookInput,
              outcome: toToolHookOutcome({
                content: JSON.stringify(safe),
                isError: true,
              }),
              errorCode: safe.code,
            },
            { signal },
          ),
        );
      }
      throw error;
    })
    .finally(async () => {
      acceptingEvents = false;
      if (approvalWork) await approvalWork;
    });
  return {
    result,
    ...(hooks?.configured
      ? {
          afterCommit: async () => {
            const outcome = {
              ...hookInput,
              outcome: toToolHookOutcome(result),
            };
            options.diagnostics(
              await (result.isError
                ? hooks.toolError(outcome, { signal })
                : hooks.afterTool(outcome, { signal })),
            );
          },
        }
      : {}),
  };
}
