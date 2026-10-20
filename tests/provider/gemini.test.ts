import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createGeminiProvider } from "../../src/provider/gemini";
import type { ProviderConfig, ToolCallPreview } from "../../src/shared/schemas";
import { image } from "../fixtures/image";

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;
type WireBody = Record<string, unknown>;
type WireContent = { role: string; parts: Record<string, unknown>[] };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function serve(handler: Handler): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
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
  return `http://127.0.0.1:${address.port}/relay/v1beta/`;
}

const providerAt = (baseUrl: string, config: Partial<ProviderConfig> = {}) =>
  createGeminiProvider({
    baseUrl,
    apiMode: "gemini",
    apiKey: "",
    requestTimeoutMs: 1000,
    ...config,
  });

const fixture = async (
  handler: Handler,
  config: Partial<ProviderConfig> = {},
) => providerAt(await serve(handler), config);

const options = () => ({
  model: "gemini-fixture",
  signal: new AbortController().signal,
  onText: (_text: string) => {},
});
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const reply = (response: ServerResponse, frames: unknown[]) => {
  response.setHeader("content-type", "text/event-stream");
  response.end(frames.map(sse).join(""));
};
async function body(request: IncomingMessage): Promise<WireBody> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return JSON.parse(text) as WireBody;
}
const contentsOf = (value: WireBody | undefined): WireContent[] =>
  (value?.contents ?? []) as WireContent[];
const partOf = (value: WireBody, content: number, part: number) =>
  contentsOf(value)[content]?.parts[part];
const contextWindow = async (
  provider: ReturnType<typeof createGeminiProvider>,
  model: string,
) => provider.getModelContextWindow?.(model);

it("streams text, reasoning, images and usage through the native Gemini route", async () => {
  let received: WireBody | undefined;
  let path: string | undefined;
  let key: string | string[] | undefined;
  let authorization: string | undefined;
  const provider = await fixture(
    async (request, response) => {
      path = request.url;
      key = request.headers["x-goog-api-key"];
      authorization = request.headers.authorization;
      received = await body(request);
      reply(response, [
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "think ", thought: true }],
              },
            },
          ],
        },
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "hello-" }] } },
          ],
        },
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "world" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 7,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 2,
            totalTokenCount: 12,
            cachedContentTokenCount: 1,
          },
        },
      ]);
    },
    { apiKey: "fixture-key", maxOutputTokens: 4096, reasoningEffort: "high" },
  );
  const text: string[] = [];
  const reasoning: string[] = [];
  const result = await provider.complete(
    [
      { role: "system", content: "be brief" },
      { role: "user", content: "describe", images: [image] },
    ],
    [],
    {
      ...options(),
      onText: (value) => text.push(value),
      onReasoning: (value) => reasoning.push(value),
    },
  );
  expect(path).toBe(
    "/relay/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse",
  );
  expect(key).toBe("fixture-key");
  expect(authorization).toBeUndefined();
  expect(received).not.toHaveProperty("model");
  expect(received).not.toHaveProperty("stream");
  expect(received?.systemInstruction).toEqual({
    parts: [{ text: "be brief" }],
  });
  expect(contentsOf(received)).toEqual([
    {
      role: "user",
      parts: [
        { text: "describe" },
        { inlineData: { mimeType: "image/png", data: expect.any(String) } },
      ],
    },
  ]);
  expect(received?.generationConfig).toEqual({
    maxOutputTokens: 4096,
    thinkingConfig: { thinkingBudget: 24000, includeThoughts: true },
  });
  expect(text.join("")).toBe("hello-world");
  expect(reasoning.join("")).toBe("think ");
  expect(result.message.content).toBe("hello-world");
  expect(result.message.reasoning).toBe("think ");
  expect(result.message.providerState).toMatchObject({
    version: 1,
    apiMode: "gemini",
    baseUrl: expect.stringMatching(
      /^http:\/\/127\.0\.0\.1:\d+\/relay\/v1beta$/,
    ),
  });
  expect(result.usage).toEqual({
    promptTokens: 7,
    completionTokens: 5,
    totalTokens: 12,
    cachedPromptTokens: 1,
  });
});

