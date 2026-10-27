import { afterEach, expect, it, vi } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import { parseProviderJson } from "../../src/provider/bounded-json";
import { protocol, type ProviderDiagnostic } from "../../src/provider/errors";
import { withSdkRequest } from "../../src/provider/sdk-transport";

afterEach(() => vi.unstubAllGlobals());
const config = { baseUrl: "https://fixture.invalid/v1", apiKey: "PRIVATE_KEY", requestTimeoutMs: 5000 };
const event = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const run = (wire: string, apiMode: "chat-completions" | "responses" = "chat-completions") => {
  const fetch = vi.fn(async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  const result = createModelProvider({ ...config, apiMode }).complete([{ role: "user", content: "test" }], [], {
    model: "fixture", signal: new AbortController().signal, onText: () => {},
  });
  return { result, fetch };
};

it("separates malformed SSE JSON from invalid tool arguments and leaks neither body nor keys", async () => {
  const frame = run('data: {"PRIVATE_BODY":broken}\n\n');
  await expect(frame.result).rejects.toMatchObject({ reason: "invalid_json", message: expect.stringContaining("stage=sse_event") });
  const tool = run(event({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read_file", arguments: '{"PRIVATE_ARGUMENT":' } }] }, "tool_calls") + "data: [DONE]\n\n");
  const error = await tool.result.catch(error => error);
  expect(error).toMatchObject({ reason: "invalid_tool_call", retryable: false, message: expect.stringContaining("stage=tool_arguments") });
  expect(error.message).not.toMatch(/PRIVATE|fixture.invalid/);
  expect(tool.fetch).toHaveBeenCalledTimes(1);
});

it("labels the SSE frame, cumulative text and transport byte limits independently", async () => {
  const frame = run(event({ content: "x".repeat(1_200_001) }, "stop"));
  await expect(frame.result).rejects.toMatchObject({ reason: "output_limit", message: expect.stringMatching(/stage=sse_event; observed=\d+; limit=1200000; unit=utf16_code_units/) });
  const text = run(event({ content: "x".repeat(800_000) }).repeat(3));
  await expect(text.result).rejects.toMatchObject({ reason: "output_limit", message: expect.stringContaining("stage=output_text; observed=2400000; limit=2000000") });
  const fetch: typeof globalThis.fetch = async () => new Response("x".repeat(8_000_001));
  const body = withSdkRequest(config, { idle: false, fetch }, async request => (await request.fetch("https://fixture.invalid")).text());
  await expect(body).rejects.toMatchObject({ reason: "output_limit", message: expect.stringContaining("stage=transport_body; observed=8000001; limit=8000000; unit=bytes") });
});

it("includes JSON size and nesting bounds while rejecting arbitrary diagnostics", () => {
  expect(() => parseProviderJson("x".repeat(8_000_001))).toThrow(expect.objectContaining({
    message: expect.stringContaining("stage=json_response; observed=8000001; limit=8000000; unit=utf16_code_units"),
  }));
  expect(() => parseProviderJson("[".repeat(65) + "0" + "]".repeat(65), "tool_arguments")).toThrow(expect.objectContaining({
    reason: "invalid_tool_call", message: expect.stringContaining("observed=65; limit=64; unit=nesting_depth"),
  }));
  const unsafe = { stage: "PRIVATE", observed: Infinity, limit: -1, unit: "PRIVATE" } as unknown as ProviderDiagnostic;
  expect(protocol("output_limit", unsafe).message).not.toMatch(/PRIVATE|Infinity|-1/);
});

it("labels Responses malformed frames and completed tool JSON without replay", async () => {
  const badFrame = run("data: {broken}\n\n", "responses");
  await expect(badFrame.result).rejects.toMatchObject({ reason: "invalid_json", message: expect.stringContaining("stage=sse_event") });
  const tool = { type: "function_call", id: "fc", call_id: "call", name: "read_file", arguments: "{broken}", status: "completed" };
  const badTool = run(`data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [tool] } })}\n\n`, "responses");
  await expect(badTool.result).rejects.toMatchObject({ reason: "invalid_tool_call", message: expect.stringContaining("stage=tool_arguments") });
  expect(badTool.fetch).toHaveBeenCalledTimes(1);
});
