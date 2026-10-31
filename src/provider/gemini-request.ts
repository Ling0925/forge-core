import type { Message, ToolCall } from "../shared/schemas";
import { parseProviderJson } from "./bounded-json";
import { protocol } from "./errors";
import { MAX_TEXT, type Part, statePartsWire } from "./gemini-wire";

// Google documents this value for function-call history a client cannot sign
// (a call made by another model/protocol). Gemini 3 rejects a functionCall
// without any thoughtSignature, so unsigned replay carries the sentinel but
// never another identity's signature. See gemini_signature.go.
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const argumentsObject = (value: unknown): Readonly<Record<string, unknown>> => {
  let parsed = value;
  if (typeof parsed === "string") {
    // Some relays forward functionCall.args as JSON text instead of a Struct.
    // A string that is not a complete JSON object is never executed.
    if (parsed.length > MAX_TEXT)
      throw protocol("output_limit", {
        stage: "tool_arguments",
        observed: parsed.length,
        limit: MAX_TEXT,
        unit: "utf16_code_units",
      });
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw protocol("invalid_tool_call", { stage: "tool_arguments" });
    }
  }
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed))
    throw protocol("invalid_tool_call");
  return parsed as Readonly<Record<string, unknown>>;
};

const imagePart = (dataUrl: string): Readonly<Record<string, unknown>> => {
  const match =
    /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl,
    );
  if (!match?.[1] || !match[2]) throw protocol();
  return { inlineData: { mimeType: match[1], data: match[2] } };
};

const toolResultPayload = (
  content: string,
): Readonly<Record<string, unknown>> => {
  try {
    const value: unknown = JSON.parse(content);
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).isError === true
    )
      return { error: content };
  } catch {
    /* A plain-text result is still an output. */
  }
  return { output: content };
};

type WireContent = { role: "user" | "model"; parts: Record<string, unknown>[] };

// Forge history -> Gemini contents. Roles alternate by merging neighbours,
// tool results answer their calls by id, and an assistant turn's signed parts
// are replayed only for the same endpoint, model and credential identity.
// Anything else is rebuilt from Forge's portable content/tool_calls.
export const wireContents = (
  messages: readonly Message[],
  baseUrl: string,
  model: string,
  credentialId: string | undefined,
): { readonly system: string; readonly contents: WireContent[] } => {
  const system: string[] = [];
  const contents: WireContent[] = [];
  const pending = new Map<string, string>();
  const used = new Set<string>();
  let toolTurn = false;
  const push = (
    role: "user" | "model",
    parts: Record<string, unknown>[],
    separate = false,
  ) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (!separate && last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const replay = (stored: Part[]): Record<string, unknown>[] =>
    stored.map((part) => {
      if (!part.functionCall) return { ...part };
      const args =
        part.functionCall.args === undefined
          ? {}
          : argumentsObject(part.functionCall.args);
      return {
        ...part,
        functionCall: {
          ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
          name: part.functionCall.name,
          args,
        },
        // A stored call keeps its own signature; one signed by another step or
        // identity gets the documented no-signature sentinel.
        thoughtSignature: part.thoughtSignature || SKIP_THOUGHT_SIGNATURE,
      };
    });
  const summarize = (parts: Part[]) => {
    let text = "";
    const calls: ToolCall[] = [];
    for (const part of parts) {
      if (part.functionCall) {
        const id = part.functionCall.id;
        if (!id) throw protocol("invalid_tool_call");
        calls.push({
          id,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(argumentsObject(part.functionCall.args)),
          },
        });
      } else if (part.text && !part.thought) text += part.text;
    }
    return { text, calls };
  };
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      const name = pending.get(message.tool_call_id);
      if (!name) throw protocol("invalid_tool_call");
      pending.delete(message.tool_call_id);
      push("user", [
        {
          functionResponse: {
            id: message.tool_call_id,
            name,
            response: toolResultPayload(message.content),
          },
        },
      ]);
      toolTurn = true;
      continue;
    }
    if (pending.size) throw protocol("invalid_tool_call");
    if (message.role === "user") {
      const parts: Record<string, unknown>[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const image of message.images ?? [])
        parts.push(imagePart(image.dataUrl));
      // Gemini turns away a turn that mixes a functionResponse with what the
      // user said ("Requests ending with a model turn are not supported"), so
      // text that follows tool results opens a turn of its own.
      push("user", parts, toolTurn);
      toolTurn = false;
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      if (used.has(call.id)) throw protocol("invalid_tool_call");
      used.add(call.id);
      pending.set(call.id, call.function.name);
    }
    const state = message.providerState;
    const sameOrigin =
      state?.apiMode === "gemini" &&
      state.baseUrl === baseUrl &&
      state.model === model &&
      state.credentialId === credentialId;
    if (sameOrigin && state) {
      const stored = statePartsWire.parse(state.output);
      const normalized = summarize(stored);
      if (
        normalized.text !== (message.content ?? "") ||
        JSON.stringify(normalized.calls) !==
          JSON.stringify(message.tool_calls ?? [])
      )
        throw protocol("invalid_tool_call");
      push("model", replay(stored));
      toolTurn = false;
      continue;
    }
    const parts: Record<string, unknown>[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.tool_calls ?? []) {
      const args = argumentsObject(
        parseProviderJson(call.function.arguments, "tool_arguments"),
      );
      // The functionResponse below names this call by id, so a rebuilt call
      // must carry the same id (Gemini matches responses to calls by id).
      parts.push({
        functionCall: { id: call.id, name: call.function.name, args },
        thoughtSignature: SKIP_THOUGHT_SIGNATURE,
      });
    }
    push("model", parts);
    toolTurn = false;
  }
  if (pending.size) throw protocol("invalid_tool_call");
  return { system: system.join("\n\n"), contents };
};

