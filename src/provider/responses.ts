import type { ServerSentEvent } from "openai/core/streaming";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
} from "openai/resources/responses/responses";
import { z } from "zod";
import type { ProtocolReason } from "../shared/errors";
import { providerResponseSchema, toolCallSchema } from "../shared/schemas";
import type {
  Message,
  ProviderResponse,
  ToolCallPreview,
  ToolDefinition,
} from "../shared/schemas";

const id = z.string().min(1).max(256);
const call = z
  .object({
    type: z.literal("function_call"),
    id,
    call_id: id,
    name: z.string(),
    arguments: z.string().max(1_000_000),
    status: z.literal("completed").optional(),
  })
  .passthrough();
const message = z
  .object({
    type: z.literal("message"),
    id,
    role: z.literal("assistant"),
    status: z.literal("completed"),
    content: z
      .array(
        z
          .object({
            type: z.literal("output_text"),
            text: z.string().max(2_000_000),
          })
          .passthrough(),
      )
      .max(256),
  })
  .passthrough();
const reasoning = z
  .object({
    type: z.literal("reasoning"),
    id,
    summary: z.array(z.unknown()).max(256),
    encrypted_content: z.string().max(1_000_000).optional(),
  })
  .passthrough();
const outputItem = z.union([call, message, reasoning]);
const terminal = z.object({
  id,
  status: z.literal("completed"),
  output: z.array(outputItem).max(512),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      input_tokens_details: z
        .object({ cached_tokens: z.number().int().nonnegative().optional() })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});
type Helpers = {
  protocol: (reason?: ProtocolReason) => Error;
  parseJson: (text: string) => unknown;
  events: (response: Response) => AsyncIterable<ServerSentEvent>;
  notify: (observer: (text: string) => void, text: string) => void;
  /** Display-only generation metadata; isolated like any other observer. */
  notifyToolCall: (
    observer: (preview: ToolCallPreview) => void,
    index: number,
    name: string,
    argumentsChars: number,
  ) => void;
};

function sameAdded(added: unknown, done: z.infer<typeof outputItem>): boolean {
  const a = z
    .object({
      id,
      type: z.string(),
      call_id: id.optional(),
      name: z.string().optional(),
      arguments: z.string().optional(),
      role: z.string().optional(),
    })
    .safeParse(added);
  if (!a.success || a.data.id !== done.id || a.data.type !== done.type)
    return false;
  if (done.type === "function_call")
    return (
      (a.data.call_id === undefined || a.data.call_id === done.call_id) &&
      (a.data.name === undefined || a.data.name === done.name) &&
      (a.data.arguments === undefined ||
        done.arguments.startsWith(a.data.arguments))
    );
  return (
    done.type !== "message" ||
    a.data.role === undefined ||
    a.data.role === done.role
  );
}
function sameItem(
  a: z.infer<typeof outputItem> | undefined,
  b: z.infer<typeof outputItem>,
): boolean {
  if (!a || a.id !== b.id || a.type !== b.type) return false;
  if (a.type === "function_call" && b.type === "function_call")
    return (
      a.call_id === b.call_id &&
      a.name === b.name &&
      a.arguments === b.arguments
    );
  if (a.type === "message" && b.type === "message")
    return (
      a.role === b.role &&
      JSON.stringify(a.content) === JSON.stringify(b.content)
    );
  return (
    a.type === "reasoning" &&
    b.type === "reasoning" &&
    JSON.stringify(a) === JSON.stringify(b)
  );
}

