import type { AgentEvent, SessionSnapshot } from "./schemas";

export interface ExecutionTurn {
  readonly turn: number;
  readonly messageStart: number;
  readonly messageEnd: number;
  readonly events: readonly AgentEvent[];
  readonly finish: Extract<AgentEvent, { type: "run_finished" }> | undefined;
  readonly steps: number | undefined;
  readonly currentStep: number | undefined;
  readonly toolCalls: number | undefined;
  readonly retries: number | undefined;
}

const cache = new WeakMap<SessionSnapshot, readonly ExecutionTurn[]>();

export function executionTurns(snapshot: SessionSnapshot): readonly ExecutionTurn[] {
  const cached = cache.get(snapshot);
  if (cached) return cached;
  const starts = snapshot.events.flatMap((event, index) =>
    event.type === "run_started" ? [{ event, index }] : []).map((start, ordinal) => ({ ...start, ordinal }));
  const firstAnchor = starts.find(({ event }) => event.messageIndex !== undefined)?.event.messageIndex
    ?? snapshot.messages.length;
  const users = snapshot.messages.flatMap((message, index) =>
    message.role === "user" && !message.origin && index < firstAnchor ? [index] : []);
  const legacyStarts = starts.filter(({ event }) => event.messageIndex === undefined);
  const aligned = users.length === legacyStarts.length;
  const boundaries = [
    ...users.map((messageStart, index) => ({
      turn: index + 1, messageStart, start: aligned ? legacyStarts[index] : undefined,
    })),
    ...starts.flatMap(start => start.event.messageIndex === undefined ? [] : [{
      turn: start.event.turn ?? start.ordinal + 1,
      messageStart: start.event.messageIndex, start,
    }]),
  ];
  const result = boundaries.map((boundary, index): ExecutionTurn => {
    const next = boundaries[index + 1];
    const start = boundary.start;
    const events = start === undefined ? [] : snapshot.events.slice(start.index, starts[start.ordinal + 1]?.index);
    const finish = events.find((event): event is Extract<AgentEvent, { type: "run_finished" }> => event.type === "run_finished");
    const explicit = start?.event.messageIndex !== undefined;
    const lastBoundary = events.findLast(event => event.type === "step_started" || event.type === "step_finished");
    return {
      turn: boundary.turn,
      messageStart: boundary.messageStart,
      messageEnd: next?.messageStart ?? snapshot.messages.length,
      events,
      finish,
      steps: explicit ? events.filter(event => event.type === "step_finished").length : finish?.steps ?? finish?.turns,
      currentStep: lastBoundary?.type === "step_started" && !finish ? lastBoundary.step : undefined,
      toolCalls: finish?.toolCalls ?? (explicit ? events.filter(event => event.type === "tool_started").length : undefined),
      retries: finish?.retries ?? (explicit ? events.filter(event => event.type === "provider_retry").length : undefined),
    };
  });
  cache.set(snapshot, result);
  return result;
}

export function executionLabel(turn: ExecutionTurn): string {
  const parts: string[] = [];
  if (turn.currentStep !== undefined) parts.push(`进行到第 ${turn.currentStep} 步`);
  else if (turn.steps !== undefined) parts.push(`${turn.steps} 步`);
  if (turn.toolCalls !== undefined) parts.push(`${turn.toolCalls} 次工具调用`);
  if (turn.retries) parts.push(`${turn.retries} 次请求重试`);
  return parts.join(" · ");
}