it("round-trips complete tool calls, thought signatures and results by id", async () => {
  const requests: WireBody[] = [];
  const tool = {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: {} },
    },
  };
  const provider = await fixture(async (request, response) => {
    requests.push(await body(request));
    reply(
      response,
      requests.length === 1
        ? [
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        text: "plan",
                        thought: true,
                        thoughtSignature: "sig-thought",
                      },
                      {
                        functionCall: {
                          name: "read_file",
                          args: { path: "a" },
                        },
                        thoughtSignature: "sig-call",
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
            },
          ]
        : [
            {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "ok" }] },
                  finishReason: "STOP",
                },
              ],
            },
          ],
    );
  });
  const previews: ToolCallPreview[] = [];
  const first = await provider.complete(
    [{ role: "user", content: "read" }],
    [tool],
    { ...options(), onToolCall: (preview) => previews.push(preview) },
  );
  const call = first.message.tool_calls?.[0];
  if (!call) throw Error("missing tool call");
  expect(call.id).toMatch(/^call_[0-9a-f-]{36}$/);
  expect(call).toEqual({
    id: call.id,
    type: "function",
    function: { name: "read_file", arguments: '{"path":"a"}' },
  });
  expect(previews.at(-1)).toEqual({
    index: 0,
    name: "read_file",
    argumentsChars: 12,
  });
  await provider.complete(
    [
      { role: "user", content: "read" },
      first.message,
      { role: "tool", tool_call_id: call.id, content: '{"content":"ok"}' },
    ],
    [tool],
    options(),
  );
  expect(contentsOf(requests[1])).toEqual([
    { role: "user", parts: [{ text: "read" }] },
    {
      role: "model",
      parts: [
        { text: "plan", thought: true, thoughtSignature: "sig-thought" },
        {
          functionCall: { id: call.id, name: "read_file", args: { path: "a" } },
          thoughtSignature: "sig-call",
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: call.id,
            name: "read_file",
            response: { output: '{"content":"ok"}' },
          },
        },
      ],
    },
  ]);
  await provider.complete(
    [
      { role: "user", content: "read" },
      first.message,
      { role: "tool", tool_call_id: call.id, content: '{"isError":true}' },
    ],
    [tool],
    options(),
  );
  expect(partOf(requests[2] ?? {}, 2, 0)).toEqual({
    functionResponse: {
      id: call.id,
      name: "read_file",
      response: { error: '{"isError":true}' },
    },
  });
});

it("never returns a tool call whose arguments are not one complete object", async () => {
  const failures = [
    { functionCall: { name: "read_file", args: '{"path":' } },
    { functionCall: { name: "read_file", args: ["a"] } },
  ];
  for (const [index, part] of failures.entries()) {
    const provider = await fixture((_request, response) => {
      reply(response, [
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "go" }, part] },
              finishReason: "STOP",
            },
          ],
        },
      ]);
    });
    const error = await provider
      .complete([{ role: "user", content: "go" }], [], options())
      .then(
        () => undefined,
        (value: unknown) => value,
      );
    expect(error, `case ${index}`).toMatchObject({
      classification: "protocol",
      reason: "invalid_tool_call",
    });
  }
});

it("replays a signature only for the same endpoint, model and credential", async () => {
  const requests: WireBody[] = [];
  const baseUrl = await serve(async (request, response) => {
    requests.push(await body(request));
    reply(
      response,
      requests.length === 1
        ? [
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        text: "plan",
                        thought: true,
                        thoughtSignature: "sig-thought",
                      },
                      {
                        functionCall: {
                          name: "read_file",
                          args: { path: "a" },
                        },
                        thoughtSignature: "sig-call",
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
            },
          ]
        : [
            {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "ok" }] },
                  finishReason: "STOP",
                },
              ],
            },
          ],
    );
  });
  const original = providerAt(baseUrl, {
    apiKey: "k",
    credentialId: "cred-a",
  });
  const otherCredential = providerAt(baseUrl, {
    apiKey: "k",
    credentialId: "cred-b",
  });
  const first = await original.complete(
    [{ role: "user", content: "read" }],
    [],
    options(),
  );
  const call = first.message.tool_calls?.[0];
  if (!call) throw Error("missing tool call");
  const history = () => [
    { role: "user" as const, content: "read" },
    { ...first.message },
    { role: "tool" as const, tool_call_id: call.id, content: "ok" },
  ];
  await original.complete(history(), [], options());
  expect(JSON.stringify(requests[1])).toContain(
    '"thoughtSignature":"sig-call"',
  );
  await otherCredential.complete(history(), [], options());
  expect(JSON.stringify(requests[2])).not.toContain("sig-call");
  expect(partOf(requests[2] ?? {}, 1, 0)).toEqual({
    functionCall: { name: "read_file", args: { path: "a" } },
    thoughtSignature: "skip_thought_signature_validator",
  });
  await original.complete(history(), [], {
    ...options(),
    model: "gemini-other",
  });
  expect(JSON.stringify(requests[3])).not.toContain("sig-call");
  expect(JSON.stringify(requests[3])).not.toContain("sig-thought");
  const tampered = {
    ...first.message,
    content: "tampered",
  };
  await expect(
    original.complete(
      [
        { role: "user", content: "read" },
        tampered,
        { role: "tool", tool_call_id: call.id, content: "ok" },
      ],
      [],
      options(),
    ),
  ).rejects.toMatchObject({
    classification: "protocol",
    reason: "invalid_tool_call",
  });
  expect(requests).toHaveLength(4);
});

