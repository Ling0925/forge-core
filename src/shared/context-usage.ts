import type { ContextUsage, Message, PublicSettings, ToolDefinition, Usage } from "./schemas";

// Exact IDs only. Never infer an unknown alias/version's window from a substring.
const knownWindows: Readonly<Record<string, number>> = {
  "gpt-4o": 128000, "gpt-4o-2024-08-06": 128000, "gpt-4o-mini": 128000,
  "gpt-4.1": 1047576, "gpt-4.1-mini": 1047576, "gpt-4.1-nano": 1047576,
  "o3": 200000, "o4-mini": 200000,
};
export function resolveContextWindow(model: string, settings: Pick<PublicSettings, "modelContextWindows">, reported?: number | null): number {
  const override = settings.modelContextWindows?.[model];
  return override ?? reported ?? (Object.hasOwn(knownWindows, model) ? knownWindows[model] : undefined) ?? 300000;
}

export type ContextBudget = Readonly<{ unit: "tokens" | "chars"; limit: number; target: number }>;

/** Leave 20% for output/estimation error; compact toward 60% to avoid churn.
 * Legacy character budgets are a fallback ONLY when the model window is unknown. */
export function resolveContextBudget(windowTokens: number | null, settings: Pick<PublicSettings, "contextBudgetChars" | "contextBudgetTokens">): ContextBudget {
  const cap = settings.contextBudgetTokens;
  const limit = windowTokens !== null
    ? Math.max(1, Math.min(Math.floor(windowTokens * 0.8), cap ?? Infinity))
    : cap;
  return limit != null
    ? { unit: "tokens", limit, target: Math.max(1, Math.floor(limit * 0.75)) }
    : { unit: "chars", limit: settings.contextBudgetChars, target: Math.floor(settings.contextBudgetChars * 0.75) };
}

export function budgetUsage(budget: ContextBudget): { budgetTokens?: number; budgetChars?: number } {
  return budget.unit === "tokens" ? { budgetTokens: budget.limit } : { budgetChars: budget.limit };
}

/** Offline heuristic, NOT a model tokenizer. ASCII ~4 chars/token; non-ASCII
 * UTF-8 bytes/3 captures CJK better. Provider usage calibrates request totals. */
export function estimateTokens(text: string): number {
  let weight = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    weight += code < 128 ? 0.25 : (code < 2048 ? 2 : code < 65536 ? 3 : 4) / 3;
  }
  return Math.ceil(weight);
}

export function measureContext(messages: readonly Message[], windowTokens: number | null, tools: readonly ToolDefinition[] = []): ContextUsage {
  const parts = { instructions: 0, memory: 0, conversation: 0, tools: 0 };
  for (const message of messages) {
    const memory = message.role === "assistant" && /^(Context memory \(|Earlier actions \()/.test(message.content ?? "");
    const category = message.role === "system" ? "instructions" : memory ? "memory" : message.role === "tool" ? "tools" : "conversation";
    parts[category] += 4 + estimateTokens(message.content ?? "");
    // Vision costs vary by model and resolution; never tokenize base64 as text.
    if (message.role === "user") parts[category] += (message.images?.length ?? 0) * 2048;
    if (message.role === "assistant") {
      if (message.tool_calls?.length) parts.tools += estimateTokens(JSON.stringify(message.tool_calls));
      // Responses replays opaque reasoning items too. Count the opaque state only
      // as an estimate; do not serialize local origin/model/baseURL metadata.
      if (message.providerState) parts.tools += estimateTokens(JSON.stringify(message.providerState.output));
    }
  }
  if (tools.length) parts.tools += estimateTokens(JSON.stringify(tools));
  if (messages.length) parts.instructions += 3;
  const usedTokens = Object.values(parts).reduce((a, b) => a + b, 0);
  return { windowTokens, usedTokens, parts, estimated: true, basis: "projected" };
}

/** Provider reports total input, not category counts. Scale category estimates
 * to that total (including cache hits), then add this response's output. */
export function reportedContext(estimated: ContextUsage, usage: Usage, output: Message): ContextUsage {
  const parts = { ...estimated.parts };
  const keys = Object.keys(parts) as (keyof typeof parts)[];
  let remaining = usage.promptTokens;
  for (const key of keys.slice(0, -1)) {
    parts[key] = estimated.usedTokens ? Math.floor(estimated.parts[key] / estimated.usedTokens * usage.promptTokens) : 0;
    remaining -= parts[key];
  }
  parts.tools = remaining;
  parts[output.role === "assistant" && output.tool_calls?.length ? "tools" : "conversation"] += usage.completionTokens;
  const { cachedPromptTokens: _previousCache, ...projection } = estimated;
  return { ...projection, parts, usedTokens: usage.promptTokens + usage.completionTokens,
    promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
    ...(usage.cachedPromptTokens !== undefined ? { cachedPromptTokens: usage.cachedPromptTokens } : {}),
    estimated: true, basis: "request-with-output" };
}
