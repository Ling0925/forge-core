import ky from "ky";
import { z } from "zod";
import type { ModelProvider } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { ProtocolReason } from "../shared/errors";
import {
  messageSchema,
  providerConfigSchema,
  providerResponseSchema,
  settingsFields,
  toolCallSchema,
  toolDefinitionSchema,
} from "../shared/schemas";
import type {
  ProviderConfig,
  ProviderResponse,
  ToolCall,
  ToolCallPreview,
  Usage,
} from "../shared/schemas";
import { createResponsesAdapter } from "./responses";

export type ProviderFailure =
  | "http"
  | "protocol"
  | "network"
  | "timeout"
  | "aborted"
  | "observer";
export class ProviderError extends ForgeError {
  readonly classification: ProviderFailure;
  readonly status: number | undefined;
  readonly reason: ProtocolReason | undefined;
  constructor(
    classification: ProviderFailure,
    message: string,
    retryable = false,
    status?: number,
    reason?: ProtocolReason,
  ) {
    super(
      "provider",
      classification === "protocol" || classification === "http"
        ? `${message} [${classification}${status === undefined ? "" : ` HTTP ${status}`}]${reason === undefined ? "" : ` (${reason})`}`
        : message,
      retryable,
    );
    this.name = "ProviderError";
    this.classification = classification;
    this.status = status;
    this.reason = reason;
  }
}

const MAX_BODY = 8_000_000;
const MAX_EVENT = 1_200_000;
const MAX_LINE = 1_200_000;
const MAX_TEXT = 2_000_000;
// Persisted display-only reasoning preview; bounded so a chatty gateway cannot
// inflate the session transcript. Must match assistantMessageSchema.reasoning.
const MAX_REASONING = 131072;
const usageWire = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  // Gateways report prompt-cache hits either in details or at the top level.
  // Zero is a known value; absence stays absent and is never invented.
  cached_tokens: z.number().int().nonnegative().nullable().optional(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.number().int().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
});
const fragment = z.object({
  index: z.number().int().min(0).max(255),
  id: z.string().max(256).optional(),
  type: z.literal("function").optional(),
  function: z
    .object({
      name: z.string().max(64).optional(),
      arguments: z.string().max(1_000_000).optional(),
    })
    .nullable()
    .optional(),
});
const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          role: z.literal("assistant").optional(),
          content: z.string().max(MAX_TEXT).nullable().optional(),
          // Live reasoning preview some gateways stream; never assistant content.
          reasoning_content: z.string().max(MAX_TEXT).nullable().optional(),
          tool_calls: z.array(fragment).max(256).nullable().optional(),
          function_call: z
            .object({
              name: z.literal("").optional(),
              arguments: z.literal("").optional(),
            })
            .nullable()
            .optional(),
        }),
        finish_reason: z.string().max(64).nullable().optional(),
      }),
    )
    .max(1),
  usage: usageWire.nullable().optional(),
});
const jsonResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0).optional(),
        message: z.object({
          role: z.literal("assistant"),
          content: z.string().max(MAX_TEXT).nullable(),
          reasoning_content: z.string().max(MAX_TEXT).nullable().optional(),
          tool_calls: z.array(toolCallSchema).max(256).optional(),
        }),
        finish_reason: z.string().max(64),
      }),
    )
    .length(1),
  usage: usageWire.nullable().optional(),
});
const modelsSchema = z.object({
  data: z.array(z.object({
    id: z.string().trim().min(1).max(256),
    context_length: z.unknown().optional(),
    context_window: z.unknown().optional(),
    max_model_len: z.unknown().optional(),
  })).max(10000),
});
const unsupportedSchema = z.object({
  error: z.object({
    message: z.string().max(8192),
    param: z.string().nullable().optional(),
    code: z.string().nullable().optional(),
  }),
});
const protocol = (
  reason: ProtocolReason = "invalid_response",
): ProviderError =>
  new ProviderError(
    "protocol",
    "The provider returned an invalid or incomplete response.",
    false,
    undefined,
    reason,
  );

