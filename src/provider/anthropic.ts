import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { ModelProvider } from "../shared/contracts";
import { scopeProviderState } from "./state-scope";
import { ForgeError, type ProtocolReason } from "../shared/errors";
import {
  jsonObjectSchema,
  messageSchema,
  providerResponseSchema,
  settingsFields,
  toolCallSchema,
  toolDefinitionSchema,
} from "../shared/schemas";
import type { JsonValue, Message, ProviderConfig, Usage } from "../shared/schemas";
import { estimateToolCallLines } from "../shared/tool-preview-lines";
import { ProviderError, httpError, protocol } from "./errors";
import { normalizeModelCatalog } from "./catalog";
import { createRequestOptions } from "./request-options";
import { sdkEvents, withSdkRequest } from "./sdk-transport";
import type { ModelCatalog } from "../shared/model-catalog";

const contentSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string().max(2000000) }),
      z.object({
        type: z.literal("thinking"),
        thinking: z.string().max(2000000),
        // Compatible gateways may expose unsigned thoughts. Display them, but
        // never forge a signature or replay them as native thinking context.
        signature: z.string().max(2000000).optional().default(""),
      }),
      z.object({
        type: z.literal("redacted_thinking"),
        data: z.string().min(1),
      }),
      z.object({
        type: z.literal("tool_use"),
        id: toolCallSchema.unwrap().shape.id,
        name: toolCallSchema.unwrap().shape.function.unwrap().shape.name,
        input: jsonObjectSchema,
      }),
    ]),
  )
  .max(256);
type Content = z.infer<typeof contentSchema>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Stream events arrive from compatible gateways, so every block is assembled
// here and cross-checked before it becomes a Content value.
type MutableContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Readonly<Record<string, JsonValue>>;
    };
type ToolUseContent = Extract<MutableContent, { type: "tool_use" }>;
// Static stage + allowlisted reason only: never log Zod issues or SDK messages.
const invalid = (stage: "history" | "stream" | "content" | "tool_input" | "usage" | "result", reason: ProtocolReason) =>
  new ProviderError("protocol", `Anthropic ${stage} validation failed.`, false, undefined, reason);
function parseContent(value: unknown, stage: "history" | "content"): Content {
  const parsed = contentSchema.safeParse(value);
  if (!parsed.success) throw invalid(stage, "invalid_chunk");
  return parsed.data;
}
const replayContent = (content: Content): Content => content.filter(block => block.type !== "thinking" || Boolean(block.signature));
function parseToolInput(text: string, stage: "history" | "tool_input") {
  try {
    return jsonObjectSchema.parse(JSON.parse(text));
  } catch {
    throw invalid(stage, "invalid_tool_call");
  }
}
const tokenCount = z.number().int().nonnegative();
const anthropicUsageSchema = z.object({
  input_tokens: tokenCount, output_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount.nullish(), cache_read_input_tokens: tokenCount.nullish(),
});
// Compatible gateways may omit counters, but message_start does not use null
// for input/output totals. In message_delta, null prompt/cache counts mean that
// the counter has not changed; output_tokens must still be numeric if supplied.
const anthropicUsageStartSchema = anthropicUsageSchema.partial();
const anthropicUsageDeltaSchema = z.object({
  input_tokens: tokenCount.nullish(),
  output_tokens: tokenCount.optional(),
  cache_creation_input_tokens: tokenCount.nullish(),
  cache_read_input_tokens: tokenCount.nullish(),
});
const anthropicUsageKeys = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;
type MutableUsage = Partial<
  Record<(typeof anthropicUsageKeys)[number], number>
>;
const summarize = (content: Content) => ({
  text: content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(""),
  calls: content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: { name: block.name, arguments: JSON.stringify(block.input) },
    })),
});

