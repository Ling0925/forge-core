import type { AgentEvent, SessionId } from "../shared/schemas";

type ProgressBody = Omit<Extract<AgentEvent, { type: "agent_progress" }>, "sessionId" | "timestamp" | "turn" | "step">;
export const AGENT_PROGRESS_LIMIT = 65536;

/** Per-child, display-only accumulator. Cumulative updates can be replayed on
 * reconnect without duplicating chunks. No reasoning or tool payloads cross. */
export function createAgentProgress(childSessionId: SessionId, emit: (body: ProgressBody) => void) {
  let text = "";
  let truncated = false;
  let childTurn: number | undefined;
  let childStep: number | undefined;
  return (event: AgentEvent): void => {
    if (event.sessionId !== childSessionId) return;
    if (event.type !== "text_delta" && event.type !== "retry_reset" && event.type !== "step_started") return;
    childTurn = event.turn ?? childTurn;
    childStep = event.step ?? childStep;
    if (event.type === "text_delta") {
      if (!event.text || truncated) return;
      truncated = text.length + event.text.length > AGENT_PROGRESS_LIMIT;
      text += event.text.slice(0, AGENT_PROGRESS_LIMIT - text.length);
    } else {
      text = "";
      truncated = false;
    }
    emit({ type: "agent_progress", childSessionId, text, truncated,
      ...(childTurn === undefined ? {} : { childTurn }),
      ...(childStep === undefined ? {} : { childStep }),
    });
  };
}
