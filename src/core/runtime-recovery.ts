import { ForgeError, toErrorInfo } from "../shared/errors";
import { executionTurns } from "../shared/execution";
import { agentEventSchema } from "../shared/schemas";
import type { Message, SessionId } from "../shared/schemas";
import type { createRunEvents } from "./runtime-events";
import type { LoadedRunState } from "./runtime-state";

/**
 * Close every tool call that never received a result with an error result,
 * so a resumed or failed transcript never leaves a native call dangling.
 */
export const closeCalls = (
  messages: readonly Message[],
  content: string,
): readonly Message[] => {
  const result: Message[] = [];
  let unresolved: readonly string[] = [];
  const flush = (): void => {
    for (const id of unresolved)
      result.push({
        role: "tool",
        tool_call_id: id,
        content: JSON.stringify({ content, isError: true }),
      });
    unresolved = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flush();
    result.push(message);
    if (message.role === "assistant")
      unresolved = (message.tool_calls ?? []).map((call) => call.id);
    if (message.role === "tool")
      unresolved = unresolved.filter((id) => id !== message.tool_call_id);
  }
  flush();
  return result;
};

/**
 * Called when a session is still marked running/awaiting approval: its last
 * run was interrupted (for example by a crash). Record the interrupted
 * step/run once and persist the interrupted state before a new run starts.
 */
export const interruptStaleRun = async (
  run: LoadedRunState,
  event: ReturnType<typeof createRunEvents>["event"],
  save: () => Promise<void>,
): Promise<void> => {
  const previous = executionTurns(run.snapshot).at(-1);
  if (
    previous &&
    !previous.finish &&
    previous.events[0]?.type === "run_started" &&
    previous.events[0].turn !== undefined
  ) {
    if (previous.currentStep !== undefined)
      event({
        type: "step_finished",
        turn: previous.turn,
        step: previous.currentStep,
        messageIndex: run.snapshot.messages.length,
        status: "interrupted",
      });
    event({
      type: "run_finished",
      turn: previous.turn,
      status: "interrupted",
      turns: previous.currentStep ?? previous.steps ?? 0,
      steps:
        (previous.steps ?? 0) + (previous.currentStep === undefined ? 0 : 1),
      toolCalls: previous.toolCalls ?? 0,
      retries: previous.retries ?? 0,
      messageIndex: run.snapshot.messages.length,
      usageComplete: false,
    });
  }
  run.snapshot = { ...run.snapshot, status: "interrupted" };
  event({ type: "state_changed", status: "interrupted" });
  await save();
};

/**
 * Turn a run failure into its terminal record: finish the open generation,
 * keep any partial draft text, attribute non-Forge errors to the failing
 * phase, close dangling tool calls and emit the error event. Returns the
 * safe error that decides the terminal status.
 */
export const recordRunFailure = (
  run: LoadedRunState,
  error: unknown,
  {
    signal,
    sessionId,
    now,
    finishGeneration,
    event,
  }: {
    signal: AbortSignal;
    sessionId: SessionId;
    now: () => string;
    finishGeneration: ReturnType<typeof createRunEvents>["finishGeneration"];
    event: ReturnType<typeof createRunEvents>["event"];
  },
): ForgeError => {
  finishGeneration(signal.aborted ? "cancelled" : "failed");
  if (run.incompleteText)
    run.snapshot = {
      ...run.snapshot,
      events: [
        ...run.snapshot.events,
        agentEventSchema.parse({
          type: "text_delta",
          text: run.incompleteText,
          ...(run.generation ? { generationId: run.generation.id } : {}),
          ...(run.turn === undefined ? {} : { turn: run.turn }),
          ...(run.activeStep === undefined ? {} : { step: run.activeStep }),
          sessionId,
          timestamp: now(),
        }),
      ],
    };
  const safe = signal.aborted
    ? new ForgeError("cancelled", "Run cancelled.")
    : error instanceof ForgeError
      ? error
      : new ForgeError(
          run.phase,
          run.phase === "provider"
            ? "Model request failed."
            : run.phase === "tool"
              ? "Tool execution failed; inspect effects before retry."
              : "Session storage failed.",
          true,
        );
  run.stopReason = safe.code;
  run.snapshot = {
    ...run.snapshot,
    messages: closeCalls(
      run.snapshot.messages,
      safe.code === "cancelled"
        ? "execution cancelled; effects may be uncertain; inspect before retry"
        : "execution failed; effects may be uncertain; inspect before retry",
    ),
  };
  event({ type: "error", error: toErrorInfo(safe) });
  return safe;
};