// Continuation lives on the exact assistant message, not in provider-instance memory.
// Validate both externally supplied session state and the wire output before replay.
const MAX_STATE_BYTES = 250_000;
function validatedOutput(
  output: unknown,
  h: Helpers,
): z.infer<typeof outputItem>[] {
  const parsed = z.array(outputItem).max(256).parse(output);
  if (
    new TextEncoder().encode(JSON.stringify(parsed)).byteLength >
    MAX_STATE_BYTES
  )
    throw h.protocol();
  const ids = new Set<string>();
  const calls = new Set<string>();
  for (const item of parsed) {
    if (ids.has(item.id)) throw h.protocol();
    ids.add(item.id);
    if (item.type === "function_call") {
      if (
        calls.has(item.call_id) ||
        !toolCallSchema.safeParse({
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        }).success
      )
        throw h.protocol();
      calls.add(item.call_id);
      const value = h.parseJson(item.arguments);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw h.protocol();
    }
  }
  return parsed;
}
export function createResponsesAdapter(h: Helpers, baseUrl: string) {
  function input(messages: readonly Message[], model: string): unknown[] {
    const result: unknown[] = [];
    const pending = new Set<string>();
    const used = new Set<string>();
    for (const m of messages) {
      if (m.role === "tool") {
        if (!pending.delete(m.tool_call_id)) throw h.protocol();
        result.push({
          type: "function_call_output",
          call_id: m.tool_call_id,
          output: m.content,
        });
        continue;
      }
      if (pending.size) throw h.protocol();
      if (m.role === "assistant") {
        const state = m.providerState;
        const sameOrigin =
          state?.apiMode === "responses" &&
          state.baseUrl === baseUrl &&
          state.model === model;
        if (sameOrigin && state) {
          const original = validatedOutput(state.output, h);
          const nativeCalls = original.filter(
            (item) => item.type === "function_call",
          );
          if (
            m.content !==
              (original
                .filter((item) => item.type === "message")
                .flatMap((item) => item.content.map((part) => part.text))
                .join("") || null) ||
            JSON.stringify(
              nativeCalls.map((item) => ({
                id: item.call_id,
                type: "function",
                function: { name: item.name, arguments: item.arguments },
              })),
            ) !== JSON.stringify(m.tool_calls ?? [])
          )
            throw h.protocol();
          result.push(...original);
        } else {
          if (m.content) result.push({ role: "assistant", content: m.content });
          for (const c of m.tool_calls ?? [])
            result.push({
              type: "function_call",
              call_id: c.id,
              name: c.function.name,
              arguments: c.function.arguments,
            });
        }
        for (const c of m.tool_calls ?? []) {
          if (used.has(c.id)) throw h.protocol();
          used.add(c.id);
          pending.add(c.id);
        }
      } else
        result.push({
          role: m.role,
          content:
            m.role === "user" && m.images?.length
              ? [
                  ...(m.content
                    ? [{ type: "input_text", text: m.content }]
                    : []),
                  ...m.images.map((image) => ({
                    type: "input_image",
                    image_url: image.dataUrl,
                    detail: "auto",
                  })),
                ]
              : m.content,
        });
    }
    if (pending.size) throw h.protocol();
    return result;
  }
  return {
    body(
      messages: readonly Message[],
      tools: readonly ToolDefinition[],
      model: string,
    ): ResponseCreateParamsStreaming {
      return {
        model,
        input: input(messages, model) as ResponseInput,
        tools: tools.map((t) => ({
          type: "function",
          ...t.function,
          strict: false,
        })),
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      };
    },
    async read(
      response: Response,
      observer: (text: string) => void,
      model: string,
      onReasoning: (text: string) => void = () => {},
      onToolCall: (preview: ToolCallPreview) => void = () => {},
    ): Promise<ProviderResponse> {
      let text = "";
      let completed: z.infer<typeof terminal> | undefined;
      let responseId: string | undefined;
      let completedOutput: z.infer<typeof outputItem>[] | undefined;
      let transportDone = false;
      const argumentDone = new Set<string>();
      const textDone = new Map<string, string>();
      const args = new Map<string, string>();
      const items = new Map<number, { id: string; type: string }>();
      const ended = new Map<number, z.infer<typeof outputItem>>();
      const added = new Map<number, unknown>();
      const textParts = new Map<string, string>();
      let reasoning = "";
      // Preview bookkeeping: a tool-sequence index (never output_index, which
      // also counts reasoning/message items) and the latest accumulated name.
      const callIndex = new Map<string, number>();
      const names = new Map<string, string>();
      let callCount = 0;
      const notifyToolPreview = (outputIndex: number): void => {
        const item = items.get(outputIndex);
        if (!item || item.type !== "function_call") return;
        const index = callIndex.get(item.id);
        // Only the first 256 tool calls can be addressed by the preview index.
        if (index === undefined) return;
        h.notifyToolCall(
          onToolCall,
          index,
          names.get(item.id) ?? "",
          (args.get(item.id) ?? "").length,
        );
      };
      const dispatch = (payload: string, eventName: string | null) => {
        if (payload === "[DONE]") {
          if (!completed || transportDone || eventName) throw h.protocol();
          transportDone = true;
          return;
        }
        if (transportDone || completed) throw h.protocol();
        const e = z
          .object({ type: z.string() })
          .passthrough()
          .parse(h.parseJson(payload));
        if (completed || (eventName && eventName !== e.type))
          throw h.protocol();
        if (
          ["error", "response.failed", "response.incomplete"].includes(e.type)
        )
          throw h.protocol();
        if (e.type === "response.output_item.added") {
          const p = z
            .object({
              output_index: z.number().int().min(0).max(511),
              item: z.object({ id, type: z.string() }).passthrough(),
            })
            .parse(e);
          if (
            items.has(p.output_index) ||
            [...items.values()].some((previous) => previous.id === p.item.id)
          )
            throw h.protocol();
          if (p.item.type === "function_call")
            added.set(
              p.output_index,
              z
                .object({
                  type: z.literal("function_call"),
                  id,
                  call_id: id.optional(),
                  name: z.string().optional(),
                  arguments: z.string().optional(),
                })
                .parse(p.item),
            );
          else if (p.item.type === "message")
            added.set(
              p.output_index,
              z
                .object({
                  type: z.literal("message"),
                  id,
                  role: z.literal("assistant").optional(),
                })
                .parse(p.item),
            );
          else if (p.item.type === "reasoning")
            added.set(
              p.output_index,
              z.object({ type: z.literal("reasoning"), id }).parse(p.item),
            );
          else throw h.protocol();
          items.set(p.output_index, p.item);
          if (p.item.type === "function_call") {
            const initial = z
              .object({
                name: z.string().optional(),
                arguments: z.string().max(1_000_000).optional(),
              })
              .parse(p.item);
            args.set(p.item.id, initial.arguments ?? "");
            // Added frames may omit the name; the terminal item fills it in.
            names.set(p.item.id, initial.name ?? "");
            if (callCount < 256) callIndex.set(p.item.id, callCount);
            callCount += 1;
            notifyToolPreview(p.output_index);
          }
        } else if (
          e.type === "response.output_text.delta" ||
          e.type === "response.function_call_arguments.delta"
        ) {
          const p = z
            .object({
              output_index: z.number().int(),
              item_id: id,
              delta: z.string().max(1_000_000),
              content_index: z.number().int().min(0).max(255).optional(),
            })
            .parse(e);
          const item = items.get(p.output_index);
          if (!item || item.id !== p.item_id || ended.has(p.output_index))
            throw h.protocol();
          if (e.type === "response.output_text.delta") {
            if (item.type !== "message") throw h.protocol();
            if (p.content_index === undefined) throw h.protocol();
            const partKey = `${p.output_index}:${p.content_index}`;
            if (textDone.has(partKey)) throw h.protocol();
            textParts.set(partKey, (textParts.get(partKey) ?? "") + p.delta);
            text += p.delta;
            if (text.length > 2_000_000) throw h.protocol();
            for (let i = 0; i < p.delta.length; i += 65536)
              h.notify(observer, p.delta.slice(i, i + 65536));
          } else {
            if (item.type !== "function_call" || argumentDone.has(item.id))
              throw h.protocol();
            const next = (args.get(item.id) ?? "") + p.delta;
            if (next.length > 1_000_000) throw h.protocol();
            args.set(item.id, next);
            notifyToolPreview(p.output_index);
          }
        } else if (e.type === "response.function_call_arguments.done") {
          const p = z
            .object({
              item_id: id,
              arguments: z.string(),
              output_index: z.number().int().optional(),
            })
            .parse(e);
          if (
            args.get(p.item_id) !== p.arguments ||
            argumentDone.has(p.item_id) ||
            (p.output_index !== undefined &&
              items.get(p.output_index)?.id !== p.item_id) ||
            [...ended.values()].some((item) => item.id === p.item_id)
          )
            throw h.protocol();
          argumentDone.add(p.item_id);
        } else if (e.type === "response.output_item.done") {
          const p = z
            .object({ output_index: z.number().int(), item: outputItem })
            .parse(e);
          if (
            items.get(p.output_index)?.id !== p.item.id ||
            items.get(p.output_index)?.type !== p.item.type ||
            ended.has(p.output_index)
          )
            throw h.protocol();
          if (
            p.item.type === "function_call" &&
            (args.get(p.item.id) !== p.item.arguments ||
              !sameAdded(added.get(p.output_index), p.item))
          )
            throw h.protocol();
          if (
            p.item.type === "message" &&
            !sameAdded(added.get(p.output_index), p.item)
          )
            throw h.protocol();
          if (
            p.item.type === "reasoning" &&
            !sameAdded(added.get(p.output_index), p.item)
          )
            throw h.protocol();
          ended.set(p.output_index, p.item);
          if (p.item.type === "function_call") {
            // Terminal item completes a name the added frame may have omitted.
            names.set(p.item.id, p.item.name);
            notifyToolPreview(p.output_index);
          }
        } else if (e.type === "response.output_text.done") {
          const p = z
            .object({
              output_index: z.number().int(),
              item_id: id,
              content_index: z.number().int().min(0).max(255),
              text: z.string(),
            })
            .parse(e);
          const key = `${p.output_index}:${p.content_index}`;
          if (
            items.get(p.output_index)?.id !== p.item_id ||
            items.get(p.output_index)?.type !== "message" ||
            ended.has(p.output_index) ||
            textDone.has(key) ||
            textParts.get(key) !== p.text
          )
            throw h.protocol();
          textDone.set(key, p.text);
        } else if (e.type === "response.completed") {
          const p = z.object({ response: terminal }).parse(e);
          if (responseId !== undefined && responseId !== p.response.id)
            throw h.protocol();
          if (ended.size !== items.size) throw h.protocol();
          const output = p.response.output.length
            ? p.response.output
            : Array.from({ length: ended.size }, (_, index) => {
                const entry = ended.get(index);
                if (!entry) throw h.protocol();
                return entry;
              });
          if (items.size !== output.length) throw h.protocol();
          if (!p.response.output.length) {
            for (const [index, entry] of output.entries()) {
              if (entry.type === "function_call" && !argumentDone.has(entry.id))
                throw h.protocol();
              if (entry.type === "message")
                for (const [part] of entry.content.entries())
                  if (!textDone.has(`${index}:${part}`)) throw h.protocol();
            }
          }
          output.forEach((entry, index) => {
            if (
              items.get(index)?.id !== entry.id ||
              !sameItem(ended.get(index), entry)
            )
              throw h.protocol();
          });
          completedOutput = output;
          completed = p.response;
        } else if (
          e.type === "response.created" ||
          e.type === "response.in_progress"
        ) {
          const p = z
            .object({ response: z.object({ id: id.optional() }) })
            .parse(e);
          if (p.response.id !== undefined) {
            if (responseId !== undefined && responseId !== p.response.id)
              throw h.protocol();
            responseId = p.response.id;
          }
        } else if (e.type === "response.reasoning_summary_text.delta") {
          // Opaque reasoning is replayed via providerState; this summary text is a
          // bounded display preview persisted on the assistant message.
          const p = z
            .object({
              item_id: id,
              delta: z.string().max(1_000_000),
            })
            .passthrough()
            .parse(e);
          if (reasoning.length < 131072)
            reasoning += p.delta.slice(0, 131072 - reasoning.length);
          for (let start = 0; start < p.delta.length; start += 65536)
            h.notify(onReasoning, p.delta.slice(start, start + 65536));
        } else if (
          ![
            "response.content_part.added",
            "response.content_part.done",
            "response.reasoning_summary_part.added",
            "response.reasoning_summary_part.done",
            "response.reasoning_summary_text.done",
          ].includes(e.type)
        )
          throw h.protocol();
      };
      for await (const event of h.events(response))
        dispatch(event.data, event.event);
      if (!completed || !completedOutput)
        throw h.protocol("missing_completion");
      const output = validatedOutput(completedOutput, h);
      for (let index = 0; index < output.length; index++) {
        const entry = output[index];
        if (entry?.type !== "message") continue;
        for (let part = 0; part < entry.content.length; part++) {
          if (textParts.get(`${index}:${part}`) !== entry.content[part]?.text)
            throw h.protocol();
        }
      }
      for (const key of textParts.keys()) {
        const [index, part] = key.split(":").map(Number);
        const entry = output[index ?? -1];
        if (
          entry?.type !== "message" ||
          entry.content[part ?? -1]?.text !== textParts.get(key)
        )
          throw h.protocol();
      }
      const calls = output
        .filter((i) => i.type === "function_call")
        .map((i) =>
          toolCallSchema.parse({
            id: i.call_id,
            type: "function",
            function: { name: i.name, arguments: i.arguments },
          }),
        );
      const finalText = output
        .filter((i) => i.type === "message")
        .flatMap((i) => i.content.map((c) => c.text))
        .join("");
      if (text !== finalText || (!text && !calls.length)) throw h.protocol();
      const u = completed.usage;
      const result = providerResponseSchema.parse({
        message: {
          role: "assistant",
          content: text || null,
          ...(reasoning ? { reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
          providerState: {
            version: 1,
            apiMode: "responses",
            baseUrl,
            model,
            output,
          },
        },
        ...(u
          ? {
              usage: {
                promptTokens: u.input_tokens,
                completionTokens: u.output_tokens,
                totalTokens: u.total_tokens,
                ...(u.input_tokens_details?.cached_tokens === undefined
                  ? {}
                  : {
                      cachedPromptTokens: u.input_tokens_details.cached_tokens,
                    }),
              },
            }
          : {}),
      });
      return result;
    },
  };
}