// Limit nesting before JSON.parse, including unknown metadata that Zod strips.
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
const normalizeUsage = (
  usage: z.infer<typeof usageWire> | null | undefined,
): Usage | undefined => {
  if (!usage) return undefined;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(cached == null ? {} : { cachedPromptTokens: cached }),
  };
};
const httpError = (status: number): ProviderError => {
  const message =
    status === 401 || status === 403
      ? "Provider authorization was rejected. Check provider credentials and access."
      : status === 404
        ? "The provider resource was not found. Check endpoint and model."
        : status === 408
          ? "The provider request timed out."
          : status === 429
            ? "The provider rate limit was reached."
            : status >= 500
              ? "The provider is temporarily unavailable."
              : "The provider rejected the request.";
  return new ProviderError(
    "http",
    message,
    status === 408 || status === 429 || status >= 500,
    status,
  );
};
const checkFinish = (
  reason: string | undefined,
  calls: readonly ToolCall[],
  text: string,
): void => {
  if (reason === undefined) throw protocol("missing_finish");
  if (reason === "length") throw protocol("output_truncated");
  if (reason !== "stop" && reason !== "tool_calls")
    throw protocol("invalid_finish");
  if (reason === "tool_calls" && calls.length === 0)
    throw protocol("missing_finish");
  if (reason === "stop" && calls.length > 0) throw protocol("missing_finish");
  if (calls.length === 0 && text.length === 0)
    throw protocol("invalid_response");
  if (new Set(calls.map((call) => call.id)).size !== calls.length)
    throw protocol("invalid_tool_call");
  for (const call of calls) {
    if (!call.function.arguments.trim()) throw protocol("invalid_tool_call");
    const args = parseJson(call.function.arguments);
    if (args === null || typeof args !== "object" || Array.isArray(args))
      throw protocol("invalid_tool_call");
  }
};
const notify = (observer: (text: string) => void, text: string): void => {
  if (!text) return;
  try {
    observer(text);
  } catch {
    throw new ProviderError("observer", "The response observer failed.");
  }
};
// Generation previews are display-only metadata: only bounded counters cross the
// boundary, never raw argument fragments (which may hold secrets or unvalidated
// JSON). Values are clamped here so any in-progress fragment still yields a
// schema-shaped snapshot, and a failing observer is isolated to the same safe
// classification as text observers so it can never become a retryable error.
const notifyToolCall = (
  observer: (preview: ToolCallPreview) => void,
  index: number,
  name: string,
  argumentsChars: number,
): void => {
  if (!Number.isInteger(index) || index < 0 || index > 255) return;
  const bounded = name.slice(0, 64);
  const preview: ToolCallPreview = {
    index,
    name: /^[a-zA-Z0-9_-]*$/.test(bounded) ? bounded : "",
    argumentsChars: Math.max(
      0,
      Math.min(1_000_000, Math.trunc(argumentsChars)),
    ),
  };
  try {
    observer(preview);
  } catch {
    throw new ProviderError("observer", "The response observer failed.");
  }
};

// Per-response request activity; weak keys cannot retain completed response bodies.
const responseActivity = new WeakMap<Response, { signal: AbortSignal; touch: () => void }>();

async function consumeBytes(
  response: Response,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  if (!response.body) throw protocol();
  const reader = response.body.getReader();
  const activity = responseActivity.get(response);
  // Explicitly cancel the locked reader too: some transports do not promptly
  // reject an outstanding body read when their request signal is aborted.
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  activity?.signal.addEventListener("abort", cancel, { once: true });
  let total = 0;
  try {
    for (;;) {
      activity?.signal.throwIfAborted();
      const item = await reader.read();
      activity?.signal.throwIfAborted();
      if (item.done) break;
      // Includes reasoning, tool arguments, partial UTF-8/SSE frames and comments.
      // UI animation is not network activity and cannot extend this deadline.
      if (item.value.byteLength) activity?.touch();
      total += item.value.byteLength;
      if (total > MAX_BODY) throw protocol();
      onBytes(item.value);
    }
  } finally {
    activity?.signal.removeEventListener("abort", cancel);
    responseActivity.delete(response);
    try {
      await reader.cancel();
    } catch {
      /* A failed transport may already be closed. */
    }
    reader.releaseLock();
  }
}
async function readText(response: Response): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  await consumeBytes(response, (bytes) => {
    text += decoder.decode(bytes, { stream: true });
  });
  return text + decoder.decode();
}

