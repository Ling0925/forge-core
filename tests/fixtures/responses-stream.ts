import { vi } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import type { Message } from "../../src/shared/schemas";

export const wire = (type: string, fields: object = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
export const message = (text: string) => ({
  type: "message", id: "msg_1", role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
export const added = (output_index: number, item: object) => wire("response.output_item.added", { output_index, item });
export const done = (output_index: number, item: object) => wire("response.output_item.done", { output_index, item });
export const completed = (output: readonly object[]) => wire("response.completed", {
  response: { id: "resp_1", status: "completed", output },
});
export function textEvents(text: string, output_index = 0) {
  const item = message(text);
  const position = { output_index, item_id: item.id, content_index: 0 };
  return added(output_index, { ...item, status: "in_progress", content: [] }) +
    wire("response.content_part.added", { ...position, part: { type: "output_text", text: "", annotations: [] } }) +
    wire("response.output_text.delta", { ...position, delta: text }) +
    wire("response.output_text.done", { ...position, text }) +
    wire("response.content_part.done", { ...position, part: item.content[0] }) + done(output_index, item);
}
export const textStream = (text = "OK") => textEvents(text) + completed([message(text)]);

export function fixture(...streams: readonly string[]) {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const data = streams[bodies.length - 1];
    if (data === undefined) throw new Error("Unexpected extra provider request");
    return new Response(data, { headers: { "content-type": "text/event-stream" } });
  });
  const provider = createModelProvider({
    baseUrl: "https://fixture.invalid/v1", apiKey: "", apiMode: "responses", requestTimeoutMs: 2000,
  });
  const run = (history: readonly Message[] = [{ role: "user", content: "fixture" }], onReasoning = (_text: string) => {}) =>
    provider.complete(history, [], { model: "fixture", signal: new AbortController().signal, onText: () => {}, onReasoning });
  return { run, bodies, provider };
}