function history(
  messages: readonly Message[],
  baseUrl: string,
  model: string,
  credentialId?: string,
): MessageParam[] {
  const result: MessageParam[] = [];
  const pending = new Set<string>();
  const used = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id))
        throw protocol("invalid_tool_call");
      let isError = false;
      try {
        isError = z
          .object({ isError: z.boolean() })
          .parse(JSON.parse(message.content)).isError;
      } catch {
        /* Non-Forge tool results remain plain text. */
      }
      const block: ContentBlockParam = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
        is_error: isError,
      };
      const previous = result.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content))
        previous.content.push(block);
      else result.push({ role: "user", content: [block] });
      continue;
    }
    if (pending.size) throw protocol("invalid_tool_call");
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content: ContentBlockParam[] = message.content
        ? [{ type: "text", text: message.content }]
        : [];
      for (const image of message.images ?? []) {
        const [header, data] = image.dataUrl.split(",");
        const media_type = z
          .enum(["image/png", "image/jpeg", "image/gif", "image/webp"])
          .parse(header?.slice(5, -7));
        if (!data) throw protocol();
        content.push({
          type: "image",
          source: { type: "base64", media_type, data },
        });
      }
      result.push({ role: "user", content: content.length ? content : "" });
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      if (used.has(call.id)) throw protocol("invalid_tool_call");
      used.add(call.id);
      pending.add(call.id);
    }
    const state = message.providerState;
    if (
      state?.apiMode === "anthropic" &&
      state.baseUrl === baseUrl &&
      state.model === model &&
      (credentialId === undefined
        ? state.credentialId === undefined
        : state.credentialId === credentialId)
    ) {
      const content = replayContent(parseContent(state.output, "history"));
      const normalized = summarize(content);
      if (
        normalized.text !== (message.content ?? "") ||
        JSON.stringify(normalized.calls) !==
          JSON.stringify(message.tool_calls ?? [])
      )
        throw protocol("invalid_tool_call");
      result.push({ role: "assistant", content });
    } else {
      const content: ContentBlockParam[] = message.content
        ? [{ type: "text", text: message.content }]
        : [];
      for (const call of message.tool_calls ?? [])
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments, "history"),
        });
      result.push({
        role: "assistant",
        content: content.length ? content : "",
      });
    }
  }
  if (pending.size) throw protocol("invalid_tool_call");
  return result;
}

