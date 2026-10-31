import { isDeepStrictEqual } from "node:util";
import type { ServerSentEvent } from "openai/core/streaming";
import { z } from "zod";
import type { ProtocolReason } from "../shared/errors";
import { toolCallSchema } from "../shared/schemas";
import type { ToolCallPreview } from "../shared/schemas";
import type { ProviderDiagnostic, ProviderStage } from "./errors";
import { urlCitation, webSearchCall } from "./responses-web-search";

export const id = z.string().min(1).max(256);
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
export const message = z
  .object({
    type: z.literal("message"),
    id,
    role: z.literal("assistant"),
    status: z.literal("completed"),
    content: z
      .array(
        z.union([
          z
            .object({
              type: z.literal("output_text"),
              text: z.string().max(2_000_000),
              annotations: z.array(urlCitation).max(256).optional(),
            })
            .passthrough(),
          z
            .object({
              type: z.literal("refusal"),
              refusal: z.string().max(2_000_000),
            })
            .passthrough(),
        ]),
      )
      .max(256),
  })
  .passthrough();
const reasoning = z
  .object({
    type: z.literal("reasoning"),
    id,
    summary: z.array(z.unknown()).max(256),
    encrypted_content: z.string().max(1_000_000).nullable().optional(),
    content: z
      .array(
        z
          .object({ type: z.literal("reasoning_text"), text: z.string() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export const outputItem = z.union([call, message, reasoning, webSearchCall]);
export const prose = (
  part: z.infer<typeof message>["content"][number],
): string => (part.type === "output_text" ? part.text : part.refusal);
export const stateEvents = new Set([
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.refusal.delta",
  "response.refusal.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.web_search_call.in_progress",
  "response.web_search_call.searching",
  "response.web_search_call.completed",
  "response.output_text.annotation.added",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
]);
export const terminal = z.object({
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
export type Helpers = {
  protocol: (reason?: ProtocolReason, detail?: ProviderDiagnostic) => Error;
  parseJson: (text: string, stage?: ProviderStage) => unknown;
  events: (response: Response) => AsyncIterable<ServerSentEvent>;
  /** Opaque credential identity; replaying state across accounts is unsafe. */
  credentialId?: string | undefined;
  notify: (observer: (text: string) => void, text: string) => void;
  /** Display-only generation metadata; isolated like any other observer. */
  notifyToolCall: (
    observer: (preview: ToolCallPreview) => void,
    index: number,
    name: string,
    argumentsChars: number,
    argumentsText?: string,
  ) => void;
};

export type MessagePart = z.infer<typeof message>["content"][number];
export function matchesPart(
  initial: MessagePart,
  final: MessagePart | undefined,
  exact: boolean,
): boolean {
  if (!final || initial.type !== final.type) return false;
  if (
    exact
      ? prose(initial) !== prose(final)
      : !prose(final).startsWith(prose(initial))
  )
    return false;
  if (
    initial.type === "output_text" &&
    final.type === "output_text" &&
    initial.annotations !== undefined
  ) {
    if (exact)
      return isDeepStrictEqual(initial.annotations, final.annotations ?? []);
    return initial.annotations.every((annotation, index) =>
      isDeepStrictEqual(annotation, final.annotations?.[index]),
    );
  }
  return true;
}

export function sameAdded(
  added: unknown,
  done: z.infer<typeof outputItem>,
): boolean {
  const a = z
    .object({
      id,
      type: z.string(),
      call_id: id.optional(),
      name: z.string().optional(),
      arguments: z.string().optional(),
      role: z.string().optional(),
      content: message.shape.content.optional(),
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
  if (done.type === "message")
    return (
      (a.data.role === undefined || a.data.role === done.role) &&
      (a.data.content ?? []).every((part, index) =>
        matchesPart(part, done.content[index], false),
      )
    );
  return true;
}
export function sameItem(
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
    return a.role === b.role && isDeepStrictEqual(a.content, b.content);
  return (
    (a.type === "reasoning" || a.type === "web_search_call") &&
    a.type === b.type &&
    isDeepStrictEqual(a, b)
  );
}

// Continuation lives on the exact assistant message, not in provider-instance memory.
// Validate both externally supplied session state and the wire output before replay.
export function validatedOutput(
  output: unknown,
  h: Helpers,
): z.infer<typeof outputItem>[] {
  const parsed = z.array(outputItem).max(256).parse(output);
  const ids = new Set<string>();
  const calls = new Set<string>();
  for (const item of parsed) {
    if (ids.has(item.id)) throw h.protocol();
    ids.add(item.id);
    if (item.type === "message")
      for (const part of item.content) {
        if (part.type !== "output_text") continue;
        for (const citation of part.annotations ?? [])
          if (citation.end_index > part.text.length) throw h.protocol();
      }
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
      const value = h.parseJson(item.arguments, "tool_arguments");
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw h.protocol("invalid_tool_call", { stage: "tool_arguments" });
    }
  }
  return parsed;
}