async function readStream(
  response: Response,
  observer: (text: string) => void,
  onReasoning: (text: string) => void = () => {},
  onToolCall: (preview: ToolCallPreview) => void = () => {},
): Promise<ProviderResponse> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let data: string[] = [];
  let eventSize = 0;
  let text = "";
  let reasoning = "";
  let finish: string | undefined;
  let usage: Usage | undefined;
  let done = false;
  const calls = new Map<
    number,
    Readonly<{ id: string; type: string; name: string; arguments: string }>
  >();
  const dispatch = (): void => {
    if (data.length === 0) return;
    const payload = data.join("\n");
    data = [];
    eventSize = 0;
    if (payload === "[DONE]") {
      // Some gateways duplicate the terminal sentinel. Final assembly below
      // still validates the finish reason and complete native calls.
      if (!finish) throw protocol("missing_finish");
      done = true;
      return;
    }
    if (done) throw protocol("unexpected_frame");
    const parsed = chunkSchema.safeParse(parseJson(payload));
    if (!parsed.success) throw protocol("invalid_chunk");
    const chunk = parsed.data;
    if (chunk.usage) usage = normalizeUsage(chunk.usage);
    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (finish) {
        // A gateway may repeat its terminal choice to replace estimated usage.
        // Only the same finish with an empty delta is idempotent, before DONE.
        if (
          choice.finish_reason !== finish ||
          delta.content ||
          delta.tool_calls?.length
        )
          throw protocol("unexpected_frame");
        continue;
      }
      if (delta.content) {
        text += delta.content;
        if (text.length > MAX_TEXT) throw protocol("output_limit");
        // Shared event text deltas have a smaller bound than final content.
        for (let start = 0; start < delta.content.length; start += 65536)
          notify(observer, delta.content.slice(start, start + 65536));
      }
      // Reasoning preview is display-only: bounded and never part of content.
      if (delta.reasoning_content) {
        if (reasoning.length < MAX_REASONING) {
          reasoning += delta.reasoning_content.slice(0, MAX_REASONING - reasoning.length);
        }
        for (let start = 0; start < delta.reasoning_content.length; start += 65536)
          notify(onReasoning, delta.reasoning_content.slice(start, start + 65536));
      }
      for (const part of delta.tool_calls ?? []) {
        const previous = calls.get(part.index) ?? {
          id: "",
          type: "",
          name: "",
          arguments: "",
        };
        const next = {
          id: previous.id + (part.id ?? ""),
          type: part.type ?? previous.type,
          name: previous.name + (part.function?.name ?? ""),
          arguments: previous.arguments + (part.function?.arguments ?? ""),
        };
        if (
          next.id.length > 256 ||
          next.name.length > 64 ||
          next.arguments.length > 1_000_000
        )
          throw protocol("invalid_tool_call");
        calls.set(part.index, next);
        // Cumulative snapshot only: the raw fragment never leaves this scope.
        notifyToolCall(
          onToolCall,
          part.index,
          next.name,
          next.arguments.length,
        );
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  };
  const line = (value: string): void => {
    if (value.length > MAX_LINE) throw protocol("output_limit");
    if (value === "") {
      dispatch();
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") {
      eventSize += content.length + 1;
      if (eventSize > MAX_EVENT) throw protocol("output_limit");
      data.push(content);
    } else if (field !== "event" && field !== "id" && field !== "retry")
      throw protocol("unexpected_frame");
  };
  const feed = (value: string): void => {
    pending += value;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const raw = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      line(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    }
    if (pending.length > MAX_LINE) throw protocol("output_limit");
  };
  await consumeBytes(response, (bytes) =>
    feed(decoder.decode(bytes, { stream: true })),
  );
  feed(decoder.decode());
  // A clean EOF without [DONE] is compatible, but not an unterminated event.
  if (pending.length > 0 || data.length > 0)
    throw protocol("unterminated_event");
  const assembled: ToolCall[] = [];
  const entries = [...calls.entries()].sort(([a], [b]) => a - b);
  for (const [index, call] of entries) {
    if (index !== assembled.length) throw protocol("invalid_tool_call");
    const result = toolCallSchema.safeParse({
      id: call.id,
      type: call.type,
      function: { name: call.name, arguments: call.arguments },
    });
    if (!result.success) throw protocol("invalid_tool_call");
    assembled.push(result.data);
  }
  checkFinish(finish, assembled, text);
  return providerResponseSchema.parse({
    message: {
      role: "assistant",
      content: text || null,
      ...(reasoning ? { reasoning } : {}),
      ...(assembled.length ? { tool_calls: assembled } : {}),
    },
    ...(usage ? { usage } : {}),
  });
}