export function createAnthropicProvider(
  settings: ProviderConfig,
): ModelProvider {
  const baseUrl = settings.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const requestOptions = createRequestOptions(settings);
  const clientFor = (fetch: typeof globalThis.fetch) =>
    new Anthropic({
      apiKey: null,
      authToken: null,
      baseURL: baseUrl,
      maxRetries: 0,
      timeout: settings.requestTimeoutMs,
      fetch,
      logLevel: "off",
      defaultHeaders: requestOptions.headers,
    });
  let windows = new Map<string, number | null>();
  let catalog: ModelCatalog | undefined;
  const loadCatalog = (signal?: AbortSignal) =>
    withSdkRequest(
      settings,
      { signal, idle: false, fetch: requestOptions.fetch },
      async ({ signal, fetch }) => {
        const raw: unknown[] = [];
        for await (const model of clientFor(fetch).models.list(
          { limit: 100 },
          { signal },
        )) {
          raw.push({ ...model, id: settingsFields.model.parse(model.id) });
          if (raw.length > 10000) throw protocol("output_limit");
        }
        // Publish a cache only after every page succeeded.
        const next = normalizeModelCatalog(raw, { protocol: "anthropic" });
        windows = new Map(
          next
            .filter((model) => model.contextWindowTokens !== null)
            .map((model) => [model.id, model.contextWindowTokens] as const),
        );
        catalog = next;
        return next;
      },
    );
  // Always ask the source; the catalog store owns sharing and refresh.
  const listModels = async (signal?: AbortSignal) => {
    const models = await loadCatalog(signal);
    return models.map((model) => model.id).sort();
  };
  return scopeProviderState({
    listModels,
    listModelCatalog(signal) {
      return loadCatalog(signal);
    },
    async getModelContextWindow(model, signal) {
      if (!catalog) await loadCatalog(signal);
      return windows.get(model) ?? null;
    },
    complete: async (messages, tools, options) => {
      const parsed = z
        .object({
          model: settingsFields.model,
          messages: z.array(messageSchema).max(100000),
          tools: z.array(toolDefinitionSchema).max(256),
        })
        .safeParse({ model: options.model, messages, tools });
      if (!parsed.success)
        throw new ForgeError(
          "invalid_input",
          "Provide a valid model, message history and tool definitions.",
        );
      return withSdkRequest(
        settings,
        { signal: options.signal, idle: true, fetch: requestOptions.fetch },
        async ({ signal, fetch, hasBodyFailure }) => {
          const maxTokens = settings.maxOutputTokens ?? 8192;
          const effort = settings.reasoningEffort ?? "default";
          const budget = {
            minimal: 1024,
            low: 1024,
            medium: 4096,
            high: 8192,
            xhigh: 16384,
          };
          if (effort !== "default" && effort !== "none" && effort !== "max" && maxTokens <= 1024)
            throw new ForgeError(
              "invalid_input",
              "Anthropic thinking requires maxOutputTokens greater than 1024.",
            );
          const body = requestOptions.applyBody(
            {
              model: parsed.data.model,
              max_tokens: maxTokens,
              system: parsed.data.messages
                .filter((message) => message.role === "system")
                .map((message) => message.content)
                .join("\n\n"),
              messages: history(
                parsed.data.messages,
                baseUrl,
                parsed.data.model,
                settings.credentialId,
              ),
              ...(parsed.data.tools.length
                ? {
                    tools: parsed.data.tools.map((tool) => ({
                      name: tool.function.name,
                      description: tool.function.description,
                      input_schema: {
                        ...tool.function.parameters,
                        type: z
                          .literal("object")
                          .parse(tool.function.parameters.type),
                      },
                    })),
                  }
                : {}),
              ...(effort === "max"
                ? {
                    thinking: { type: "adaptive" as const },
                    output_config: { effort: "max" as const },
                  }
                : effort === "none"
                  ? { thinking: { type: "disabled" as const } }
                  : effort !== "default"
                    ? {
                        thinking: {
                          type: "enabled" as const,
                          budget_tokens: Math.min(budget[effort], maxTokens - 1),
                        },
                      }
                    : {}),
            },
            options.sessionId,
          );
          const requestBody = { ...body, stream: true as const };
          const response = await clientFor(fetch)
            .messages.create(requestBody, {
              signal,
              headers: requestOptions.headersFor(requestBody),
            })
            .asResponse();
          if (!response.ok) {
            await response.body?.cancel();
            throw httpError(response.status);
          }
          if (!response.body) throw invalid("stream", "invalid_chunk");
          // The SDK's message stream force-parses incremental tool JSON with a
          // partial parser while the block is still open, then reports the
          // failure as an opaque stream error, and an empty argument delta
          // replaces the start block's input. Assemble the validated events
          // here instead: arguments are parsed strictly once their block
          // closes, and a block without JSON keeps the input object supplied
          // by its start event.
          const argumentsByIndex = new Map<number, string>();
          const initialInputs = new Map<
            number,
            Readonly<Record<string, JsonValue>>
          >();
          const blocks: MutableContent[] = [];
          const openBlocks = new Set<number>();
          const seenBlocks = new Set<number>();
          const usageParts: MutableUsage = {};
          let finalOutputReported = false;
          let messageStarted = false;
          let messageStopped = false;
          let stopReason: string | null = null;
          let reasoning = "";
          let observerFailure: ProviderError | undefined;
          const notify = (callback: () => void) => {
            if (observerFailure) return;
            try {
              callback();
            } catch {
              observerFailure = new ProviderError(
                "observer",
                "A provider observer failed.",
              );
            }
          };
          const emitText = (text: string) => {
            for (let i = 0; i < text.length; i += 65536)
              options.onText(text.slice(i, i + 65536));
          };
          const emitReasoning = (text: string) => {
            const delta = text.slice(0, Math.max(0, 131072 - reasoning.length));
            if (!delta) return;
            reasoning += delta;
            for (let i = 0; i < delta.length; i += 65536)
              options.onReasoning?.(delta.slice(i, i + 65536));
          };
          const preview = (index: number, block: ToolUseContent) => {
            const argumentsText = argumentsByIndex.get(index) ?? "";
            // Display-only counters derived inside this scope; the fragment
            // itself still never leaves the provider.
            const lines = estimateToolCallLines(block.name, argumentsText);
            notify(() =>
              options.onToolCall?.({
                index: blocks
                  .slice(0, index)
                  .filter((entry) => entry.type === "tool_use").length,
                name: block.name,
                argumentsChars: argumentsText.length,
                ...lines,
              }),
            );
          };
          const blockIndex = (event: Record<string, unknown>): number => {
            const value = event.index;
            if (
              typeof value !== "number" ||
              !Number.isInteger(value) ||
              value < 0 ||
              value >= 256
            )
              throw invalid("stream", "unexpected_frame");
            return value;
          };
          const mergeUsage = (value: unknown, phase: "start" | "delta"): void => {
            if (value === undefined) return;
            const schema = phase === "start" ? anthropicUsageStartSchema : anthropicUsageDeltaSchema;
            const parsed = schema.safeParse(value);
            if (!parsed.success) throw invalid("usage", "invalid_chunk");
            for (const key of anthropicUsageKeys) {
              const count = parsed.data[key];
              if (count != null) usageParts[key] = count;
            }
          };
          const dispatch = (payload: unknown): void => {
            if (!isRecord(payload) || typeof payload.type !== "string")
              throw invalid("stream", "invalid_chunk");
            const event = payload;
            if (event.type === "ping") return;
            if (event.type === "error") throw protocol("provider_error_event");
            if (messageStopped) throw invalid("stream", "unexpected_frame");
            if (event.type === "message_start") {
              if (
                messageStarted ||
                !isRecord(event.message) ||
                !Array.isArray(event.message.content) ||
                event.message.content.length
              )
                throw invalid("stream", "unexpected_frame");
              messageStarted = true;
              mergeUsage(event.message.usage, "start");
              return;
            }
            if (!messageStarted) throw invalid("stream", "unexpected_frame");
            if (event.type === "message_stop") {
              if (openBlocks.size) throw invalid("stream", "invalid_finish");
              messageStopped = true;
              return;
            }
            if (event.type === "content_block_stop") {
              const index = blockIndex(event);
              if (!openBlocks.delete(index))
                throw invalid("stream", "unexpected_frame");
              const block = blocks[index];
              if (block?.type === "tool_use") {
                const assembled = argumentsByIndex.get(index) ?? "";
                // Empty or whitespace-only fragments carry no JSON; the
                // validated start input stays authoritative for that block.
                block.input = assembled.trim()
                  ? parseToolInput(assembled, "tool_input")
                  : (initialInputs.get(index) ?? {});
              }
              return;
            }
            if (event.type === "message_delta") {
              if (openBlocks.size) throw invalid("stream", "invalid_finish");
              const delta = event.delta;
              if (
                !isRecord(delta) ||
                (typeof delta.stop_reason !== "string" &&
                  delta.stop_reason !== null)
              )
                throw invalid("stream", "invalid_chunk");
              if (delta.stop_reason !== null) {
                if (stopReason !== null && stopReason !== delta.stop_reason)
                  throw invalid("stream", "invalid_finish");
                stopReason = delta.stop_reason;
              }
              mergeUsage(event.usage, "delta");
              if (isRecord(event.usage) && event.usage.output_tokens !== undefined)
                finalOutputReported = true;
              return;
            }
            if (event.type === "content_block_start") {
              const index = blockIndex(event);
              if (
                index !== seenBlocks.size ||
                openBlocks.size ||
                stopReason !== null ||
                seenBlocks.has(index)
              )
                throw invalid("stream", "unexpected_frame");
              const parsedBlock = contentSchema.element.safeParse(
                event.content_block,
              );
              if (!parsedBlock.success) throw invalid("stream", "invalid_chunk");
              const initial = parsedBlock.data;
              seenBlocks.add(index);
              openBlocks.add(index);
              if (initial.type === "text") {
                blocks.push({ type: "text", text: initial.text });
                if (initial.text) notify(() => emitText(initial.text));
              } else if (initial.type === "thinking") {
                blocks.push({
                  type: "thinking",
                  thinking: initial.thinking,
                  signature: initial.signature,
                });
                if (initial.thinking)
                  notify(() => emitReasoning(initial.thinking));
              } else if (initial.type === "redacted_thinking") {
                blocks.push({ type: "redacted_thinking", data: initial.data });
              } else {
                const block: ToolUseContent = {
                  type: "tool_use",
                  id: initial.id,
                  name: initial.name,
                  input: initial.input,
                };
                blocks.push(block);
                initialInputs.set(index, initial.input);
                preview(index, block);
              }
              return;
            }
            if (event.type !== "content_block_delta") return;
            const index = blockIndex(event);
            if (!openBlocks.has(index))
              throw invalid("stream", "unexpected_frame");
            const block = blocks[index];
            const delta = event.delta;
            if (!isRecord(delta)) throw invalid("stream", "invalid_chunk");
            switch (delta.type) {
              case "text_delta": {
                const text = delta.text;
                if (block?.type !== "text" || typeof text !== "string")
                  throw invalid("stream", "invalid_chunk");
                block.text += text;
                notify(() => emitText(text));
                return;
              }
              case "thinking_delta": {
                const thinking = delta.thinking;
                if (block?.type !== "thinking" || typeof thinking !== "string")
                  throw invalid("stream", "invalid_chunk");
                block.thinking += thinking;
                notify(() => emitReasoning(thinking));
                return;
              }
              case "signature_delta": {
                const signature = delta.signature;
                if (block?.type !== "thinking" || typeof signature !== "string")
                  throw invalid("stream", "invalid_chunk");
                block.signature = signature;
                return;
              }
              case "input_json_delta": {
                const fragment = delta.partial_json;
                if (block?.type !== "tool_use" || typeof fragment !== "string")
                  throw invalid("stream", "invalid_chunk");
                const assembled = (argumentsByIndex.get(index) ?? "") + fragment;
                if (assembled.length > 1_000_000)
                  throw protocol("output_limit");
                argumentsByIndex.set(index, assembled);
                preview(index, block);
                return;
              }
              case "citations_delta":
                if (block?.type !== "text")
                  throw invalid("stream", "invalid_chunk");
                return;
              default:
                throw invalid("stream", "invalid_chunk");
            }
          };
          try {
            for await (const event of sdkEvents(response)) {
              if (observerFailure) break;
              // Default SSE names and header-only native types are compatible,
              // but contradictory named events must not hide an upstream error.
              if (event.event === "ping" && !event.data) continue;
              let payload: unknown;
              try {
                payload = JSON.parse(event.data);
              } catch {
                throw invalid("stream", "invalid_json");
              }
              if (!isRecord(payload)) throw invalid("stream", "invalid_chunk");
              const nativeEvent = event.event === "message" ? null : event.event;
              if (nativeEvent && payload.type !== undefined && payload.type !== nativeEvent)
                throw invalid("stream", "unexpected_frame");
              dispatch({ ...payload, type: payload.type ?? nativeEvent });
            }
          } catch (error) {
            if (observerFailure) throw observerFailure;
            // Leave HTTP/network/cancellation mapping to the transport.
            if (
              error instanceof ProviderError ||
              signal?.aborted ||
              hasBodyFailure()
            )
              throw error;
            if (error instanceof SyntaxError)
              throw invalid("stream", "invalid_json");
            if (
              error instanceof TypeError ||
              error instanceof Anthropic.AnthropicError
            )
              throw invalid(
                "stream",
                messageStarted && !messageStopped
                  ? "invalid_finish"
                  : "invalid_chunk",
              );
            throw error;
          }
          if (observerFailure) throw observerFailure;
          if (!messageStarted) throw invalid("stream", "invalid_chunk");
          if (!messageStopped || openBlocks.size)
            throw invalid("stream", "invalid_finish");
          const content = parseContent(blocks, "content");
          const { text, calls } = summarize(content);
          if (stopReason === "max_tokens") throw protocol("output_truncated");
          if (
            !(
              ["end_turn", "stop_sequence", "tool_use"] as readonly unknown[]
            ).includes(stopReason)
          )
            throw protocol("invalid_finish");
          if (
            (stopReason === "tool_use") !== calls.length > 0 ||
            (!text && !calls.length)
          )
            throw protocol("invalid_finish");
          if (new Set(calls.map((call) => call.id)).size !== calls.length)
            throw protocol("invalid_tool_call");
          // Missing counters are unknown, not zero. In particular message_start
          // output_tokens counts only the initial prefix, not the final answer.
          // mergeUsage already rejects malformed counters whenever supplied.
          const parsedUsage = anthropicUsageSchema.safeParse(usageParts);
          let usage: Usage | undefined;
          if (finalOutputReported && parsedUsage.success) {
            const u = parsedUsage.data;
            const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            usage = {
              promptTokens: input,
              completionTokens: u.output_tokens,
              totalTokens: input + u.output_tokens,
              ...(u.cache_read_input_tokens != null ? { cachedPromptTokens: u.cache_read_input_tokens } : {}),
            };
          }
          const replay = replayContent(content);
          // Include initial, non-delta thinking too. Final validated content is
          // authoritative; the live buffer is only a bounded preview.
          reasoning = content.filter(block => block.type === "thinking").map(block => block.thinking).join("").slice(0, 131072);
          const parsedResponse = providerResponseSchema.safeParse({
            message: {
              role: "assistant",
              content: text || null,
              ...(reasoning ? { reasoning } : {}),
              ...(calls.length ? { tool_calls: calls } : {}),
              ...(replay.some(
                (block) =>
                  block.type === "thinking" ||
                  block.type === "redacted_thinking",
              )
                ? {
                    providerState: {
                      version: 1,
                      apiMode: "anthropic",
                      baseUrl,
                      model: parsed.data.model,
                      ...(settings.credentialId
                        ? { credentialId: settings.credentialId }
                        : {}),
                      output: replay,
                    },
                  }
                : {}),
            },
            ...(usage ? { usage } : {}),
          });
          if (!parsedResponse.success) throw invalid("result", "invalid_response");
          return parsedResponse.data;
        },
      );
    },
  }, settings);
}