it("lists native models across pages and keeps the last complete catalog", async () => {
  const paths: string[] = [];
  const keys: (string | string[] | undefined)[] = [];
  let failing = false;
  const provider = await fixture((request, response) => {
    paths.push(request.url ?? "");
    keys.push(request.headers["x-goog-api-key"]);
    if (failing) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: 503, message: "secret" } }));
      return;
    }
    const second = request.url?.includes("pageToken=next") ?? false;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        second
          ? {
              models: [
                {
                  name: "models/gemini-small",
                  displayName: "Small",
                  outputTokenLimit: 8192,
                  supportedGenerationMethods: ["generateContent"],
                },
                {
                  name: "models/text-embedding-004",
                  supportedGenerationMethods: ["embedContent"],
                },
              ],
            }
          : {
              models: [
                {
                  name: "models/gemini-large",
                  displayName: "Large",
                  inputTokenLimit: "1000000",
                },
                {
                  name: "models/gemini-stream-only",
                  supportedGenerationMethods: ["streamGenerateContent"],
                },
              ],
              nextPageToken: "next",
            },
      ),
    );
  });
  expect(await provider.listModels()).toEqual([
    "gemini-large",
    "gemini-small",
    "gemini-stream-only",
  ]);
  expect(paths[0]).toBe("/relay/v1beta/models?pageSize=1000");
  expect(paths[1]).toBe("/relay/v1beta/models?pageSize=1000&pageToken=next");
  expect(keys).toEqual([undefined, undefined]);
  expect(await provider.listModelCatalog?.()).toEqual([
    {
      id: "gemini-large",
      contextWindowTokens: 1000000,
      displayName: "Large",
      provenance: {
        contextWindowTokens: "upstream",
        displayName: "upstream",
      },
    },
    {
      id: "gemini-small",
      contextWindowTokens: null,
      displayName: "Small",
      maxOutputTokens: 8192,
      provenance: { displayName: "upstream", maxOutputTokens: "upstream" },
    },
    {
      id: "gemini-stream-only",
      contextWindowTokens: null,
    },
  ]);
  expect(await contextWindow(provider, "gemini-large")).toBe(1000000);
  expect(await contextWindow(provider, "gemini-small")).toBeNull();
  expect(await contextWindow(provider, "missing")).toBeNull();
  failing = true;
  await expect(provider.listModels()).rejects.toMatchObject({
    classification: "http",
    status: 503,
  });
  // A failed refresh never replaces the previous complete catalog.
  expect(await contextWindow(provider, "gemini-large")).toBe(1000000);
});

it.each([401, 429, 503])(
  "sanitizes HTTP %i and never retries the generation",
  async (status) => {
    let count = 0;
    const provider = await fixture((_request, response) => {
      count += 1;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: status,
            status: "RESOURCE_EXHAUSTED",
            message: "private-key-and-arguments",
          },
        }),
      );
    });
    const error = await provider
      .complete([{ role: "user", content: "go" }], [], options())
      .then(
        () => undefined,
        (value: unknown) => value,
      );
    expect(error).toMatchObject({ classification: "http", status });
    expect((error as Error).message).not.toContain("private-key-and-arguments");
    expect(count).toBe(1);
  },
);

it("maps stream failures, safety stops and empty replies to Forge errors", async () => {
  const failing = await fixture((_request, response) => {
    reply(response, [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "part" }] } }],
      },
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "secret-upstream",
        },
      },
    ]);
  });
  const streamError = await failing
    .complete([{ role: "user", content: "go" }], [], options())
    .then(
      () => undefined,
      (value: unknown) => value,
    );
  expect(streamError).toMatchObject({ classification: "http", status: 429 });
  expect((streamError as Error).message).not.toContain("secret-upstream");
  expect((streamError as Error).message).not.toContain("part");

  const safety = await fixture((_request, response) => {
    reply(response, [
      {
        candidates: [
          { content: { role: "model", parts: [] }, finishReason: "SAFETY" },
        ],
      },
    ]);
  });
  await expect(
    safety.complete([{ role: "user", content: "go" }], [], options()),
  ).rejects.toMatchObject({
    classification: "upstream",
    reason: "content_filter",
  });

  const empty = await fixture((_request, response) => {
    reply(response, [
      {
        candidates: [
          { content: { role: "model", parts: [] }, finishReason: "STOP" },
        ],
      },
    ]);
  });
  await expect(
    empty.complete([{ role: "user", content: "go" }], [], options()),
  ).rejects.toMatchObject({
    classification: "protocol",
    reason: "missing_completion",
  });
});