export function createModelProvider(config: ProviderConfig): ModelProvider {
  const parsedConfig = providerConfigSchema.safeParse(config);
  if (!parsedConfig.success)
    throw new ForgeError(
      "invalid_input",
      "Configure a valid provider endpoint and timeout.",
      false,
    );
  const settings = parsedConfig.data;
  const base = settings.baseUrl.replace(/\/+$/, "");
  const responses = createResponsesAdapter(
    { protocol, parseJson, consumeBytes, notify, notifyToolCall },
    base,
  );
  const headers = settings.apiKey
    ? { Authorization: `Bearer ${settings.apiKey}` }
    : {};
  const execute = async <T>(
    signal: AbortSignal | undefined,
    operation: (combined: AbortSignal, trackResponse: (response: Response) => Response) => Promise<T>,
    idleTimeout = false,
  ): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    let settled = false;
    const timeoutMessage = idleTimeout
      ? `The provider sent no data for ${settings.requestTimeoutMs} ms (idle timeout).`
      : "The provider request timed out.";
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.requestTimeoutMs);
    const activity = (): void => {
      if (idleTimeout && !settled && !controller.signal.aborted) timer.refresh();
    };
    const trackResponse = (response: Response): Response => {
      activity(); // Headers arrived; start the body idle interval.
      responseActivity.set(response, { signal: controller.signal, touch: activity });
      return response;
    };
    try {
      if (controller.signal.aborted)
        throw new ProviderError(
          "aborted",
          "The provider request was cancelled.",
        );
      const result = await operation(controller.signal, trackResponse);
      if (controller.signal.aborted)
        throw new ProviderError(
          timedOut ? "timeout" : "aborted",
          timedOut
            ? timeoutMessage
            : "The provider request was cancelled.",
          timedOut,
        );
      return result;
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted)
        throw new ProviderError(
          "aborted",
          "The provider request was cancelled.",
        );
      if (timedOut || (error instanceof Error && error.name === "TimeoutError"))
        throw new ProviderError(
          "timeout",
          timeoutMessage,
          true,
        );
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof TypeError && error.message.includes("encoded data"))
      )
        throw protocol();
      throw new ProviderError(
        "network",
        "The provider connection failed.",
        true,
      );
    } finally {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  };
  const windows = new Map<string, number | null>();
  let catalogLoaded = false;
  const listModels = (signal?: AbortSignal) =>
      execute(signal, async (combined, trackResponse) => {
        const response = await ky.get(`${base}/models`, {
          headers,
          signal: combined,
          timeout: settings.requestTimeoutMs,
          retry: {
            limit: 1,
            methods: ["get"],
            statusCodes: [408, 429, 500, 502, 503, 504],
            retryOnTimeout: false,
          },
          throwHttpErrors: false,
        }).then(trackResponse);
        if (!response.ok) {
          await response.body?.cancel();
          throw httpError(response.status);
        }
        const parsed = modelsSchema.safeParse(
          parseJson(await readText(response)),
        );
        if (!parsed.success) throw protocol();
        for (const model of parsed.data.data) {
          const value = [model.context_length, model.context_window, model.max_model_len]
            .find((v): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 10000000);
          windows.set(model.id, value ?? null);
        }
        catalogLoaded = true;
        return [...new Set(parsed.data.data.map((model) => model.id))].sort();
      });
  return {
    listModels,
    async getModelContextWindow(model, signal) {
      if (!catalogLoaded) await listModels(signal);
      return windows.get(model) ?? null;
    },
    complete: (messages, tools, options) => {
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
      return execute(options.signal, async (combined, trackResponse) => {
        if (settings.apiMode === "responses") {
          const response = await ky.post(`${base}/responses`, {
            headers,
            signal: combined,
            timeout: settings.requestTimeoutMs,
            retry: { limit: 0 },
            throwHttpErrors: false,
            json: {
              ...responses.body(history.data, definitions.data, model.data),
              ...(settings.reasoningEffort &&
              settings.reasoningEffort !== "default"
                ? { reasoning: { effort: settings.reasoningEffort } }
                : {}),
            },
          }).then(trackResponse);
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status);
          }
          if (
            response.headers
              .get("content-type")
              ?.split(";")[0]
              ?.trim()
              .toLowerCase() !== "text/event-stream"
          ) {
            await response.body?.cancel();
            throw protocol();
          }
          return responses.read(
            response,
            options.onText,
            model.data,
            options.onReasoning,
            options.onToolCall,
          );
        }
        const request = async (stream: boolean): Promise<Response> =>
          ky.post(`${base}/chat/completions`, {
            headers,
            signal: combined,
            timeout: settings.requestTimeoutMs,
            retry: { limit: 0 },
            throwHttpErrors: false,
            json: {
              model: model.data,
              ...(settings.reasoningEffort &&
              settings.reasoningEffort !== "default"
                ? { reasoning_effort: settings.reasoningEffort }
                : {}),
              messages: history.data.map((message) =>
                message.role === "assistant"
                  ? {
                      role: message.role,
                      content: message.content,
                      ...(message.tool_calls
                        ? { tool_calls: message.tool_calls }
                        : {}),
                    }
                  : message.role === "tool"
                    ? {
                        role: "tool",
                        content: message.content,
                        tool_call_id: message.tool_call_id,
                      }
                    : {
                        role: message.role,
                        content: message.role === "user" && message.images?.length
                          ? [
                              ...(message.content ? [{ type: "text", text: message.content }] : []),
                              ...message.images.map(image => ({ type: "image_url", image_url: { url: image.dataUrl } })),
                            ]
                          : message.content,
                      },
              ),
              ...(definitions.data.length ? { tools: definitions.data } : {}),
              stream,
              // Ask spec-compliant gateways to report usage in the stream; without
              // this the footer never receives a real cache rate during a run.
              ...(stream ? { stream_options: { include_usage: true } } : {}),
            },
          }).then(trackResponse);
        let response = await request(true);
        if (response.status === 400 || response.status === 422) {
          const raw = await readText(response);
          let unsupported = false;
          try {
            const parsed = unsupportedSchema.safeParse(parseJson(raw));
            if (parsed.success) {
              const error = parsed.data.error;
              unsupported =
                /\bstream(?:ing)?\b/i.test(error.message) &&
                /not supported|unsupported|does not support/i.test(
                  error.message,
                );
            }
          } catch {
            /* An unrecognized rejection never enables fallback. */
          }
          if (!unsupported) throw httpError(response.status);
          response = await request(false);
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw httpError(response.status);
        }
        const contentType = response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        if (contentType === "text/event-stream")
          return readStream(
            response,
            options.onText,
            options.onReasoning,
            options.onToolCall,
          );
        if (contentType !== "application/json") {
          await response.body?.cancel();
          throw protocol();
        }
        const parsed = jsonResponseSchema.safeParse(
          parseJson(await readText(response)),
        );
        if (!parsed.success) throw protocol();
        const choice = parsed.data.choices[0];
        if (!choice) throw protocol();
        const text = choice.message.content ?? "";
        const calls = choice.message.tool_calls ?? [];
        checkFinish(choice.finish_reason, calls, text);
        // A non-streaming response has no intermediate frames, so announce the
        // validated complete metadata once, still without raw arguments.
        if (options.onToolCall)
          for (const [index, call] of calls.entries())
            notifyToolCall(
              options.onToolCall,
              index,
              call.function.name,
              call.function.arguments.length,
            );
        const reasoningRaw = choice.message.reasoning_content;
        const reasoning = reasoningRaw
          ? reasoningRaw.slice(0, MAX_REASONING)
          : "";
        if (reasoning)
          for (let start = 0; start < reasoning.length; start += 65536)
            notify(options.onReasoning ?? (() => {}), reasoning.slice(start, start + 65536));
        for (let start = 0; start < text.length; start += 65536)
          notify(options.onText, text.slice(start, start + 65536));
        const usage = normalizeUsage(parsed.data.usage);
        return providerResponseSchema.parse({
          message: {
            role: "assistant",
            content: text || null,
            ...(reasoning ? { reasoning } : {}),
            ...(calls.length ? { tool_calls: calls } : {}),
          },
          ...(usage ? { usage } : {}),
        });
      }, true);
    },
  };
}
