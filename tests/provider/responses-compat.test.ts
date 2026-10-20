import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableProviderFailure } from "../../src/shared/errors";
import { assistantMessageSchema } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { added, completed, done, fixture, message, textEvents, textStream, wire } from "../fixtures/responses-stream";

afterEach(() => vi.unstubAllGlobals());
const reason = { type: "reasoning", id: "rs_1", summary: [] };
const reasonStream = (item: object, events = "", terminalItem = item) =>
  added(0, { ...item, status: "in_progress" }) + events + done(0, item) +
  textEvents("OK", 1) + completed([terminalItem, message("OK")]);

it.each([false, true])("accepts refusal prose and replays its native content (empty terminal %s)", async empty => {
  const item = { ...message(""), content: [{ type: "refusal", refusal: "I cannot help with that." }] };
  const position = { item_id: item.id, output_index: 0, content_index: 0 };
  const data = added(0, { ...item, status: "in_progress", content: [] }) +
    wire("response.refusal.delta", { ...position, delta: item.content[0]?.refusal }) +
    wire("response.refusal.done", { ...position, refusal: item.content[0]?.refusal }) +
    done(0, item) + completed(empty ? [] : [item]);
  const f = fixture(data, textStream());
  const first = await f.run();
  expect(first.message.content).toBe("I cannot help with that.");
  await f.run([{ role: "user", content: "first" }, first.message, { role: "user", content: "next" }]);
  expect(f.bodies[1]).toMatchObject({ input: [{ role: "user" }, item, { role: "user" }] });
});

it("accepts nullable encrypted reasoning and native reasoning text events", async () => {
  const item = { ...reason, encrypted_content: null, content: [{ type: "reasoning_text", text: "Thinking." }] };
  const position = { item_id: item.id, output_index: 0, content_index: 0 };
  const events = wire("response.reasoning_text.delta", { ...position, delta: "Thinking." }) +
    wire("response.reasoning_text.done", { ...position, text: "Thinking." });
  const f = fixture(reasonStream(item, events), textStream());
  let preview = "";
  const first = await f.run(undefined, text => { preview += text; });
  expect(preview).toBe("Thinking.");
  expect(first.message.reasoning).toBe("Thinking.");
  await f.run([first.message, { role: "user", content: "next" }]);
  expect(f.bodies[1]).toMatchObject({ input: [item, message("OK"), { role: "user" }] });
});

it("accepts null encrypted content without reasoning text events", async () => {
  expect((await fixture(reasonStream({ ...reason, encrypted_content: null })).run()).message.content).toBe("OK");
});

it("compares reasoning objects structurally, not by JSON key order", async () => {
  const a = { ...reason, summary: [{ type: "summary_text", text: "Summary" }] };
  const b = { ...reason, summary: [{ text: "Summary", type: "summary_text" }] };
  expect((await fixture(reasonStream(a, "", b)).run()).message.content).toBe("OK");
});

it.each(["x".repeat(300000), "界".repeat(90000)])("retains and replays long responses beyond the old continuation cap %#", async text => {
  const f = fixture(textStream(text), textStream());
  const first = await f.run();
  const reopened = assistantMessageSchema.parse(JSON.parse(JSON.stringify(first.message)));
  expect(reopened.content).toBe(text);
  await f.run([reopened, { role: "user", content: "next" }]);
  expect(f.bodies[1]).toMatchObject({ input: [message(text), { role: "user" }] });
});

it("retains large opaque encrypted reasoning through continuation", async () => {
  const item = { ...reason, encrypted_content: "e".repeat(300000) };
  const f = fixture(reasonStream(item), textStream());
  const first = await f.run();
  await f.run([first.message, { role: "user", content: "next" }]);
  expect(f.bodies[1]).toMatchObject({ input: [item, message("OK"), { role: "user" }] });
});

