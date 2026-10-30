import { executionTurns } from "../shared/execution";
import type { Message } from "../shared/schemas";
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
