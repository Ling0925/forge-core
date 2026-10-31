import { isDeepStrictEqual } from "node:util";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
} from "openai/resources/responses/responses";
import type { Message, ToolDefinition } from "../shared/schemas";
import type { WebSearchMode } from "../shared/web-search";
import { type Helpers, prose, validatedOutput } from "./responses-events";

function input(
  h: Helpers,
  baseUrl: string,
  messages: readonly Message[],
  model: string,
): unknown[] {
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
        state.model === model &&
        (h.credentialId === undefined
          ? state.credentialId === undefined
          : state.credentialId === h.credentialId);
      if (sameOrigin && state) {
        const original = validatedOutput(state.output, h);
        const nativeCalls = original.filter(
          (item) => item.type === "function_call",
        );
        if (
          m.content !==
            (original
              .filter((item) => item.type === "message")
              .flatMap((item) => item.content.map(prose))
              .join("") || null) ||
          !isDeepStrictEqual(
            nativeCalls.map((item) => ({
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: item.arguments },
            })),
            m.tool_calls ?? [],
          )
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
                ...(m.content ? [{ type: "input_text", text: m.content }] : []),
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

export function body(
  h: Helpers,
  baseUrl: string,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  model: string,
  webSearch: WebSearchMode = "disabled",
): ResponseCreateParamsStreaming {
  return {
    model,
    input: input(h, baseUrl, messages, model) as ResponseInput,
    tools: [
      ...tools.map((t) => ({
        type: "function" as const,
        ...t.function,
        strict: false,
      })),
      ...(webSearch === "disabled"
        ? []
        : [
            {
              type: "web_search" as const,
              external_web_access: webSearch === "live",
            },
          ]),
    ],
    stream: true,
    store: false,
    include: [
      "reasoning.encrypted_content",
      ...(webSearch === "disabled"
        ? []
        : ["web_search_call.action.sources" as const]),
    ],
  };
}
