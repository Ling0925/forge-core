import {
  type AgentEvent,
  type EventSink,
  ForgeError,
  type SessionId,
  type ToolHookDiagnostic,
  toErrorInfo,
} from "../shared";

import type { RunState } from "./runtime-state";

export type EventBody = {
  [K in AgentEvent["type"]]: Omit<
    Extract<AgentEvent, { type: K }>,
    "sessionId" | "timestamp"
  >;
}[AgentEvent["type"]];

/**
 * Event emission for one run. `event` appends to the run's snapshot and
 * notifies; `ephemeral` only notifies (display state, never persisted).
 * Both stamp the current turn/step from the shared run state.
 */
export const createRunEvents = (
  run: RunState,
  sessionId: SessionId,
  onEvent: EventSink,
  now: () => string,
) => {
  const notify = (event: AgentEvent): void => {
    try {
      onEvent(event);
    } catch (error) {
      console.error("Event sink failed.", toErrorInfo(error));
    }
  };
  const event = (body: EventBody): void => {
    if (!run.snapshot)
      throw new ForgeError("internal", "Session has not loaded.");
    const event: AgentEvent = {
      ...(run.turn === undefined ? {} : { turn: run.turn }),
      ...(run.activeStep === undefined ? {} : { step: run.activeStep }),
      ...body,
      sessionId,
      timestamp: now(),
    };
    run.snapshot = {
      ...run.snapshot,
      events: [...run.snapshot.events, event],
    };
    notify(event);
  };
  const finishGeneration = (
    status: "completed" | "failed" | "cancelled" | "superseded",
  ): void => {
    if (!run.generation || run.generation.finished) return;
    run.generation.finished = true;
    event({
      type: "generation_finished",
      generationId: run.generation.id,
      ...(run.generation.step === undefined
        ? {}
        : { step: run.generation.step }),
      status,
    });
  };
  const closeStep = (status: "completed" | "cancelled" | "failed"): void => {
    if (!run.snapshot || run.turn === undefined || run.activeStep === undefined)
      return;
    event({
      type: "step_finished",
      turn: run.turn,
      step: run.activeStep,
      status,
      messageIndex: run.snapshot.messages.length,
    });
    run.steps += 1;
    run.activeStep = undefined;
  };
  const hookDiagnostics = (
    diagnostics: readonly ToolHookDiagnostic[],
    toolCallId?: string,
  ): void => {
    for (const diagnostic of diagnostics) {
      if (["failed", "timed_out", "cancelled"].includes(diagnostic.status))
        run.hookFailed = true;
      event({
        type: "tool_hook",
        diagnostic,
        ...(toolCallId ? { toolCallId } : {}),
      });
    }
  };
  // Display-only, never persisted: live reasoning preview is not transcript state.
  const ephemeral = (body: EventBody): void => {
    notify({
      ...(run.turn === undefined ? {} : { turn: run.turn }),
      ...(run.activeStep === undefined ? {} : { step: run.activeStep }),
      ...body,
      sessionId,
      timestamp: now(),
    });
  };
  return {
    notify,
    event,
    finishGeneration,
    closeStep,
    hookDiagnostics,
    ephemeral,
  };
};
