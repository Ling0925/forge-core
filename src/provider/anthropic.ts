import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { ModelProvider } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
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
import { withSdkRequest } from "./sdk-transport";

const contentSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string().max(2000000) }),
      z.object({
        type: z.literal("thinking"),
        thinking: z.string().max(2000000),
        signature: z.string().min(1),
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
      state.model === model
    ) {
      const content = contentSchema.parse(state.output);
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
          input: jsonObjectSchema.parse(JSON.parse(call.function.arguments)),
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
  const clientFor = (fetch: typeof globalThis.fetch) =>
    new Anthropic({
      apiKey: settings.apiKey,
      authToken: null,
      baseURL: baseUrl,
      maxRetries: 0,
      timeout: settings.requestTimeoutMs,
      fetch,
      logLevel: "off",
      defaultHeaders: { "x-api-key": settings.apiKey || null },
    });
  return {
    listModels: (signal) =>
      withSdkRequest(
        settings,
        { signal, idle: false },
        async ({ signal, fetch }) => {
          const ids = new Set<string>();
          for await (const model of clientFor(fetch).models.list(
            { limit: 100 },
            { signal },
          )) {
            ids.add(settingsFields.model.parse(model.id));
            if (ids.size > 10000) throw protocol("output_limit");
          }
          return [...ids].sort();
        },
      ),
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
        { signal: options.signal, idle: true },
        async ({ signal, fetch }) => {
          const maxTokens = settings.maxOutputTokens ?? 8192;
          const effort = settings.reasoningEffort ?? "default";
          const budget = {
            minimal: 1024,
            low: 1024,
            medium: 4096,
            high: 8192,
            xhigh: 16384,
          };
          if (effort !== "default" && effort !== "none" && maxTokens <= 1024)
            throw new ForgeError(
              "invalid_input",
              "Anthropic thinking requires maxOutputTokens greater than 1024.",
            );
          const stream = clientFor(fetch).messages.stream(
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
              ...(effort === "none"
                ? { thinking: { type: "disabled" } }
                : effort !== "default"
                  ? {
                      thinking: {
                        type: "enabled",
                        budget_tokens: Math.min(budget[effort], maxTokens - 1),
                      },
                    }
                  : {}),
            },
            { signal },
          );
          let observerFailure: ProviderError | undefined;
          const argumentsByIndex = new Map<number, string>();
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
            if (
              event.type !== "content_block_start" &&
              event.type !== "content_block_delta"
            )
              return;
            const block = snapshot.content[event.index];
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
            throw observerFailure ?? error;
          }
          if (observerFailure) throw observerFailure;
          if (stream.receivedMessages.length !== 1)
            throw protocol("unexpected_frame");
          const content = contentSchema.parse(result.content);
          for (const [index, argumentsText] of argumentsByIndex) {
            const block = content[index];
            const input = jsonObjectSchema.parse(JSON.parse(argumentsText));
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
          const input =
            result.usage.input_tokens +
            (result.usage.cache_creation_input_tokens ?? 0) +
            (result.usage.cache_read_input_tokens ?? 0);
          return providerResponseSchema.parse({
            message: {
              role: "assistant",
              content: text || null,
              ...(reasoning ? { reasoning } : {}),
              ...(calls.length ? { tool_calls: calls } : {}),
              ...(content.some(
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
                      output: content,
                    },
                  }
                : {}),
            },
            usage: {
              promptTokens: input,
              completionTokens: result.usage.output_tokens,
              totalTokens: input + result.usage.output_tokens,
              ...(result.usage.cache_read_input_tokens != null
                ? { cachedPromptTokens: result.usage.cache_read_input_tokens }
                : {}),
            },
          });
        },
      );
    },
  };
}
