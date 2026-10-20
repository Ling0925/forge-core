import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelProvider } from "../shared/contracts";
import { scopeProviderState } from "./state-scope";
import { ForgeError } from "../shared/errors";
import type { ModelCatalog, ModelCatalogEntry } from "../shared/model-catalog";
import {
  messageSchema,
  providerConfigSchema,
  providerResponseSchema,
  settingsFields,
  toolCallSchema,
  toolDefinitionSchema,
} from "../shared/schemas";
import type {
  Message,
  ProviderConfig,
  ProviderResponse,
  ToolCall,
  ToolCallPreview,
  Usage,
} from "../shared/schemas";
import { estimateToolCallLines } from "../shared/tool-preview-lines";
import { ProviderError, httpError, protocol } from "./errors";
import { createRequestOptions } from "./request-options";
import { sdkEvents, withSdkRequest } from "./sdk-transport";

// Native Google Gemini API adapter (generativelanguage.googleapis.com and
// relays that answer as it does). Protocol reference:
// references/magpie/internal/gateway/gemini.go, gemini_signature.go,
// internal/provider/gemini_api.go at the pinned commit. Forge's streaming,
// tool, cancellation and provider-state semantics are kept, not Magpie's
// gateway/IR layer.
const MAX_TEXT = 2_000_000;
const MAX_REASONING = 131_072;
const MAX_BODY = 8_000_000;
const MAX_SIGNATURE = 1_000_000;
const MAX_MODELS = 10_000;
const MAX_PAGES = 100;
const MAX_IMAGE_WIRE = 16_000_000;
// Google documents this value for function-call history a client cannot sign
// (a call made by another model/protocol). Gemini 3 rejects a functionCall
// without any thoughtSignature, so unsigned replay carries the sentinel but
// never another identity's signature. See gemini_signature.go.
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// Bounded JSON parse: reject oversized bodies and absurd nesting before
// JSON.parse, matching the other native adapters.
const parseJson = (text: string): unknown => {
  if (text.length > MAX_BODY) throw protocol("output_limit");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > 64) throw protocol("invalid_json");
    } else if (char === "}" || char === "]") depth -= 1;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw protocol("invalid_json");
  }
};

const functionCallWire = z
  .object({
    id: z.string().max(256).optional(),
    name: toolCallSchema.unwrap().shape.function.unwrap().shape.name,
    args: z.unknown().optional(),
  })
  .strict();
// A content part. Unknown additive fields are tolerated (Gemini adds
// metadata over time) but every part that could carry output is read here;
// unrepresentable kinds are rejected rather than silently dropped.
const partWire = z
  .object({
    text: z.string().max(MAX_TEXT).optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().max(MAX_SIGNATURE).optional(),
    functionCall: functionCallWire.optional(),
    inlineData: z
      .object({
        mimeType: z.string().min(1).max(255),
        data: z.string().max(MAX_IMAGE_WIRE),
      })
      .strict()
      .optional(),
    fileData: z
      .object({
        mimeType: z.string().min(1).max(255),
        fileUri: z.string().min(1).max(4096),
      })
      .strict()
      .optional(),
    executableCode: z.unknown().optional(),
    codeExecutionResult: z.unknown().optional(),
  })
  .passthrough();
type Part = z.infer<typeof partWire>;

const usageWire = z
  .object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional(),
    cachedContentTokenCount: z.number().int().nonnegative().optional(),
    thoughtsTokenCount: z.number().int().nonnegative().optional(),
    toolUsePromptTokenCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();
type UsageWire = z.infer<typeof usageWire>;

const candidateWire = z
  .object({
    content: z
      .object({
        role: z.string().max(32).optional(),
        parts: z.array(partWire).max(256),
      })
      .passthrough()
      .optional(),
    finishReason: z.string().max(64).optional(),
    finishMessage: z.string().max(8192).optional(),
    index: z.number().int().min(0).max(7).optional(),
    safetyRatings: z.array(z.unknown()).max(64).optional(),
    citationMetadata: z.unknown().optional(),
    groundingMetadata: z.unknown().optional(),
    avgLogprobs: z.number().optional(),
    logprobsResult: z.unknown().optional(),
  })
  .passthrough();
const chunkWire = z
  .object({
    candidates: z.array(candidateWire).max(8).optional(),
    usageMetadata: usageWire.optional(),
    promptFeedback: z
      .object({
        blockReason: z.string().max(64).optional(),
        blockReasonMessage: z.string().max(8192).optional(),
      })
      .passthrough()
      .optional(),
    modelVersion: z.string().max(256).optional(),
    responseId: z.string().max(256).optional(),
  })
  .passthrough();
