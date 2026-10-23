import { afterEach, expect, it, vi } from "vitest";
import { added, completed, done, fixture, message, textStream, wire } from "../fixtures/responses-stream";

afterEach(() => vi.unstubAllGlobals());

const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"query":"hi"}', status: "completed" };
const initialCall = { ...call, arguments: "", status: "in_progress" };
const position = { output_index: 0, item_id: call.id };

it.each(["default-event", "event-type-only"])("accepts Responses events using %s", async mode => {
  const stream = mode === "default-event"
    ? textStream().replace(/event: [^\n]+/g, "event: message")
    : textStream().replace(/"type":"response\.[^"]+",/g, "");
  expect((await fixture(stream).run()).message.content).toBe("OK");
});

it("rejects conflicting SSE and payload event identities", async () => {
  await expect(fixture(textStream().replace("event: response.output_text.delta", "event: response.output_item.done")).run())
    .rejects.toMatchObject({ classification: "protocol" });
});

it("accepts a complete terminal snapshot and replays native tool output without another request", async () => {
  const reason = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
  const output = [reason, message("Checking"), call];
  const f = fixture(completed(output), textStream());
  const previews: unknown[] = [];
  const deltas: string[] = [];
  const first = await f.provider.complete([{ role: "user", content: "hello" }], [], {
    model: "fixture", signal: new AbortController().signal, onText: text => deltas.push(text), onToolCall: preview => previews.push(preview),
  });
  expect(first.message.content).toBe("Checking");
  expect(deltas.join("")).toBe("Checking");
  expect(previews.at(-1)).toMatchObject({ index: 0, name: "lookup", argumentsChars: call.arguments.length });
  expect(first.message.tool_calls?.[0]).toMatchObject({ id: call.call_id, function: { arguments: call.arguments } });
  expect(first.message.providerState?.output).toEqual(output);
  expect(f.bodies).toHaveLength(1);
  await f.run([first.message, { role: "tool", tool_call_id: call.call_id, content: "found" }]);
  expect(f.bodies[1]).toMatchObject({ input: [...output, { type: "function_call_output", call_id: call.call_id, output: "found" }] });
});

it.each(["text", "arguments"])("accepts terminal output when redundant %s done frames are omitted", async kind => {
  const stream = kind === "text"
    ? textStream().replace(/event: response\.(?:output_text|output_item|content_part)\.done\ndata: [^\n]+\n\n/g, "")
    : added(0, initialCall) + wire("response.function_call_arguments.delta", { ...position, delta: call.arguments }) + completed([call]);
  const f = fixture(stream);
  const result = await f.run();
  expect(kind === "text" ? result.message.content : result.message.tool_calls?.[0]?.function.arguments)
    .toBe(kind === "text" ? "OK" : call.arguments);
  expect(f.bodies).toHaveLength(1);
});

it("uses final arguments when the gateway sends snapshots without any argument deltas", async () => {
  const stream = added(0, initialCall) + wire("response.function_call_arguments.done", { ...position, arguments: call.arguments }) + done(0, call) + completed([call]);
  expect((await fixture(stream).run()).message.tool_calls?.[0]?.function.arguments).toBe(call.arguments);
});

it("uses final text when the gateway sends snapshots without text deltas", async () => {
  const stream = textStream().replace(/event: response.output_text.delta\ndata: [^\n]+\n\n/g, "");
  const f = fixture(stream);
  const deltas: string[] = [];
  const result = await f.provider.complete([{ role: "user", content: "hello" }], [], { model: "fixture", signal: new AbortController().signal, onText: value => deltas.push(value) });
  expect(result.message.content).toBe("OK");
  expect(deltas).toEqual(["OK"]);
});