it("cancels an in-flight stream and reports it as aborted", async () => {
  const provider = await fixture(async (_request, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.write(
      sse({
        candidates: [{ content: { role: "model", parts: [{ text: "part" }] } }],
      }),
    );
    await once(response, "close");
  });
  const controller = new AbortController();
  await expect(
    provider.complete([{ role: "user", content: "go" }], [], {
      model: "gemini-fixture",
      signal: controller.signal,
      onText: () => controller.abort(),
    }),
  ).rejects.toMatchObject({ classification: "aborted" });
});

it("keeps hosted web search Responses-only and sends nothing", async () => {
  let requests = 0;
  const provider = await fixture((_request, response) => {
    requests += 1;
    response.end("{}");
  });
  await expect(
    provider.complete([{ role: "user", content: "go" }], [], {
      ...options(),
      webSearch: "live",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(requests).toBe(0);
});

it("maps effort to native thinking controls without lowering the request", async () => {
  const bodies: WireBody[] = [];
  const baseUrl = await serve(async (request, response) => {
    bodies.push(await body(request));
    reply(response, [
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      },
    ]);
  });
  await providerAt(baseUrl, { reasoningEffort: "max" }).complete(
    [{ role: "user", content: "go" }],
    [],
    { ...options(), model: "gemini-3-pro-preview" },
  );
  await providerAt(baseUrl, { reasoningEffort: "none" }).complete(
    [{ role: "user", content: "go" }],
    [],
    { ...options(), model: "gemini-3-pro-preview" },
  );
  await providerAt(baseUrl, { reasoningEffort: "max" }).complete(
    [{ role: "user", content: "go" }],
    [],
    { ...options(), model: "gemini-2.5-pro" },
  );
  expect(
    (bodies[0]?.generationConfig as WireBody | undefined)?.thinkingConfig,
  ).toEqual({ thinkingLevel: "high", includeThoughts: true });
  expect(
    (bodies[0]?.generationConfig as WireBody | undefined)?.thinkingConfig,
  ).not.toHaveProperty("thinkingBudget");
  expect(
    (bodies[1]?.generationConfig as WireBody | undefined)?.thinkingConfig,
  ).toEqual({ thinkingLevel: "low", includeThoughts: false });
  expect(
    (bodies[2]?.generationConfig as WireBody | undefined)?.thinkingConfig,
  ).toEqual({ thinkingBudget: 32000, includeThoughts: true });
});

it("merges extraBody into the complete body without letting it replace it", async () => {
  const bodies: WireBody[] = [];
  const baseUrl = await serve(async (request, response) => {
    bodies.push(await body(request));
    reply(response, [
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      },
    ]);
  });
  await providerAt(baseUrl, {
    maxOutputTokens: 64,
    extraBody: {
      safetySettings: [
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      ],
      labels: { turn: "${sessionId}" },
      generationConfig: { temperature: 0.9 },
    },
  }).complete([{ role: "user", content: "go" }], [], {
    ...options(),
    sessionId: "session-1",
  });
  expect(bodies[0]?.safetySettings).toEqual([
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  ]);
  expect(bodies[0]?.labels).toEqual({ turn: "session-1" });
  // The request already carries a generationConfig, so the user's value does
  // not replace it and the adapter's own limits stay; "!" is the documented
  // explicit replacement, as in Magpie's extra body.
  expect(bodies[0]?.generationConfig).toEqual({ maxOutputTokens: 64 });
  await providerAt(baseUrl, {
    maxOutputTokens: 64,
    extraBody: { "!generationConfig": { temperature: 0.25 } },
  }).complete([{ role: "user", content: "go" }], [], options());
  expect(bodies[1]?.generationConfig).toEqual({ temperature: 0.25 });
  // A reserved field the user did not force is left out (the body's own value
  // wins); forcing one with "!" is an explicit attempt to take the model, the
  // conversation, the tools or the streaming controls over, and is refused.
  await providerAt(baseUrl, {
    extraBody: { contents: [{ role: "user", parts: [{ text: "wrong" }] }] },
  }).complete([{ role: "user", content: "go" }], [], options());
  expect(contentsOf(bodies[2])).toEqual([
    { role: "user", parts: [{ text: "go" }] },
  ]);
  for (const reserved of [
    "contents",
    "tools",
    "systemInstruction",
    "model",
    "stream",
  ])
    expect(
      () => providerAt(baseUrl, { extraBody: { [`!${reserved}`]: [] } }),
      reserved,
    ).toThrow(/extraBody/);
  expect(bodies).toHaveLength(3);
});

it("sends configured headers and lets an explicit header win over the key", async () => {
  let seen: IncomingMessage["headers"] | undefined;
  const provider = await fixture(
    async (request, response) => {
      seen = request.headers;
      reply(response, [
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "ok" }] },
              finishReason: "STOP",
            },
          ],
        },
      ]);
    },
    {
      apiKey: "primary-key",
      headers: { "x-goog-api-key": "relay-key", "x-relay-trace": "trace-1" },
    },
  );
  await provider.complete([{ role: "user", content: "go" }], [], options());
  expect(seen?.["x-goog-api-key"]).toBe("relay-key");
  expect(seen?.["x-relay-trace"]).toBe("trace-1");
  expect(seen?.authorization).toBeUndefined();
});

