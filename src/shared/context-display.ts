import type { AgentEvent, ContextUsage } from "./schemas";

/** Presentation only. Never rewrite raw usage events or accumulated billing totals. */
export type ContextDisplay = Readonly<{
  context?: ContextUsage | undefined;
  projected?: ContextUsage | undefined;
  model?: string | undefined;
  compacted: boolean;
}>;
export const emptyContextDisplay = (): ContextDisplay => ({ compacted: false });

/** Old events include generated/reasoning output in usedTokens. Only the input
 * count is provider-confirmed context. Category counts remain estimates. */
export function requestInputContext(usage: ContextUsage, projection?: ContextUsage): ContextUsage {
  if (usage.basis === "projected" || usage.promptTokens === undefined) return usage;
  if (usage.basis === "request" && !usage.estimated && usage.usedTokens === usage.promptTokens) return usage;
  const source = projection?.parts ?? usage.parts;
  const total = Object.values(source).reduce((sum, value) => sum + value, 0);
  const parts = { instructions: 0, memory: 0, conversation: 0, tools: 0 };
  let remaining = usage.promptTokens;
  for (const key of ["instructions", "memory", "conversation"] as const) {
    parts[key] = total ? Math.floor(source[key] / total * usage.promptTokens) : 0;
    remaining -= parts[key];
  }
  parts.tools = remaining;
  return { ...usage, usedTokens: usage.promptTokens, parts, estimated: false, basis: "request" };
}

export function advanceContextDisplay(state: ContextDisplay, event: AgentEvent): ContextDisplay {
  if (event.type === "run_started") {
    return state.model !== undefined && state.model !== event.model
      ? { model: event.model, compacted: false }
      : { ...state, model: event.model };
  }
  if (event.type === "context_compacted") {
    // A pre-compaction report is no longer representative. Wait for the new
    // projection; never pretend the prior input is the post-compaction input.
    return { model: state.model, compacted: true };
  }
  if (event.type !== "context_usage") return state;
  const usage = event.usage;
  if (usage.basis !== "projected" && usage.promptTokens !== undefined) {
    return { ...state, context: requestInputContext(usage, state.projected), compacted: false };
  }
  const reported = state.context?.basis === "request" && state.context.windowTokens === usage.windowTokens;
  return { ...state, projected: usage, context: reported ? state.context : usage };
}

export function replayContextDisplay(events: readonly AgentEvent[]): ContextDisplay {
  return events.reduce(advanceContextDisplay, emptyContextDisplay());
}

export function contextDisplayLabel(context: ContextUsage | undefined, compacted = false): string {
  if (compacted) return "压缩后预估（待实报）";
  return context?.basis === "request" ? "最近请求输入（实报）" : "本地上下文预估";
}