it.each(["application/json", "Application/JSON; charset=utf-8"])("accepts an already completed JSON response (%s) without fallback or replay", async contentType => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    id: "resp_1", status: "completed", output: [message("OK")], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  }), { headers: { "content-type": contentType } }));
  vi.stubGlobal("fetch", fetch);
  const result = await f.run();
  expect(result.message.content).toBe("OK");
  expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  added(0, initialCall) + wire("response.function_call_arguments.delta", { ...position, delta: "{" }) + completed([call]),
  added(0, { ...initialCall, name: "other" }) + completed([call]),
  added(0, initialCall) + completed([{ ...call, id: "other" }]),
  added(0, initialCall) + completed([{ ...call, call_id: "other" }]),
  added(0, initialCall) + completed([]),
  completed([{ ...call, arguments: "{" }]),
  completed([{ ...call, arguments: "[]" }]),
  completed([call, { ...call, id: "fc_2" }]),
  completed([message("OK")]) + wire("response.output_text.delta", { output_index: 0, item_id: "msg_1", content_index: 0, delta: "extra" }),
  textStream().replace('"delta":"OK"', '"delta":"O"'),
])("still rejects contradictory, partial or malformed snapshots %#", async stream => {
  const f = fixture(stream);
  await expect(f.run()).rejects.toMatchObject({ classification: "protocol", retryable: false });
  expect(f.bodies).toHaveLength(1);
});

it.each([
  [{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "upstream", "output_truncated"],
  [{ status: "failed", error: { code: "server_error", message: "private upstream detail" } }, "upstream", "server_error"],
  [{ status: "in_progress", output: [message("partial")] }, "protocol", "invalid_response"],
] as const)("does not promote unfinished JSON responses to success %#", async (body, classification, reason) => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "resp_1", ...body }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const task = f.run();
  await expect(task).rejects.toMatchObject({ classification, reason });
  await expect(task).rejects.not.toThrow("private upstream detail");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("splits snapshot-only text into bounded observer deltas", async () => {
  const text = "界".repeat(100000);
  const f = fixture(completed([message(text)]));
  const deltas: string[] = [];
  const result = await f.provider.complete([{ role: "user", content: "hello" }], [], {
    model: "fixture", signal: new AbortController().signal, onText: value => deltas.push(value),
  });
  expect(result.message.content).toBe(text);
  expect(deltas.join("")).toBe(text);
  expect(deltas.every(value => value.length <= 65536)).toBe(true);
});

it("isolates observer failure on a complete snapshot without replay", async () => {
  const f = fixture(completed([message("OK")]));
  await expect(f.provider.complete([{ role: "user", content: "hello" }], [], {
    model: "fixture", signal: new AbortController().signal,
    onText: () => { throw new Error("private observer detail"); },
  })).rejects.toMatchObject({ classification: "observer", retryable: false });
  expect(f.bodies).toHaveLength(1);
});

it.each(["item.added", "part.added", "part.done"])("rejects snapshot text contradicting %s content", async kind => {
  const item = message("B");
  const stream = kind === "item.added"
    ? added(0, { ...message("A"), status: "in_progress" })
    : added(0, { ...item, status: "in_progress", content: [] }) + wire(`response.content_${kind}`, {
      output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "A", annotations: [] },
    });
  await expect(fixture(stream + completed([item])).run()).rejects.toMatchObject({ classification: "protocol" });
});

it("accepts matching initial text and content snapshots without duplicated previews", async () => {
  const item = message("AB");
  const stream = added(0, { ...message("A"), status: "in_progress" }) +
    wire("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "A" } }) +
    wire("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: item.content[0] }) + completed([item]);
  expect((await fixture(stream).run()).message.content).toBe("AB");
});

it("does not reorder text already exposed when a snapshot would need to prepend content", async () => {
  const item = { ...message("A"), content: [...message("A").content, ...message("B").content] };
  const stream = added(0, { ...item, status: "in_progress", content: [] }) +
    wire("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 1, delta: "B" }) + completed([item]);
  await expect(fixture(stream).run()).rejects.toMatchObject({ classification: "protocol" });
});