const modelGeneration = (model: string): number => {
  const found = /(?:^|\/)gemini-(\d+(?:\.\d+)?)/i.exec(model);
  return found?.[1] ? Number.parseInt(found[1], 10) : 0;
};

// The reference fits a requested effort to the model's own reasoning controls
// (vertexThinking/codeassist thinkingConfig): Gemini 3+ takes a level, earlier
// models take a budget. An unknown/legacy id follows the budget path, as the
// reference does. No requested level is ever lowered below the model's ability
// to express it, and `default` sends no thinkingConfig at all.
const EFFORT_BUDGET: Readonly<Record<string, number>> = {
  minimal: 4096,
  low: 4096,
  medium: 10000,
  high: 24000,
  xhigh: 32000,
  max: 32000,
};
export const thinkingConfig = (
  model: string,
  effort: string | undefined,
): Readonly<Record<string, unknown>> | undefined => {
  if (!effort || effort === "default") return undefined;
  const lower = model.toLowerCase();
  if (modelGeneration(model) >= 3) {
    const level =
      effort === "none" || effort === "minimal" || effort === "low"
        ? "low"
        : effort === "medium" &&
            (lower.includes("flash") || modelGeneration(model) > 3)
          ? "medium"
          : "high";
    return {
      thinkingLevel: level,
      includeThoughts: effort !== "none",
    };
  }
  const range = lower.includes("gemini-2.5-pro")
    ? { off: 128, least: 128, most: 32768 }
    : lower.includes("gemini-2.5-flash-lite")
      ? { off: 0, least: 512, most: 24576 }
      : lower.includes("gemini-2.5-flash")
        ? { off: 0, least: 1, most: 24576 }
        : undefined;
  if (effort === "none") return { thinkingBudget: range?.off ?? 0 };
  const budget = Math.min(
    Math.max(
      EFFORT_BUDGET[effort] ?? EFFORT_BUDGET.medium ?? 10000,
      range?.least ?? 0,
    ),
    range?.most ?? Number.MAX_SAFE_INTEGER,
  );
  return { thinkingBudget: budget, includeThoughts: true };
};

export { argumentsObject };
