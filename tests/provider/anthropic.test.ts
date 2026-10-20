import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import type { ProviderConfig, ToolCallPreview } from "../../src/shared/schemas";
import { image } from "../fixtures/image";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  config: Partial<ProviderConfig> = {},
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return createModelProvider({
    baseUrl: `http://127.0.0.1:${address.port}/gateway/v1/`,
    apiMode: "anthropic",
    apiKey: "",
    requestTimeoutMs: 1000,
    ...config,
  });
}
const options = () => ({
  model: "claude-fixture",
  signal: new AbortController().signal,
  onText: (_text: string) => {},
});
const sse = (event: Record<string, unknown>) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
function wire({
  tool = false,
  thinking = false,
  stop = tool ? "tool_use" : "end_turn",
  args = '{"path":"a"}',
  terminal = true,
}: {
  tool?: boolean;
  thinking?: boolean;
  stop?: string;
  args?: string;
  terminal?: boolean;
} = {}) {
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
      },
    },
  ];
  let index = 0;
  if (thinking) {
    events.push(
      {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: "consider" },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "opaque-signature" },
      },
      { type: "content_block_stop", index },
    );
    index++;
  }
  events.push(
    {
      type: "content_block_start",
      index,
      content_block: tool
        ? { type: "tool_use", id: "tool_1", name: "read_file", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta: tool
        ? { type: "input_json_delta", partial_json: args }
        : { type: "text_delta", text: "hello" },
    },
    { type: "content_block_stop", index },
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 4 },
    },
  );
  if (terminal) events.push({ type: "message_stop" });
  return events.map(sse).join("");
}
function reply(response: ServerResponse, body = wire()) {
  response.setHeader("content-type", "text/event-stream");
  response.end(body);
}
async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return JSON.parse(text);
}

it("uses native SDK routes/auth, system/images/tools and reported cache usage", async () => {
  let received: unknown;
  let path: string | undefined;
  let key: string | string[] | undefined;
  const provider = await fixture(
    async (req, res) => {
      path = req.url;
      key = req.headers["x-api-key"];
      received = await body(req);
      reply(res);
    },
    { apiKey: "fixture-key", maxOutputTokens: 4096 },
  );
  const text: string[] = [];
  const response = await provider.complete(
    [
      { role: "system", content: "system" },
      { role: "user", content: "describe", images: [image] },
    ],
    [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    { ...options(), onText: (value) => text.push(value) },
  );
  expect(path).toBe("/gateway/v1/messages");
  expect(key).toBe("fixture-key");
  expect(received).toMatchObject({
    system: "system",
    model: "claude-fixture",
    max_tokens: 4096,
    stream: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png" },
          },
        ],
      },
    ],
    tools: [{ name: "read_file", input_schema: { type: "object" } }],
  });
  expect(text.join("")).toBe("hello");
  expect(response.usage).toEqual({
    promptTokens: 15,
    completionTokens: 4,
    totalTokens: 19,
    cachedPromptTokens: 3,
  });
});

it.each([1024, 8192, 32768])("sends native max effort with adaptive thinking at %i output tokens", async (maxOutputTokens) => {
  let received: unknown;
  const provider = await fixture(async (req, res) => {
    received = await body(req);
    reply(res, wire({ thinking: true }));
  }, { reasoningEffort: "max", maxOutputTokens });
  await provider.complete([{ role: "user", content: "test" }], [], options());
  expect(received).toMatchObject({
    max_tokens: maxOutputTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
  });
  expect(received).not.toHaveProperty("thinking.budget_tokens");
});

it("resumes signed thinking with tools only for the matching endpoint/model", async () => {
  const requests: unknown[] = [];
  const provider = await fixture(
    async (req, res) => {
      requests.push(await body(req));
      reply(
        res,
        requests.length === 1 ? wire({ tool: true, thinking: true }) : wire(),
      );
    },
    { reasoningEffort: "high" },
  );
  const previews: ToolCallPreview[] = [];
  const reasoning: string[] = [];
  const first = await provider.complete(
    [{ role: "user", content: "read" }],
    [],
    {
      ...options(),
      onReasoning: (value) => reasoning.push(value),
      onToolCall: (value) => previews.push(value),
    },
  );
  expect(first.message.tool_calls).toEqual([
    {
      id: "tool_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a"}' },
    },
  ]);
  expect(reasoning.join("")).toBe("consider");
  expect(previews.at(-1)).toEqual({
    index: 0,
    name: "read_file",
    argumentsChars: 12,
  });
  const messages = [
    { role: "user" as const, content: "read" },
    first.message,
    {
      role: "tool" as const,
      tool_call_id: "tool_1",
      content: '{"content":"denied","isError":true}',
    },
  ];
  await provider.complete(messages, [], options());
  expect(requests[1]).toMatchObject({
    thinking: { type: "enabled", budget_tokens: 8191 },
    messages: [
      { role: "user" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "consider",
            signature: "opaque-signature",
          },
          { type: "tool_use", id: "tool_1", input: { path: "a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool_1", is_error: true },
        ],
      },
    ],
  });
  await provider.complete(messages, [], {
    ...options(),
    model: "different-model",
  });
  expect(JSON.stringify(requests[2])).not.toContain("opaque-signature");
  await expect(
    provider.complete(
      [
        { ...first.message, content: "tampered" },
        { role: "tool", tool_call_id: "tool_1", content: "result" },
      ],
      [],
      options(),
    ),
  ).rejects.toMatchObject({ classification: "protocol" });
  expect(requests).toHaveLength(3);
});