const failureWire = z
  .object({
    error: z
      .object({
        code: z.unknown().optional(),
        status: z.unknown().optional(),
        message: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const modelsPageWire = z
  .object({
    models: z
      .array(z.object({ name: z.string().min(1).max(512) }).passthrough())
      .max(1000)
      .optional(),
    nextPageToken: z.string().min(1).max(4096).optional(),
  })
  .passthrough();
const statePartsWire = z.array(partWire).max(256);

// Upstream gRPC status names seen in error frames, mapped to HTTP-class
// failures so Forge's existing retry budget applies.
const STATUS_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

const failureOf = (error: {
  code?: unknown;
  status?: unknown;
}): ProviderError => {
  const code =
    typeof error.code === "number"
      ? error.code
      : typeof error.status === "string"
        ? STATUS_CODE[error.status]
        : undefined;
  if (code !== undefined && code >= 400 && code <= 599) return httpError(code);
  return new ProviderError(
    "upstream",
    "The provider reported a generation failure.",
    false,
    undefined,
    "provider_error_event",
  );
};

const normalizeUsage = (raw: UsageWire | undefined): Usage | undefined => {
  if (
    !raw ||
    raw.promptTokenCount === undefined ||
    raw.candidatesTokenCount === undefined
  )
    return undefined;
  // Gemini counts thoughts apart from the answer; Forge's completionTokens is
  // all generated tokens, so both are included (Usage.gemini in the reference
  // does the reverse split). totalTokenCount is used when the provider sent it.
  const completion = raw.candidatesTokenCount + (raw.thoughtsTokenCount ?? 0);
  return {
    promptTokens: raw.promptTokenCount,
    completionTokens: completion,
    totalTokens: raw.totalTokenCount ?? raw.promptTokenCount + completion,
    ...(raw.cachedContentTokenCount === undefined
      ? {}
      : { cachedPromptTokens: raw.cachedContentTokenCount }),
  };
};

const argumentsObject = (value: unknown): Readonly<Record<string, unknown>> => {
  let parsed = value;
  if (typeof parsed === "string") {
    // Some relays forward functionCall.args as JSON text instead of a Struct.
    // A string that is not a complete JSON object is never executed.
    if (parsed.length > MAX_TEXT) throw protocol("output_limit");
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw protocol("invalid_tool_call");
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
const wireContents = (
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
        parseJson(call.function.arguments) as unknown,
      );
      parts.push({
        functionCall: { name: call.function.name, args },
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
const thinkingConfig = (
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

const finishOf = (reason: string | undefined): void => {
  if (!reason) throw protocol("missing_finish");
  switch (reason) {
    case "STOP":
      return;
    case "MAX_TOKENS":
      throw protocol("output_truncated");
    case "SAFETY":
    case "RECITATION":
    case "LANGUAGE":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      throw new ProviderError(
        "upstream",
        "The provider stopped the response because of content filtering.",
        false,
        undefined,
        "content_filter",
      );
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
    case "TOO_MANY_TOOL_CALLS":
    case "MISSING_THOUGHT_SIGNATURE":
    case "MALFORMED_RESPONSE":
      throw protocol("invalid_tool_call");
    case "OTHER":
      throw new ProviderError(
        "upstream",
        "The provider stopped the response before completing it.",
        false,
        undefined,
        "response_incomplete",
      );
    default:
      throw protocol("invalid_finish");
  }
};

type CompleteOptions = Parameters<ModelProvider["complete"]>[2];

// State machine for one streamGenerateContent reply (SSE frames or one JSON
// body). Only a complete, validated result is returned; previews carry
// counters, never partial arguments.
const responseReader = (
  options: CompleteOptions,
  model: string,
  baseUrl: string,
  credentialId: string | undefined,
) => {
  let text = "";
  let reasoning = "";
  let finish: string | undefined;
  let usage: UsageWire | undefined;
  let done = false;
  const parts: Part[] = [];
  const notify = (callback: () => void) => {
    try {
      callback();
    } catch {
      throw new ProviderError("observer", "A provider observer failed.");
    }
  };
  const emit = (
    callback: ((value: string) => void) | undefined,
    value: string,
  ) => {
    if (!callback || !value) return;
    for (let start = 0; start < value.length; start += 65536)
      notify(() => callback(value.slice(start, start + 65536)));
  };
  const preview = (index: number, name: string, argumentsText: string) => {
    if (!options.onToolCall) return;
    const lines = estimateToolCallLines(name, argumentsText);
    const value: ToolCallPreview = {
      index,
      name,
      argumentsChars: argumentsText.length,
      ...lines,
    };
    notify(() => options.onToolCall?.(value));
  };
  const addPart = (part: Part) => {
    if (
      part.executableCode !== undefined ||
      part.codeExecutionResult !== undefined
    )
      throw protocol();
    if (part.inlineData !== undefined || part.fileData !== undefined)
      throw protocol();
    if (part.functionCall) {
      // A functionCall carries its arguments whole; text in the same part
      // cannot be placed on the wire without guessing which one wins.
      if (part.text || part.thought) throw protocol("invalid_chunk");
      const args = argumentsObject(part.functionCall.args);
      const functionCall = {
        id: part.functionCall.id ?? `call_${randomUUID()}`,
        name: part.functionCall.name,
        args,
      };
      parts.push({ ...part, functionCall });
      preview(
        parts.filter((value) => value.functionCall).length - 1,
        functionCall.name,
        JSON.stringify(args),
      );
      return;
    }
    const value = part.text ?? "";
    if (part.thought === true) {
      if (reasoning.length < MAX_REASONING)
        reasoning += value.slice(0, MAX_REASONING - reasoning.length);
      emit(options.onReasoning, value);
    } else if (value) {
      text += value;
      if (text.length > MAX_TEXT) throw protocol("output_limit");
      emit(options.onText, value);
    }
    if (value || part.thoughtSignature)
      parts.push({ ...part, ...(value ? { text: value } : {}) });
  };
  const accept = (value: unknown) => {
    if (done) throw protocol("unexpected_frame");
    const failure = failureWire.safeParse(value);
    if (failure.success) throw failureOf(failure.data.error);
    const parsed = chunkWire.safeParse(value);
    if (!parsed.success) throw protocol("invalid_chunk");
    const chunk = parsed.data;
    if (chunk.promptFeedback?.blockReason)
      throw new ProviderError(
        "upstream",
        "The provider stopped the response because of content filtering.",
        false,
        undefined,
        "content_filter",
      );
    if (chunk.usageMetadata) usage = { ...usage, ...chunk.usageMetadata };
    if (!chunk.candidates) return;
    // This adapter never asks for candidateCount > 1; a second candidate
    // cannot be represented without guessing, so it is a protocol failure.
    if (chunk.candidates.length > 1) throw protocol("invalid_chunk");
    const candidate = chunk.candidates[0];
    if (!candidate) return;
    if (finish !== undefined && candidate.content?.parts.length)
      throw protocol("unexpected_frame");
    if (candidate.finishReason !== undefined) {
      if (finish !== undefined && finish !== candidate.finishReason)
        throw protocol("unexpected_frame");
      finish = candidate.finishReason;
    }
    const content = candidate.content;
    if (!content) return;
    if (
      content.role !== undefined &&
      content.role !== "model" &&
      content.role !== "assistant"
    )
      throw protocol("invalid_chunk");
    for (const part of content.parts) addPart(part);
  };
  const dispatch = (payload: string) => {
    if (payload === "[DONE]") {
      if (!finish || done) throw protocol("missing_finish");
      done = true;
      return;
    }
    accept(parseJson(payload));
  };
  const response = (): ProviderResponse => {
    finishOf(finish);
    const calls: ToolCall[] = [];
    const ids = new Set<string>();
    for (const part of parts) {
      if (!part.functionCall) continue;
      const id = part.functionCall.id;
      if (!id || ids.has(id)) throw protocol("invalid_tool_call");
      ids.add(id);
      calls.push({
        id,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(argumentsObject(part.functionCall.args)),
        },
      });
    }
    // A STOP with nothing said is an error in the reference (empty reply),
    // retried by the runtime rather than ending the run as a successful turn.
    if (!text && !calls.length) throw protocol("missing_completion");
    const signed = parts.some(
      (part) => part.thought === true || Boolean(part.thoughtSignature),
    );
    const normalizedUsage = normalizeUsage(usage);
    return providerResponseSchema.parse({
      message: {
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(signed
          ? {
              providerState: {
                version: 1,
                apiMode: "gemini",
                ...(credentialId ? { credentialId } : {}),
                baseUrl,
                model,
                output: parts,
              },
            }
          : {}),
      },
      ...(normalizedUsage ? { usage: normalizedUsage } : {}),
    });
  };
  return { accept, dispatch, response };
};

// Shared request options resolve auth, custom headers and extraBody, and carry
// a proxy-aware transport when the source has one. Their headers may hold null
// to mean "remove the SDK default credential header"; raw fetch omits those.
// The native content type is the adapter's own and is never user-overridable.
const wireHeaders = (
  headers: Readonly<Record<string, string | null>>,
  contentType?: string,
): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== null) values[name] = value;
  if (contentType) values["content-type"] = contentType;
  return values;
};

const send = async (
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (error instanceof TypeError)
      throw new ProviderError(
        "network",
        "The provider connection failed.",
        true,
      );
    throw error;
  }
};

const readBody = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (text.length > MAX_BODY) throw protocol("output_limit");
  return text;
};

const baseOf = (baseUrl: string): string => {
  // A pasted endpoint (…/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse)
  // or a model list URL is cut back to the base it sits under, as the reference
  // does; any other prefix (a relay's /proxy/v1beta) stays as configured.
  return baseUrl
    .trim()
    .replace(/\/models(?:\/[^/?#]*)?(?:[?#].*)?$/i, "")
    .replace(/\/+$/, "");
};
const pathOf = (model: string): string =>
  encodeURIComponent(model.replace(/^models\//, ""));

type CatalogModel = {
  readonly contextWindowTokens: number | null;
  readonly displayName: string | undefined;
  readonly maxOutputTokens: number | null;
};

const positiveTokens = (value: unknown): number | null => {
  const number =
    typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
  return typeof number === "number" &&
    Number.isInteger(number) &&
    number > 0 &&
    number <= 10_000_000
    ? number
    : null;
};

export function createGeminiProvider(config: ProviderConfig): ModelProvider {
  const parsedConfig = providerConfigSchema.safeParse(config);
  if (!parsedConfig.success)
    throw new ForgeError(
      "invalid_input",
      "Configure a valid provider endpoint and timeout.",
      false,
    );
  const settings = parsedConfig.data;
  const baseUrl = baseOf(settings.baseUrl);
  // Shared request options own auth (a provider with neither a key nor an auth
  // mode is a keyless relay that sends no credential), custom headers,
  // extraBody and a proxy-aware transport. Their headers may hold null to mean
  // "remove a credential header an SDK would add"; this adapter's own fetch
  // drops those instead of sending "null".
  const transport = createRequestOptions(settings);
  let catalog = new Map<string, CatalogModel>();
  let catalogLoaded = false;
  // Always ask upstream: the host's catalog cache owns refresh decisions, and
  // this is the call it makes when the user asks for fresh metadata.
  const listModels = (signal?: AbortSignal) =>
    withSdkRequest(
      settings,
      { signal, idle: false, fetch: transport.fetch },
      async ({ signal: combined, fetch }) => {
        const next = new Map<string, CatalogModel>();
        const seen = new Set<string>();
        let pageToken: string | undefined;
        for (let page = 0; ; page += 1) {
          if (page >= MAX_PAGES) throw protocol("output_limit");
          const url = new URL(`${baseUrl}/models`);
          url.searchParams.set("pageSize", "1000");
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          const response = await send(
            fetch,
            url.toString(),
            { method: "GET", headers: wireHeaders(transport.headers) },
            combined,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status);
          }
          const body = modelsPageWire.safeParse(
            parseJson(await readBody(response)),
          );
          if (!body.success) throw protocol();
          for (const model of body.data.models ?? []) {
            // The list also carries models no agent can ask for a reply
            // (embeddings, Imagen, Veo). A method list the upstream sent
            // decides that; a model that omits it is kept (the reference
            // keeps anything it cannot classify).
            const methods = model.supportedGenerationMethods;
            if (
              Array.isArray(methods) &&
              methods.length > 0 &&
              !methods.includes("generateContent") &&
              !methods.includes("streamGenerateContent")
            )
              continue;
            const id = settingsFields.model.parse(
              model.name.startsWith("models/")
                ? model.name.slice("models/".length)
                : model.name,
            );
            const displayName =
              typeof model.displayName === "string"
                ? model.displayName
                : undefined;
            next.set(id, {
              contextWindowTokens: positiveTokens(model.inputTokenLimit),
              displayName,
              maxOutputTokens: positiveTokens(model.outputTokenLimit),
            });
            if (next.size > MAX_MODELS) throw protocol("output_limit");
          }
          const token = body.data.nextPageToken;
          if (!token) break;
          if (seen.has(token)) throw protocol("invalid_response");
          seen.add(token);
          pageToken = token;
        }
        // Publish only after every page succeeded; a failed refresh keeps the
        // previous catalog instead of replacing it with a partial one.
        catalog = next;
        catalogLoaded = true;
        return [...next.keys()].sort();
      },
    );
  const listModelCatalog = async (
    signal?: AbortSignal,
  ): Promise<ModelCatalog> => {
    const ids = await listModels(signal);
    return ids.map((id): ModelCatalogEntry => {
      const model = catalog.get(id);
      const provenance: Record<string, "upstream"> = {};
      const entry: ModelCatalogEntry = {
        id,
        contextWindowTokens: model?.contextWindowTokens ?? null,
        ...(model?.displayName ? { displayName: model.displayName } : {}),
        ...(model?.maxOutputTokens != null
          ? { maxOutputTokens: model.maxOutputTokens }
          : {}),
      };
      if (entry.contextWindowTokens !== null)
        provenance.contextWindowTokens = "upstream";
      if (entry.displayName !== undefined) provenance.displayName = "upstream";
      if (entry.maxOutputTokens != null)
        provenance.maxOutputTokens = "upstream";
      return {
        ...entry,
        ...(Object.keys(provenance).length ? { provenance } : {}),
      };
    });
  };
  return scopeProviderState({
    apiMode: "gemini",
    listModels,
    listModelCatalog,
    async getModelContextWindow(model, signal) {
      if (!catalogLoaded) await listModels(signal);
      return catalog.get(model)?.contextWindowTokens ?? null;
    },
    async complete(messages, tools, options) {
      if (options.webSearch !== undefined && options.webSearch !== "disabled")
        throw new ForgeError(
          "invalid_input",
          "Native web search requires a Responses endpoint and a model supporting web_search; no local-search fallback is used.",
        );
      const model = settingsFields.model.safeParse(options.model);
      const history = z.array(messageSchema).max(100000).safeParse(messages);
      const definitions = z
        .array(toolDefinitionSchema)
        .max(256)
        .safeParse(tools);
      if (!model.success || !history.success || !definitions.success)
        throw new ForgeError(
          "invalid_input",
          "Provide a valid model, message history and tool definitions.",
          false,
        );
      return withSdkRequest(
        settings,
        { signal: options.signal, idle: true, fetch: transport.fetch },
        async ({ signal, fetch }) => {
          const request = wireContents(
            history.data,
            baseUrl,
            model.data,
            settings.credentialId,
          );
          const declarations = definitions.data.map((tool) => ({
            name: tool.function.name,
            ...(tool.function.description
              ? { description: tool.function.description }
              : {}),
            parameters: tool.function.parameters,
          }));
          const generation: Record<string, unknown> = {};
          if (settings.maxOutputTokens)
            generation.maxOutputTokens = settings.maxOutputTokens;
          const thinking = thinkingConfig(model.data, settings.reasoningEffort);
          if (thinking) generation.thinkingConfig = thinking;
          const body = transport.applyBody(
            {
              ...(request.system
                ? { systemInstruction: { parts: [{ text: request.system }] } }
                : {}),
              contents: request.contents,
              ...(declarations.length
                ? { tools: [{ functionDeclarations: declarations }] }
                : {}),
              ...(Object.keys(generation).length
                ? { generationConfig: generation }
                : {}),
            },
            options.sessionId,
          );
          const response = await send(
            fetch,
            `${baseUrl}/models/${pathOf(model.data)}:streamGenerateContent?alt=sse`,
            {
              method: "POST",
              headers: {
                ...wireHeaders(transport.headers),
                ...transport.headersFor(body),
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
            signal,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status);
          }
          const reader = responseReader(
            options,
            model.data,
            baseUrl,
            settings.credentialId,
          );
          const contentType = response.headers
            .get("content-type")
            ?.split(";")[0]
            ?.trim()
            .toLowerCase();
          if (contentType === "text/event-stream") {
            try {
              for await (const event of sdkEvents(response))
                reader.dispatch(event.data);
            } catch (error) {
              if (error instanceof ForgeError) throw error;
              if (error instanceof TypeError)
                throw new ProviderError(
                  "network",
                  "The provider connection failed.",
                  true,
                );
              throw error;
            }
            return reader.response();
          }
          // A gateway that ignores alt=sse may answer with one JSON body
          // (Factory does, per the reference); it is the same response object.
          if (contentType === "application/json") {
            reader.accept(parseJson(await readBody(response)));
            return reader.response();
          }
          await response.body?.cancel();
          throw protocol();
        },
      );
    },
  }, settings);
}
