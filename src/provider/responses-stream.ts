import { isDeepStrictEqual } from "node:util";
import type { ServerSentEvent } from "openai/core/streaming";
import { z } from "zod";
import { providerResponseSchema, toolCallSchema } from "../shared/schemas";
import type { ProviderResponse, ToolCallPreview } from "../shared/schemas";
import type {
  WebCitation,
  WebSearchMode,
  WebSearchProgress,
} from "../shared/web-search";
import { responseFailure } from "./responses-errors";
import {
  type Helpers,
  type MessagePart,
  id,
  matchesPart,
  message,
  outputItem,
  prose,
  sameAdded,
  sameItem,
  stateEvents,
  terminal,
  validatedOutput,
} from "./responses-events";
import {
  citationRecord,
  searchRecord,
  urlCitation,
} from "./responses-web-search";

export function createResponsesStream({
  h,
  baseUrl,
  observer,
  model,
  onReasoning,
  onToolCall,
  webSearch,
  onWebSearch,
}: {
  h: Helpers;
  baseUrl: string;
  observer: (text: string) => void;
  model: string;
  onReasoning: (text: string) => void;
  onToolCall: (preview: ToolCallPreview) => void;
  webSearch: WebSearchMode;
  onWebSearch: (search: WebSearchProgress) => void;
}) {
  let text = "";
  let completed: z.infer<typeof terminal> | undefined;
  let responseId: string | undefined;
  let completedOutput: z.infer<typeof outputItem>[] | undefined;
  let transportDone = false;
  const argumentDone = new Set<string>();
  const argumentDeltas = new Set<string>();
  const textDone = new Map<string, string>();
  const args = new Map<string, string>();
  const finishArguments = (itemId: string, value: string) => {
    const previous = args.get(itemId);
    // A final snapshot can supply arguments when no deltas were sent. Once
    // deltas (or another final snapshot) exist, require an exact match: never
    // repair truncated JSON or replace streamed arguments before execution.
    if (
      previous === undefined ||
      (argumentDeltas.has(itemId) || argumentDone.has(itemId)
        ? previous !== value
        : !value.startsWith(previous))
    )
      throw h.protocol("invalid_tool_call");
    args.set(itemId, value);
  };
  const items = new Map<number, { id: string; type: string }>();
  const ended = new Map<number, z.infer<typeof outputItem>>();
  const added = new Map<number, unknown>();
  const textParts = new Map<string, string>();
  const textKinds = new Map<string, "output_text" | "refusal">();
  const contentAdded = new Map<string, MessagePart>();
  const contentDone = new Map<string, MessagePart>();
  const reasoningParts = new Map<string, string>();
  const reasoningDone = new Set<string>();
  const annotations = new Map<string, z.infer<typeof urlCitation>>();
  const searchStatuses = new Map<string, WebSearchProgress["status"]>();
  const notifySearch = (id: string, status: WebSearchProgress["status"]) => {
    const previous = searchStatuses.get(id);
    if (previous === status) return;
    if (previous && ["completed", "failed", "incomplete"].includes(previous))
      throw h.protocol();
    if (previous === "searching" && status === "in_progress")
      throw h.protocol();
    searchStatuses.set(id, status);
    // Isolate callback failures using the same observer boundary as text.
    h.notify(() => onWebSearch({ id, status }), "web_search");
  };
  let reasoning = "";
  // Preview indices follow final tool order, not arrival order or output_index
  // (which also counts non-tools). Only number the contiguous known prefix:
  // a missing earlier item may turn out to be another tool in the snapshot.
  const callIndex = new Map<string, number>();
  const names = new Map<string, string>();
  let callCount = 0;
  let nextPreviewOutputIndex = 0;
  const notifyToolPreview = (outputIndex: number): void => {
    const item = items.get(outputIndex);
    if (!item || item.type !== "function_call") return;
    const index = callIndex.get(item.id);
    // Only the first 256 tool calls can be addressed by the preview index.
    if (index === undefined) return;
    const argumentsText = args.get(item.id) ?? "";
    h.notifyToolCall(
      onToolCall,
      index,
      names.get(item.id) ?? "",
      argumentsText.length,
      argumentsText,
    );
  };
  const dispatch = (payload: unknown, eventName: string | null) => {
    // `message` is SSE's default event type, not a conflicting native type.
    const nativeEvent = eventName === "message" ? null : eventName;
    const parsed = z
      .object({ type: z.string().optional() })
      .passthrough()
      .parse(payload);
    const e = { ...parsed, type: parsed.type ?? nativeEvent };
    if (!e.type || (nativeEvent && nativeEvent !== e.type)) throw h.protocol();
    if (e.type === "response.metadata") {
      const p = z
        .object({ response_id: id, metadata: z.record(z.unknown()) })
        .parse(e);
      if (responseId !== undefined && responseId !== p.response_id)
        throw h.protocol();
      responseId = p.response_id;
      return;
    }
    if (!stateEvents.has(e.type)) return;
    if (transportDone || completed) throw h.protocol();
    if (["error", "response.failed", "response.incomplete"].includes(e.type))
      throw responseFailure(e);
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
              content: message.shape.content.optional(),
            })
            .parse(p.item),
        );
      else if (p.item.type === "reasoning")
        added.set(
          p.output_index,
          z.object({ type: z.literal("reasoning"), id }).parse(p.item),
        );
      else if (p.item.type === "web_search_call") {
        if (webSearch === "disabled") throw h.protocol();
        const initial = z
          .object({
            id,
            type: z.literal("web_search_call"),
            status: z.enum([
              "in_progress",
              "searching",
              "completed",
              "failed",
              "incomplete",
            ]),
          })
          .parse(p.item);
        if (searchStatuses.size >= 128) throw h.protocol("output_limit");
        added.set(p.output_index, initial);
        notifySearch(initial.id, initial.status);
      } else throw h.protocol();
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
      }
      // An added item of any type can close a gap and release later previews,
      // including tools whose done frames arrived while their index was unknown.
      for (;;) {
        const item = items.get(nextPreviewOutputIndex);
        if (!item) break;
        if (item.type === "function_call") {
          if (callCount < 256) callIndex.set(item.id, callCount);
          callCount += 1;
          notifyToolPreview(nextPreviewOutputIndex);
        }
        nextPreviewOutputIndex += 1;
      }
    } else if (
      e.type === "response.output_text.delta" ||
      e.type === "response.refusal.delta" ||
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
      if (e.type !== "response.function_call_arguments.delta") {
        if (item.type !== "message") throw h.protocol();
        if (p.content_index === undefined) throw h.protocol();
        const partKey = `${p.output_index}:${p.content_index}`;
        const kind =
          e.type === "response.refusal.delta" ? "refusal" : "output_text";
        if (textKinds.has(partKey) && textKinds.get(partKey) !== kind)
          throw h.protocol();
        textKinds.set(partKey, kind);
        if (textDone.has(partKey) || contentDone.has(partKey))
          throw h.protocol();
        textParts.set(partKey, (textParts.get(partKey) ?? "") + p.delta);
        text += p.delta;
        if (text.length > 2_000_000)
          throw h.protocol("output_limit", {
            stage: "output_text",
            observed: text.length,
            limit: 2_000_000,
            unit: "utf16_code_units",
          });
        for (let i = 0; i < p.delta.length; i += 65536)
          h.notify(observer, p.delta.slice(i, i + 65536));
      } else {
        if (item.type !== "function_call" || argumentDone.has(item.id))
          throw h.protocol();
        const next = (args.get(item.id) ?? "") + p.delta;
        if (next.length > 1_000_000)
          throw h.protocol("output_limit", {
            stage: "tool_arguments",
            observed: next.length,
            limit: 1_000_000,
            unit: "utf16_code_units",
          });
        args.set(item.id, next);
        if (p.delta) argumentDeltas.add(item.id);
        notifyToolPreview(p.output_index);
      }
    } else if (
      e.type === "response.content_part.added" ||
      e.type === "response.content_part.done"
    ) {
      const p = z
        .object({
          output_index: z.number().int().min(0).max(511),
          item_id: id,
          content_index: z.number().int().min(0).max(255),
          part: message.shape.content.element,
        })
        .parse(e);
      const item = items.get(p.output_index);
      const key = `${p.output_index}:${p.content_index}`;
      const parts =
        e.type === "response.content_part.done" ? contentDone : contentAdded;
      if (
        item?.id !== p.item_id ||
        item.type !== "message" ||
        ended.has(p.output_index) ||
        parts.has(key) ||
        (parts === contentAdded && contentDone.has(key))
      )
        throw h.protocol();
      parts.set(key, p.part);
    } else if (
      [
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
        "response.web_search_call.completed",
      ].includes(e.type)
    ) {
      const p = z
        .object({
          item_id: id,
          output_index: z.number().int().min(0).max(511),
        })
        .parse(e);
      const item = items.get(p.output_index);
      if (
        webSearch === "disabled" ||
        item?.type !== "web_search_call" ||
        item.id !== p.item_id ||
        ended.has(p.output_index)
      )
        throw h.protocol();
      notifySearch(
        item.id,
        e.type === "response.web_search_call.in_progress"
          ? "in_progress"
          : e.type === "response.web_search_call.searching"
            ? "searching"
            : "completed",
      );
    } else if (e.type === "response.output_text.annotation.added") {
      const p = z
        .object({
          item_id: id,
          output_index: z.number().int().min(0).max(511),
          content_index: z.number().int().min(0).max(255),
          annotation_index: z.number().int().min(0).max(255),
          annotation: urlCitation,
        })
        .parse(e);
      const item = items.get(p.output_index);
      const key = `${p.output_index}:${p.content_index}:${p.annotation_index}`;
      if (
        item?.type !== "message" ||
        item.id !== p.item_id ||
        ended.has(p.output_index) ||
        annotations.has(key)
      )
        throw h.protocol();
      if (annotations.size >= 256) throw h.protocol("output_limit");
      annotations.set(key, p.annotation);
    } else if (e.type === "response.function_call_arguments.done") {
      const p = z
        .object({
          item_id: id,
          arguments: z.string().max(1_000_000),
          output_index: z.number().int().optional(),
        })
        .parse(e);
      if (
        argumentDone.has(p.item_id) ||
        (p.output_index !== undefined &&
          items.get(p.output_index)?.id !== p.item_id) ||
        [...ended.values()].some((item) => item.id === p.item_id)
      )
        throw h.protocol();
      finishArguments(p.item_id, p.arguments);
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
      if (p.item.type === "function_call") {
        if (!sameAdded(added.get(p.output_index), p.item)) throw h.protocol();
        finishArguments(p.item.id, p.item.arguments);
      }
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
      if (p.item.type === "web_search_call") {
        if (
          webSearch === "disabled" ||
          !sameAdded(added.get(p.output_index), p.item)
        )
          throw h.protocol();
        notifySearch(p.item.id, p.item.status);
      }
      ended.set(p.output_index, p.item);
      if (p.item.type === "function_call") {
        // Terminal item completes a name the added frame may have omitted.
        names.set(p.item.id, p.item.name);
        notifyToolPreview(p.output_index);
      }
    } else if (
      e.type === "response.output_text.done" ||
      e.type === "response.refusal.done"
    ) {
      const p = z
        .object({
          output_index: z.number().int(),
          item_id: id,
          content_index: z.number().int().min(0).max(255),
          text: z.string().optional(),
          refusal: z.string().optional(),
        })
        .parse(e);
      const key = `${p.output_index}:${p.content_index}`;
      const value = e.type === "response.refusal.done" ? p.refusal : p.text;
      if (
        items.get(p.output_index)?.id !== p.item_id ||
        items.get(p.output_index)?.type !== "message" ||
        ended.has(p.output_index) ||
        textDone.has(key) ||
        value === undefined ||
        (textParts.has(key) && textParts.get(key) !== value) ||
        (textKinds.has(key) &&
          textKinds.get(key) !==
            (e.type === "response.refusal.done" ? "refusal" : "output_text"))
      )
        throw h.protocol();
      textKinds.set(
        key,
        e.type === "response.refusal.done" ? "refusal" : "output_text",
      );
      textDone.set(key, value);
    } else if (e.type === "response.completed") {
      const p = z.object({ response: terminal }).parse(e);
      if (responseId !== undefined && responseId !== p.response.id)
        throw h.protocol();
      // A full completed snapshot is authoritative when a relay coalesces
      // redundant lifecycle events. It must still agree with every identity,
      // delta and finished item that actually arrived. An empty snapshot has
      // no such evidence, so keep requiring all explicit completion frames.
      const output = p.response.output.length
        ? p.response.output
        : Array.from({ length: ended.size }, (_, index) => {
            const entry = ended.get(index);
            if (!entry) throw h.protocol();
            return entry;
          });
      if (!p.response.output.length) {
        if (ended.size !== items.size) throw h.protocol();
        for (const [index, entry] of output.entries()) {
          if (entry.type === "function_call" && !argumentDone.has(entry.id))
            throw h.protocol();
          if (entry.type === "message")
            for (const [part] of entry.content.entries())
              if (!textDone.has(`${index}:${part}`)) throw h.protocol();
        }
      }
      for (const [index, observed] of items) {
        const entry = output[index];
        if (
          !entry ||
          observed.id !== entry.id ||
          observed.type !== entry.type ||
          !sameAdded(added.get(index), entry) ||
          (ended.has(index) && !sameItem(ended.get(index), entry))
        )
          throw h.protocol();
        if (entry.type === "function_call")
          finishArguments(entry.id, entry.arguments);
      }
      completedOutput = output;
      completed = p.response;
      responseId = p.response.id;
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
    } else if (
      e.type === "response.reasoning_text.delta" ||
      e.type === "response.reasoning_text.done"
    ) {
      const p = z
        .object({
          item_id: id,
          output_index: z.number().int(),
          content_index: z.number().int(),
          delta: z.string().optional(),
          text: z.string().optional(),
        })
        .parse(e);
      const item = items.get(p.output_index);
      const key = `${p.output_index}:${p.content_index}`;
      if (
        item?.id !== p.item_id ||
        item.type !== "reasoning" ||
        ended.has(p.output_index) ||
        reasoningDone.has(key)
      )
        throw h.protocol();
      if (e.type === "response.reasoning_text.done") {
        if (p.text === undefined || (reasoningParts.get(key) ?? "") !== p.text)
          throw h.protocol();
        reasoningDone.add(key);
      } else {
        if (p.delta === undefined) throw h.protocol();
        reasoningParts.set(key, (reasoningParts.get(key) ?? "") + p.delta);
        reasoning += p.delta.slice(0, Math.max(0, 131072 - reasoning.length));
        for (let start = 0; start < p.delta.length; start += 65536)
          h.notify(onReasoning, p.delta.slice(start, start + 65536));
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
    }
  };
  const accept = (event: ServerSentEvent) => {
    if (event.data === "[DONE]") {
      if (
        !completed ||
        transportDone ||
        (event.event && event.event !== "message")
      )
        throw h.protocol();
      transportDone = true;
    } else dispatch(h.parseJson(event.data, "sse_event"), event.event);
  };
  const finish = (): ProviderResponse => {
    if (!completed || !completedOutput) throw h.protocol("missing_completion");
    const output = validatedOutput(completedOutput, h);
    for (let index = 0; index < output.length; index++) {
      const entry = output[index];
      if (entry?.type !== "message") continue;
      for (let part = 0; part < entry.content.length; part++) {
        const value = entry.content[part];
        const key = `${index}:${part}`;
        if (
          !value ||
          (textParts.has(key) && textParts.get(key) !== prose(value)) ||
          (textDone.has(key) && textDone.get(key) !== prose(value)) ||
          (textKinds.has(key) && textKinds.get(key) !== value.type)
        )
          throw h.protocol();
      }
    }
    for (const [snapshots, exact] of [
      [contentAdded, false],
      [contentDone, true],
    ] as const) {
      for (const [key, part] of snapshots) {
        const [index, partIndex] = key.split(":").map(Number);
        const entry = output[index ?? -1];
        const final =
          entry?.type === "message"
            ? entry.content[partIndex ?? -1]
            : undefined;
        if (!matchesPart(part, final, exact)) throw h.protocol();
      }
    }
    for (const [key, value] of [...textParts, ...textDone]) {
      const [index, part] = key.split(":").map(Number);
      const entry = output[index ?? -1];
      const content =
        entry?.type === "message" ? entry.content[part ?? -1] : undefined;
      if (!content || prose(content) !== value) throw h.protocol();
    }
    for (const [key, value] of reasoningParts) {
      const [index, part] = key.split(":").map(Number);
      const entry = output[index ?? -1];
      if (
        entry?.type !== "reasoning" ||
        entry.content?.[part ?? -1]?.text !== value
      )
        throw h.protocol();
    }
    for (const [key, annotation] of annotations) {
      const [index, part, annotationIndex] = key.split(":").map(Number);
      const entry = output[index ?? -1];
      const content =
        entry?.type === "message" ? entry.content[part ?? -1] : undefined;
      if (
        content?.type !== "output_text" ||
        !isDeepStrictEqual(
          content.annotations?.[annotationIndex ?? -1],
          annotation,
        )
      )
        throw h.protocol();
    }
    const citations: WebCitation[] = [];
    let textOffset = 0;
    for (const item of output) {
      if (item.type !== "message") continue;
      for (const part of item.content) {
        if (part.type === "output_text")
          for (const citation of part.annotations ?? [])
            citations.push(citationRecord(citation, textOffset));
        textOffset += prose(part).length;
      }
    }
    if (citations.length > 256) throw h.protocol("output_limit");
    const webSearches = output
      .filter((item) => item.type === "web_search_call")
      .map(searchRecord);
    if (
      webSearches.length > 128 ||
      (webSearches.length && webSearch === "disabled")
    )
      throw h.protocol();
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
      .flatMap((i) => i.content.map(prose))
      .join("");
    if (finalText.length > 2_000_000)
      throw h.protocol("output_limit", {
        stage: "output_text",
        observed: finalText.length,
        limit: 2_000_000,
        unit: "utf16_code_units",
      });
    if (!finalText.startsWith(text) || (!finalText && !calls.length))
      throw h.protocol();
    // Only emit text absent from the stream, after validating the complete
    // snapshot. Existing deltas must match whole parts above, not just prefixes.
    for (let start = text.length; start < finalText.length; start += 65536)
      h.notify(observer, finalText.slice(start, start + 65536));
    text = finalText;
    let toolIndex = 0;
    for (const [index, item] of output.entries()) {
      if (item.type === "web_search_call") notifySearch(item.id, item.status);
      if (item.type !== "function_call") continue;
      // A done frame may have been deferred behind a gap, so it does not prove
      // that this tool has already received a correctly indexed preview.
      if (!ended.has(index) || callIndex.get(item.id) !== toolIndex)
        h.notifyToolCall(
          onToolCall,
          toolIndex,
          item.name,
          item.arguments.length,
          item.arguments,
        );
      toolIndex += 1;
    }
    const u = completed.usage;
    const result = providerResponseSchema.parse({
      message: {
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning } : {}),
        ...(citations.length ? { citations } : {}),
        ...(webSearches.length ? { webSearches } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
        providerState: {
          version: 1,
          apiMode: "responses",
          baseUrl,
          model,
          ...(h.credentialId ? { credentialId: h.credentialId } : {}),
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
  };
  return { dispatch, accept, finish };
}