it("reopens a long response from disk and sends its intact continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-response-long-"));
  try {
    const text = "界".repeat(100000);
    const f = fixture(textStream(text), textStream());
    const first = await f.run();
    const store = await openSessionStore(root);
    const session = await store.create({ workspace: root, title: "long", model: "fixture" });
    await store.save({ ...session, messages: [first.message] });
    const reopened = await (await openSessionStore(root)).get(session.id);
    expect(reopened.messages[0]).toEqual(first.message);
    await f.run([...reopened.messages, { role: "user", content: "next" }]);
    expect(f.bodies[1]).toMatchObject({ input: [message(text), { role: "user" }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves large tool arguments and the paired result across continuation", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "write_file", arguments: JSON.stringify({ content: "x".repeat(300000) }), status: "completed" };
  const position = { output_index: 0, item_id: call.id };
  const data = added(0, { ...call, arguments: "", status: "in_progress" }) +
    wire("response.function_call_arguments.delta", { ...position, delta: call.arguments }) +
    wire("response.function_call_arguments.done", { ...position, arguments: call.arguments }) + done(0, call) + completed([call]);
  const f = fixture(data, textStream());
  const first = await f.run();
  expect(first.message.tool_calls?.[0]?.function.arguments).toBe(call.arguments);
  await f.run([first.message, { role: "tool", tool_call_id: call.call_id, content: "written" }]);
  expect(f.bodies[1]).toMatchObject({ input: [call, { type: "function_call_output", call_id: call.call_id, output: "written" }] });
});

it.each(["", "data: [DONE]\n\n"])("accepts metadata after completion and transport marker %s", async marker => {
  const data = textStream() + marker + wire("response.metadata", { response_id: "resp_1", metadata: { route: "fixture" } });
  expect((await fixture(data).run()).message.content).toBe("OK");
});

it("ignores additive informational events without losing the completion requirement", async () => {
  const info = wire("response.telemetry", { counters: { tokens: 1 } });
  expect((await fixture(info + textStream() + info).run()).message.content).toBe("OK");
  await expect(fixture(info + textEvents("OK")).run()).rejects.toMatchObject({ reason: "missing_completion" });
});

it.each([
  ["error", { code: "rate_limit_exceeded", message: "private upstream detail", param: null }, "rate_limit_exceeded", true],
  ["response.failed", { response: { status: "failed", error: { code: "server_error", message: "private upstream detail" } } }, "server_error", true],
  ["response.failed", { response: { status: "failed", error: { code: "invalid_api_key", message: "private upstream detail" } } }, "authentication_error", false],
  ["error", { code: "insufficient_quota", message: "private upstream detail" }, "insufficient_quota", false],
  ["response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }, "output_truncated", false],
  ["response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } }, "content_filter", false],
  ["error", { code: "unknown", message: "private upstream detail" }, "provider_error_event", false],
] as const)("classifies %s upstream failures as %s %#", async (type, fields, reason, retryable) => {
  const f = fixture(wire(type, fields));
  const result = f.run();
  await expect(result).rejects.toMatchObject({ classification: "upstream", reason, retryable });
  await expect(result).rejects.not.toThrow("private upstream detail");
  await result.catch(error => { expect(isRetryableProviderFailure(error)).toBe(retryable); });
  expect(f.bodies).toHaveLength(1);
});

it.each([
  textStream() + wire("response.metadata", { response_id: "other", metadata: {} }),
  textStream() + wire("response.output_item.added", { output_index: 1, item: { type: "function_call", id: "fc_2" } }),
  textStream().replace('"delta":"OK"', '"delta":"different"'),
  reasonStream({ ...reason, summary: [{ type: "summary_text", text: "one" }] }, "", { ...reason, summary: [{ type: "summary_text", text: "two" }] }),
])("still rejects contradictory identities, content and post-completion output %#", async data => {
  await expect(fixture(data).run()).rejects.toMatchObject({ classification: "protocol" });
});
