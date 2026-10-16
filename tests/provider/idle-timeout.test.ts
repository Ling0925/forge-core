import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import type { ModelProvider } from "../../src/shared/contracts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void, apiMode: "chat-completions" | "responses" = "chat-completions") {
  let requests = 0;
  const server = createServer((req, res) => { requests++; handler(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; });
  return { provider: createModelProvider({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", requestTimeoutMs: 1000, apiMode }), requests: () => requests };
}
const run = (provider: ModelProvider, signal = new AbortController().signal, onReasoning = (_text: string) => {}) =>
  provider.complete([{ role: "user", content: "synthetic timeout test" }], [], { model: "fixture", signal, onText: () => {}, onReasoning });
const chat = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const wire = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
function responsesAnswer() {
  const message = { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] };
  return wire("response.created", { response: { id: "r1", status: "in_progress" } })
    + wire("response.output_item.added", { output_index: 0, item: { ...message, status: "in_progress", content: [] } })
    + wire("response.content_part.added", { output_index: 0, content_index: 0, item_id: "m1", part: { type: "output_text", text: "" } })
    + wire("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "m1", delta: "ok" })
    + wire("response.output_text.done", { output_index: 0, content_index: 0, item_id: "m1", text: "ok" })
    + wire("response.content_part.done", { output_index: 0, content_index: 0, item_id: "m1", part: message.content[0] })
    + wire("response.output_item.done", { output_index: 0, item: message })
    + wire("response.completed", { response: { id: "r1", status: "completed", output: [message] } });
}
function slow(res: ServerResponse, chunks: string[], end: string) {
  let index = 0;
  const timer = setInterval(() => {
    if (index < chunks.length) res.write(chunks[index++]);
    else { clearInterval(timer); res.end(end); }
  }, 300);
  res.once("close", () => clearInterval(timer));
}

it.each(["chat-completions", "responses"] as const)("allows %s heartbeat activity beyond the total timeout", async apiMode => {
  const f = await fixture((_req, res) => {
    res.setHeader("content-type", "text/event-stream"); res.flushHeaders();
    slow(res, Array(5).fill(": heartbeat\n\n"), apiMode === "responses" ? responsesAnswer() : chat({ content: "ok" }) + chat({}, "stop") + "data: [DONE]\n\n");
  }, apiMode);
  expect((await run(f.provider)).message.content).toBe("ok"); expect(f.requests()).toBe(1);
});

it("renews on reasoning and fragmented tool arguments without requiring visible answer text", async () => {
  const seen: string[] = [];
  const f = await fixture((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write(chat({ reasoning_content: "thinking" }));
    slow(res, [chat({ reasoning_content: " more" }), chat({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read_file", arguments: "{" } }] }),
      chat({ tool_calls: [{ index: 0, function: { arguments: '"path"' } }] }), chat({ tool_calls: [{ index: 0, function: { arguments: ':"a"' } }] }),
      chat({ tool_calls: [{ index: 0, function: { arguments: "}" } }] })], chat({}, "tool_calls") + "data: [DONE]\n\n");
  });
  const result = await run(f.provider, undefined, text => seen.push(text));
  expect(seen.join("")).toBe("thinking more"); expect(result.message.tool_calls?.[0]?.function.arguments).toBe('{"path":"a"}');
  expect(f.requests()).toBe(1);
});

it("renews on partial SSE frames before a complete event is available", async () => {
  const f = await fixture((_req, res) => {
    res.setHeader("content-type", "text/event-stream"); res.write("data: ");
    const body = JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] });
    slow(res, [body.slice(0, 10), body.slice(10, 20), body.slice(20, 30), body.slice(30, 40), body.slice(40)], "\n\n" + chat({}, "stop"));
  });
  expect((await run(f.provider)).message.content).toBe("ok");
});

it.each(["headers", "body"])("still times out a stalled %s without retrying generation", async phase => {
  const f = await fixture((_req, res) => {
    if (phase === "body") { res.setHeader("content-type", "text/event-stream"); res.write(chat({ reasoning_content: "started" })); }
  });
  await expect(run(f.provider)).rejects.toMatchObject({ classification: "timeout", message: expect.stringContaining("idle timeout") });
  expect(f.requests()).toBe(1);
});

it("a concurrent active request cannot keep a stalled request alive", async () => {
  let index = 0;
  const f = await fixture((_req, res) => {
    res.setHeader("content-type", "text/event-stream"); res.write(": start\n\n");
    if (++index === 1) slow(res, Array(5).fill(": ping\n\n"), chat({ content: "ok" }) + chat({}, "stop"));
  });
  const results = await Promise.allSettled([run(f.provider), run(f.provider)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { classification: "timeout" } });
});

it("user cancellation wins during a healthy slow stream and closes the connection", async () => {
  const controller = new AbortController(); let closed = false;
  const f = await fixture((_req, res) => {
    res.once("close", () => { closed = true; });
    res.setHeader("content-type", "text/event-stream"); res.write(chat({ reasoning_content: "cancel here" }));
    slow(res, Array(5).fill(": ping\n\n"), "");
  });
  await expect(run(f.provider, controller.signal, () => controller.abort())).rejects.toMatchObject({ classification: "aborted" });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(closed).toBe(true); expect(f.requests()).toBe(1);
});

it("allows a slowly delivered JSON response without requiring SSE events", async () => {
  const f = await fixture((_req, res) => {
    res.setHeader("content-type", "application/json"); res.write(" ");
    slow(res, Array(5).fill(" "), JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  expect((await run(f.provider)).message.content).toBe("ok");
  expect(f.requests()).toBe(1);
});

it("expires after the last heartbeat rather than the request start", async () => {
  let lastActivity = 0;
  const f = await fixture((_req, res) => {
    res.setHeader("content-type", "text/event-stream"); res.write(": start\n\n");
    const timer = setTimeout(() => { lastActivity = Date.now(); res.write(": final heartbeat\n\n"); }, 600);
    res.once("close", () => clearTimeout(timer));
  });
  await expect(run(f.provider)).rejects.toMatchObject({ classification: "timeout" });
  expect(lastActivity).toBeGreaterThan(0);
  expect(Date.now() - lastActivity).toBeGreaterThanOrEqual(900);
  expect(f.requests()).toBe(1);
});

it("keeps catalog discovery on a total deadline even when its body is trickling", async () => {
  const f = await fixture((_req, res) => { res.setHeader("content-type", "application/json"); res.write(" "); slow(res, Array(5).fill(" "), '{"data":[]}'); });
  await expect(f.provider.listModels()).rejects.toMatchObject({ classification: "timeout" });
  expect(f.requests()).toBe(1);
});