it("paginates native models without inheriting environment credentials", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "environment-secret");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "environment-token");
  const paths: string[] = [];
  const provider = await fixture((req, res) => {
    paths.push(req.url ?? "");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers["x-api-key"]).toBeUndefined();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ id: paths.length === 1 ? "z" : "a", type: "model" }],
        has_more: paths.length === 1,
        first_id: "z",
        last_id: "z",
      }),
    );
  });
  expect(await provider.listModels()).toEqual(["a", "z"]);
  expect(paths[0]).toBe("/gateway/v1/models?limit=100");
  expect(paths[1]).toContain("after_id=z");
});

it("keeps native model context windows across paginated catalog reads", async () => {
  let requests = 0;
  const provider = await fixture((req, res) => {
    requests++;
    const secondPage = req.url?.includes("after_id=large");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      data: secondPage
        ? [{ id: "small", max_input_tokens: "64000" }, { id: "unknown", max_output_tokens: 8192 }]
        : [{ id: "large", max_input_tokens: 1000000 }],
      has_more: !secondPage, first_id: secondPage ? "small" : "large", last_id: secondPage ? "unknown" : "large",
    }));
  });
  expect(await provider.getModelContextWindow?.("large")).toBe(1000000);
  expect(await provider.getModelContextWindow?.("small")).toBe(64000);
  expect(await provider.getModelContextWindow?.("unknown")).toBeNull();
  expect(await provider.getModelContextWindow?.("missing")).toBeNull();
  expect(requests).toBe(2);
  expect(await provider.listModels()).toEqual(["large", "small", "unknown"]);
  expect(await provider.getModelContextWindow?.("large")).toBe(1000000);
  expect(requests).toBe(4);
});

it.each([401, 429, 503])(
  "sanitizes HTTP %s and never retries a generation",
  async (status) => {
    let count = 0;
    const provider = await fixture((_req, res) => {
      count++;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "private-key-and-arguments" },
        }),
      );
    });
    const work = provider.complete(
      [{ role: "user", content: "go" }],
      [],
      options(),
    );
    await expect(work).rejects.toMatchObject({
      classification: "http",
      status,
    });
    await expect(work).rejects.not.toThrow("private-key-and-arguments");
    expect(count).toBe(1);
  },
);

it.each([
  wire({ terminal: false }),
  wire({ stop: "max_tokens" }),
  wire({ stop: "refusal" }),
  wire({ tool: true, args: '{"path":"unfinished' }),
])(
  "rejects incomplete/truncated/unsupported responses before exposing calls %#",
  async (response) => {
    const provider = await fixture((_req, res) => reply(res, response));
    await expect(
      provider.complete([{ role: "user", content: "go" }], [], options()),
    ).rejects.toMatchObject({ classification: "protocol" });
  },
);

it("rejects unpaired tool history before making a request", async () => {
  let count = 0;
  const provider = await fixture((_req, res) => {
    count++;
    reply(res);
  });
  await expect(
    provider.complete(
      [{ role: "tool", tool_call_id: "unknown", content: "result" }],
      [],
      options(),
    ),
  ).rejects.toMatchObject({ classification: "protocol" });
  expect(count).toBe(0);
});

it("preserves observer failure and user cancellation", async () => {
  const provider = await fixture((_req, res) => reply(res));
  await expect(
    provider.complete([{ role: "user", content: "go" }], [], {
      ...options(),
      onText: () => {
        throw Error("private observer");
      },
    }),
  ).rejects.toMatchObject({ classification: "observer" });
  const abort = new AbortController();
  abort.abort();
  await expect(
    provider.complete([{ role: "user", content: "go" }], [], {
      ...options(),
      signal: abort.signal,
    }),
  ).rejects.toMatchObject({ classification: "aborted" });
});

it("applies the idle deadline after headers", async () => {
  const provider = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": heartbeat\n\n");
  });
  await expect(
    provider.complete([{ role: "user", content: "go" }], [], options()),
  ).rejects.toMatchObject({ classification: "timeout" });
});

it("estimates write_file lines from cumulative input_json_delta fragments", async () => {
  const parts = ['{"path":"a.ts","content":"one\\ntwo', '\\nthree"}'];
  const stream = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool_1",
        name: "write_file",
        input: {},
      },
    },
    // Two deltas so a preview exists before the arguments are complete.
    ...parts.map((partial_json) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  const provider = await fixture((_req, res) =>
    reply(res, stream.map(sse).join("")),
  );
  const previews: ToolCallPreview[] = [];
  const result = await provider.complete(
    [{ role: "user", content: "write" }],
    [],
    { ...options(), onToolCall: (preview) => previews.push(preview) },
  );

  expect(previews).toHaveLength(3);
  // The block-start frame has no arguments yet, so it carries no estimate.
  expect(previews[0]).toMatchObject({
    index: 0,
    name: "write_file",
    argumentsChars: 0,
  });
  expect(previews[0]?.linesAdded).toBeUndefined();
  // The first fragment already holds two content lines.
  expect(previews[1]).toMatchObject({
    index: 0,
    name: "write_file",
    linesAdded: 2,
  });
  expect(previews[2]).toMatchObject({
    index: 0,
    name: "write_file",
    argumentsChars: parts.join("").length,
    linesAdded: 3,
  });
  expect(previews.every((preview) => preview.linesRemoved === undefined)).toBe(
    true,
  );
  // The raw content still never crosses the preview boundary.
  expect(JSON.stringify(previews)).not.toContain("one");
  expect(result.message.tool_calls?.[0]?.function.arguments).toBe(
    '{"path":"a.ts","content":"one\\ntwo\\nthree"}',
  );
});