// An unresolvable origin ensures a CONNECT handshake alone cannot fake success:
// every byte of the generation request must travel through the proxy tunnel.
it("reaches a proxy-only host through the configured proxy", async () => {
  const target = await serve((_request, response) => {
    reply(response, [
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      },
    ]);
  });
  const targetPort = new URL(target).port;
  const tunnels: string[] = [];
  const proxy = createServer((_request, response) => {
    response.writeHead(501);
    response.end();
  });
  proxy.on("connect", (request, socket, head) => {
    tunnels.push(request.url ?? "");
    const [host, port] = (request.url ?? "").split(":");
    const upstream = connect(
      Number(port),
      host === "provider.invalid" ? "127.0.0.1" : host,
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
    );
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  cleanups.push(async () => {
    const closed = once(proxy, "close");
    proxy.close();
    proxy.closeAllConnections();
    await closed;
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw Error("No proxy port");
  // Only the proxy can reach this name; a direct connection cannot resolve it.
  const provider = providerAt(
    `http://provider.invalid:${targetPort}/relay/v1beta/`,
    { proxyUrl: `http://127.0.0.1:${address.port}` },
  );
  const result = await provider.complete(
    [{ role: "user", content: "go" }],
    [],
    options(),
  );
  expect(result.message.content).toBe("ok");
  expect(tunnels).toEqual([`provider.invalid:${targetPort}`]);
});

it("answers a tool result and the next user text in separate turns", async () => {
  const requests: WireBody[] = [];
  const tool = {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: {} },
    },
  };
  const provider = await fixture(async (request, response) => {
    requests.push(await body(request));
    reply(
      response,
      requests.length === 1
        ? [
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        functionCall: {
                          name: "read_file",
                          args: { path: "a" },
                        },
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
            },
          ]
        : [
            {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "ok" }] },
                  finishReason: "STOP",
                },
              ],
            },
          ],
    );
  });
  const first = await provider.complete(
    [{ role: "user", content: "read" }],
    [tool],
    options(),
  );
  const call = first.message.tool_calls?.[0];
  if (!call) throw Error("missing tool call");
  await provider.complete(
    [
      { role: "user", content: "read" },
      first.message,
      { role: "tool", tool_call_id: call.id, content: "ok" },
      { role: "user", content: "thanks" },
    ],
    [tool],
    options(),
  );
  const contents = contentsOf(requests[1]);
  expect(contents).toHaveLength(4);
  expect(contents[2]).toEqual({
    role: "user",
    parts: [
      {
        functionResponse: {
          id: call.id,
          name: "read_file",
          response: { output: "ok" },
        },
      },
    ],
  });
  // Gemini turns away a turn mixing a functionResponse with text (#1533).
  expect(contents[3]).toEqual({ role: "user", parts: [{ text: "thanks" }] });
});

it("keeps a base prefix and cuts a pasted endpoint back to it", async () => {
  const paths: string[] = [];
  const baseUrl = await serve((request, response) => {
    paths.push(request.url ?? "");
    reply(response, [
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      },
    ]);
  });
  const provider = providerAt(
    `${baseUrl}models/gemini-fixture:streamGenerateContent`,
  );
  await provider.complete([{ role: "user", content: "go" }], [], {
    ...options(),
    model: "gemini-fixture",
  });
  // The relay's /relay/v1beta prefix is kept; the pasted endpoint is not
  // appended to again.
  expect(paths).toEqual([
    "/relay/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse",
  ]);
});
