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
import type { Message, ProviderConfig } from "../shared/schemas";
import { estimateToolCallLines } from "../shared/tool-preview-lines";
import { ProviderError, protocol } from "./errors";
import { normalizeModelCatalog } from "./catalog";
import { createRequestOptions } from "./request-options";
import { withSdkRequest } from "./sdk-transport";
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
          const stream = clientFor(fetch).messages.stream(body, {
            signal,
            headers: requestOptions.headersFor(body),
          });
          let observerFailure: ProviderError | undefined;
          const argumentsByIndex = new Map<number, string>();
          const openBlocks = new Set<number>();
          const seenBlocks = new Set<number>();
          let messageStarted = false;
          let messageStopped = false;
          const failStream = (reason: ProtocolReason) => {
            observerFailure ??= invalid("stream", reason);
            stream.abort();
          };
          const notify = (callback: () => void) => {
            if (observerFailure) return;
            try {
              callback();
            } catch {
              observerFailure = new ProviderError(
                "observer",
                "A provider observer failed.",
              );
              stream.abort();
            }
          };
          let reasoning = "";
          stream.on("text", (text) =>
            notify(() => {
              for (let i = 0; i < text.length; i += 65536)
                options.onText(text.slice(i, i + 65536));
            }),
          );
          stream.on("thinking", (text) => {
            const delta = text.slice(0, Math.max(0, 131072 - reasoning.length));
            reasoning += delta;
            if (delta)
              notify(() => {
                for (let i = 0; i < delta.length; i += 65536)
                  options.onReasoning?.(delta.slice(i, i + 65536));
              });
          });
          stream.on("streamEvent", (event, snapshot) => {
            if (observerFailure) return;
            if (messageStopped) return failStream("unexpected_frame");
            if (event.type === "message_start") {
              if (messageStarted || !Array.isArray(event.message.content) || event.message.content.length)
                return failStream("unexpected_frame");
              messageStarted = true;
              return;
            }
            if (!messageStarted) return failStream("unexpected_frame");
            if (event.type === "message_stop") {
              if (openBlocks.size) return failStream("invalid_finish");
              messageStopped = true;
              return;
            }
            if (event.type === "content_block_stop") {
              if (!openBlocks.delete(event.index)) return failStream("unexpected_frame");
              return;
            }
            if (event.type === "message_delta") {
              if (openBlocks.size) return failStream("invalid_finish");
              return;
            }
            if (event.type === "content_block_start") {
              if (!Number.isInteger(event.index) || event.index < 0 || event.index >= 256 ||
                  event.index !== seenBlocks.size || openBlocks.size || seenBlocks.has(event.index))
                return failStream("unexpected_frame");
              if (!contentSchema.element.safeParse(event.content_block).success) return failStream("invalid_chunk");
              seenBlocks.add(event.index);
              openBlocks.add(event.index);
              const initial = event.content_block;
              if (initial.type === "thinking" && initial.thinking) {
                const delta = initial.thinking.slice(0, Math.max(0, 131072 - reasoning.length));
                reasoning += delta;
                if (delta) notify(() => options.onReasoning?.(delta));
              } else if (initial.type === "text" && initial.text) {
                notify(() => {
                  for (let i = 0; i < initial.text.length; i += 65536) options.onText(initial.text.slice(i, i + 65536));
                });
              }
            }
            if (event.type === "content_block_delta" && !openBlocks.has(event.index)) return failStream("unexpected_frame");
            if (
              event.type !== "content_block_start" &&
              event.type !== "content_block_delta"
            )
              return;
            const block = snapshot.content[event.index];
            if (event.type === "content_block_delta") {
              const delta = event.delta;
              const valid = delta.type === "input_json_delta" ? block?.type === "tool_use" && typeof delta.partial_json === "string"
                : delta.type === "text_delta" ? block?.type === "text" && typeof delta.text === "string"
                : delta.type === "thinking_delta" ? block?.type === "thinking" && typeof delta.thinking === "string"
                : delta.type === "signature_delta" ? block?.type === "thinking" && typeof delta.signature === "string"
                : delta.type === "citations_delta" && block?.type === "text";
              if (!valid) return failStream("invalid_chunk");
            }
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "input_json_delta"
            ) {
              const value =
                (argumentsByIndex.get(event.index) ?? "") +
                event.delta.partial_json;
              argumentsByIndex.set(event.index, value);
              if (value.length > 1000000) {
                observerFailure = protocol("output_limit");
                stream.abort();
                return;
              }
            }
            if (block?.type === "tool_use") {
              const argumentsText = argumentsByIndex.get(event.index) ?? "";
              // Display-only counters derived inside this scope; the fragment
              // itself still never leaves the provider.
              const lines = estimateToolCallLines(block.name, argumentsText);
              notify(() =>
                options.onToolCall?.({
                  index: snapshot.content
                    .slice(0, event.index)
                    .filter((block) => block.type === "tool_use").length,
                  name: block.name,
                  argumentsChars: argumentsText.length,
                  ...lines,
                }),
              );
            }
          });
          let result: Anthropic.Message;
          try {
            result = await stream.finalMessage();
          } catch (error) {
            if (observerFailure) throw observerFailure;
            // Leave HTTP/network/cancellation mapping to the transport. SDK
            // assembly errors have no safe upstream text worth surfacing.
            if (error instanceof Anthropic.APIError || signal?.aborted || hasBodyFailure()) throw error;
            if (error instanceof SyntaxError) throw invalid("stream", "invalid_json");
            if (error instanceof TypeError || error instanceof Anthropic.AnthropicError)
              throw invalid("stream", messageStarted && !messageStopped ? "invalid_finish" : "invalid_chunk");
            throw error;
          }
          if (observerFailure) throw observerFailure;
          if (!messageStopped || openBlocks.size) throw invalid("stream", "invalid_finish");
          if (stream.receivedMessages.length !== 1) throw invalid("stream", "unexpected_frame");
          const content = parseContent(result.content, "content");
          for (const [index, argumentsText] of argumentsByIndex) {
            // Empty deltas contain no JSON to assemble. The validated initial
            // input object remains authoritative for a no-argument tool.
            if (argumentsText === "") continue;
            const block = content[index];
            const input = parseToolInput(argumentsText, "tool_input");
            if (
              block?.type !== "tool_use" ||
              JSON.stringify(input) !== JSON.stringify(block.input)
            )
              throw protocol("invalid_tool_call");
          }
          const { text, calls } = summarize(content);
          if (result.stop_reason === "max_tokens")
            throw protocol("output_truncated");
          if (
            !(
              ["end_turn", "stop_sequence", "tool_use"] as readonly unknown[]
            ).includes(result.stop_reason)
          )
            throw protocol("invalid_finish");
          if (
            (result.stop_reason === "tool_use") !== calls.length > 0 ||
            (!text && !calls.length)
          )
            throw protocol("invalid_finish");
          if (new Set(calls.map((call) => call.id)).size !== calls.length)
            throw protocol("invalid_tool_call");
          const parsedUsage = anthropicUsageSchema.safeParse(result.usage);
          if (!parsedUsage.success) throw invalid("usage", "invalid_chunk");
          const usage = parsedUsage.data;
          const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
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
            usage: {
              promptTokens: input,
              completionTokens: usage.output_tokens,
              totalTokens: input + usage.output_tokens,
              ...(usage.cache_read_input_tokens != null
                ? { cachedPromptTokens: usage.cache_read_input_tokens }
                : {}),
            },
          });
          if (!parsedResponse.success) throw invalid("result", "invalid_response");
          return parsedResponse.data;
        },
      );
    },
  }, settings);
}
