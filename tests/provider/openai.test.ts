import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import { nativeDefinitions } from "../../src/core/agents";
import type { ModelProvider } from "../../src/shared/contracts";
import { image } from "../fixtures/image";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  key = "",
  timeout = 3000,
): Promise<ModelProvider> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture address unavailable");
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  });
  return createModelProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1/`,
    apiKey: key,
    requestTimeoutMs: timeout,
  });
}
const complete = (
  provider: ModelProvider,
  signal = new AbortController().signal,
  onText: (text: string) => void = () => {},
) =>
  provider.complete([{ role: "user", content: "fixture" }], [], {
    model: "fixture-model",
    signal,
    onText,
  });
const event = (delta: unknown, finish: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
const json = (response: ServerResponse, body: unknown): void => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};
const success = {
  choices: [
    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
};

describe("original HTTP provider", () => {
  it("sends explicit non-strict tools so Chat-to-Responses gateways preserve optional fields", async () => {
    let received: unknown;
    const provider = await fixture(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      received = JSON.parse(body);
      json(response, success);
    });
    const tools = nativeDefinitions.filter(tool => ["create_plan", "update_plan"].includes(tool.function.name));
    await provider.complete([{ role: "user", content: "Plan a task" }], tools, {
      model: "fixture", signal: new AbortController().signal, onText: () => {},
    });
    expect(received).toMatchObject({ tools: tools.map(tool => ({ ...tool, function: { ...tool.function, strict: false } })) });
    for (const tool of tools) expect(tool.function).not.toHaveProperty("strict");
  });
  it("sends images as native Chat Completions content parts and keeps text-only messages unchanged", async () => {
    let received: unknown;
    const provider = await fixture(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      received = JSON.parse(body);
      response.setHeader("content-type", "text/event-stream");
      response.end(`${event({ content: "seen" }, "stop")}data: [DONE]\n\n`);
    });
    await provider.complete([{ role: "user", content: "old" }, { role: "user", content: "", images: [image] }, { role: "user", content: "describe", images: [image] }], [], { model: "vision", signal: new AbortController().signal, onText: () => {} });
    expect(received).toMatchObject({ messages: [
      { role: "user", content: "old" },
      { role: "user", content: [{ type: "image_url", image_url: { url: image.dataUrl } }] },
      { role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: image.dataUrl } }] },
    ] });
    expect(JSON.stringify(received)).not.toContain(image.name);
  });
  it.each([
    [event({ content: "partial" }, "length"), "output_truncated"],
    [event({ content: "partial" }), "missing_finish"],
    ['data: {"choices":', "unterminated_event"],
    ['data: {"choices":[{"index":1,"delta":{}}]}\n\n', "invalid_chunk"],
  ])("reports a safe structural reason for an incomplete stream %#", async (wire, reason) => {
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream"); response.end(wire);
    });
    await expect(complete(provider)).rejects.toMatchObject({ classification: "protocol", reason });
  });
  it("reads context-window metadata and caches a loaded catalog without inventing unknown limits", async () => {
    let calls = 0;
    const provider = await fixture((_request, response) => {
      calls++;
      json(response, { data: [{ id: "alias", context_length: 32768 }, { id: "other", context_window: 64000 }, { id: "bad", max_model_len: -5 }] });
    });
    expect(await provider.getModelContextWindow!("alias")).toBe(32768);
    expect(await provider.getModelContextWindow!("other")).toBe(64000);
    expect(await provider.getModelContextWindow!("bad")).toBeNull();
    expect(await provider.getModelContextWindow!("missing")).toBeNull();
    expect(calls).toBe(1);
  });
  it("keeps configured input windows from gateway metadata instead of returning an unknown limit", async () => {
    let calls = 0;
    const provider = await fixture((_request, response) => {
      calls++;
      json(response, { data: [
        { id: "input-window", max_input_tokens: 1000000 },
        { id: "nested-window", top_provider: { context_length: 524288 } },
        { id: "string-window", context_window: "64000" },
        { id: "invalid-window", context_length: "300K", top_provider: false, max_output_tokens: 8192 },
      ] });
    });
    expect(await provider.getModelContextWindow!("input-window")).toBe(1000000);
    expect(await provider.getModelContextWindow!("nested-window")).toBe(524288);
    expect(await provider.getModelContextWindow!("string-window")).toBe(64000);
    expect(await provider.getModelContextWindow!("invalid-window")).toBeNull();
    expect(await provider.getModelContextWindow!("alias/input-window")).toBeNull();
    expect(calls).toBe(1);
  });
  it("joins paths, sends optional auth, deduplicates stable model IDs", async () => {
    const provider = await fixture((request, response) => {
      expect(request.url).toBe("/v1/models");
      expect(request.headers.authorization).toBe("Bearer fixture-token");
      json(response, {
        data: [{ id: "z" }, { id: "a", metadata: true }, { id: "z" }],
      });
    }, "fixture-token");
    expect(await provider.listModels()).toEqual(["a", "z"]);
    const anonymous = await fixture((request, response) => {
      expect(request.headers.authorization).toBeUndefined();
      json(response, { data: [{ id: "a" }] });
    });
    expect(await anonymous.listModels()).toEqual(["a"]);
  });

  it("handles split UTF8, CRLF, comments, multiline data and clean EOF", async () => {
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      const wire = Buffer.from(
        `: heartbeat\r\n\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"hé🌍"},"finish_reason":null}]}\r\n\r\n${event({}, "stop")}`,
      );
      for (const byte of wire) response.write(Buffer.from([byte]));
      response.end();
    });
    const pieces: string[] = [];
    const result = await complete(provider, undefined, (text) =>
      pieces.push(text),
    );
    expect(pieces.join("")).toBe("hé🌍");
    expect(result.message.content).toBe("hé🌍");
  });

  it("assembles parallel calls in index order and normalizes usage", async () => {
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write(
        event({
          tool_calls: [
            {
              index: 1,
              id: "second",
              type: "function",
              function: { name: "read", arguments: '{"b":' },
            },
            {
              index: 0,
              id: "first",
              type: "function",
              function: { name: "read", arguments: '{"a":' },
            },
          ],
        }),
      );
      response.write(
        event(
          {
            tool_calls: [
              { index: 0, function: { arguments: "1}" } },
              { index: 1, function: { arguments: "2}" } },
            ],
          },
          "tool_calls",
        ),
      );
      response.end(
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n',
      );
    });
    const result = await complete(provider);
    expect(result.message.content).toBeNull();
    expect(
      result.message.tool_calls?.map((call) => [
        call.id,
        call.function.arguments,
      ]),
    ).toEqual([
      ["first", '{"a":1}'],
      ["second", '{"b":2}'],
    ]);
    expect(result.usage).toEqual({
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5,
    });
  });

  it.each([
    event(
      {
        tool_calls: [
          {
            index: 0,
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      "tool_calls",
    ),
    event(
      {
        tool_calls: [
          { index: 0, id: "id", type: "function", function: { name: "read" } },
        ],
      },
      "tool_calls",
    ),
    event({ content: "clipped" }, "length"),
    event({ content: "filtered" }, "content_filter"),
    event({ content: "unfinished" }),
    "data: invalid\n\n",
    event({}, "stop"),
  ])("rejects invalid or incomplete response %#", async (wire) => {
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.end(wire);
    });
    await expect(complete(provider)).rejects.toMatchObject({
      classification: "protocol",
    });
  });

  it.each([401, 403, 404, 429, 503])(
    "redacts HTTP %i and never retries generation",
    async (status) => {
      let requests = 0;
      const provider = await fixture((_request, response) => {
        requests += 1;
        response.statusCode = status;
        response.end("private upstream fixture data".repeat(10000));
      });
      try {
        await complete(provider);
        throw new Error("Expected rejection");
      } catch (error: unknown) {
        expect(error).toMatchObject({
          status,
          classification: "http",
          retryable: status === 429 || status >= 500,
        });
        expect(String(error)).not.toContain("private upstream");
        expect(String(error).length).toBeLessThan(300);
      }
      expect(requests).toBe(1);
    },
  );

  it("aborts during streaming without replay", async () => {
    const controller = new AbortController();
    let requests = 0;
    const provider = await fixture((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "text/event-stream");
      response.write(event({ content: "started" }));
    });
    await expect(
      complete(provider, controller.signal, () => controller.abort()),
    ).rejects.toMatchObject({ classification: "aborted" });
    expect(requests).toBe(1);
  });

  it("times out after headers and initial output", async () => {
    let observed = false;
    const provider = await fixture(
      (_request, response) => {
        response.setHeader("content-type", "text/event-stream");
        response.write(event({ content: "started" }));
      },
      "",
      1000,
    );
    await expect(
      complete(provider, undefined, () => {
        observed = true;
      }),
    ).rejects.toMatchObject({ classification: "timeout" });
    expect(observed).toBe(true);
  });

  it("accepts nonstream JSON to a streaming request", async () => {
    const provider = await fixture((_request, response) =>
      json(response, success),
    );
    expect((await complete(provider)).message.content).toBe("ok");
  });

  it("falls back exactly once only for an explicit unsupported stream rejection", async () => {
    const streams: unknown[] = [];
    const provider = await fixture((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("stream" in parsed)
        )
          throw new Error("Invalid fixture request");
        streams.push(parsed.stream);
        if (parsed.stream === true) {
          response.statusCode = 400;
          json(response, {
            error: { message: "Streaming is not supported", param: "stream" },
          });
        } else json(response, success);
      });
    });
    expect((await complete(provider)).message.content).toBe("ok");
    expect(streams).toEqual([true, false]);
  });

  it("surfaces observer failure safely and does not retry", async () => {
    let requests = 0;
    const provider = await fixture((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "text/event-stream");
      response.write(event({ content: "started" }));
    });
    await expect(
      complete(provider, undefined, () => {
        throw new Error("private observer details");
      }),
    ).rejects.toMatchObject({
      classification: "observer",
      message: "The response observer failed.",
    });
    expect(requests).toBe(1);
  });

  it("rejects oversized metadata and malformed discovery", async () => {
    const malformed = await fixture((_request, response) =>
      json(response, { data: [{ id: 1 }] }),
    );
    await expect(malformed.listModels()).rejects.toMatchObject({
      classification: "protocol",
    });
    const oversized = await fixture((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ ...success, metadata: "x".repeat(8_000_001) }),
      );
    });
    await expect(complete(oversized)).rejects.toMatchObject({
      classification: "protocol",
    });
  });
});

describe("gateway repeated terminal choices", () => {
  const done = "data: [DONE]\n\ndata: [DONE]\n\n";
  const native = event(
    {
      tool_calls: [
        {
          index: 0,
          id: "call",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        },
      ],
    },
    "",
  );
  const terminal = (
    usage: unknown,
    delta: unknown = { role: "assistant", content: "" },
    reason = "tool_calls",
  ) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }], usage })}\n\n`;
  const estimated = {
    prompt_tokens: 7812,
    completion_tokens: 0,
    total_tokens: 7812,
    estimated: true,
  };
  const finalUsage = {
    prompt_tokens: 9812,
    completion_tokens: 132,
    total_tokens: 9812,
    reasoning_tokens: 74,
    estimated: true,
    prompt_tokens_details: {
      audio_tokens: 0,
      cached_tokens: 0,
      cache_write_tokens: 0,
    },
    completion_tokens_details: { audio_tokens: 0, reasoning_tokens: 74 },
  };

  it("accepts GLM repeated terminal choices and uses final usage without replay", async () => {
    let requests = 0;
    const provider = await fixture((_request, response) => {
      requests += 1;
      response.setHeader("content-type", "text/event-stream");
      response.end(
        native +
          terminal(estimated, {
            role: "assistant",
            content: "",
            reasoning: "",
          }) +
          terminal(finalUsage) +
          done,
      );
    });
    const result = await complete(provider);
    expect(result.message.tool_calls).toEqual([
      {
        id: "call",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ]);
    expect(result.usage).toEqual({
      promptTokens: 9812,
      completionTokens: 132,
      totalTokens: 9812,
      cachedPromptTokens: 0,
    });
    expect(requests).toBe(1);
  });

  it("accepts empty repeated stop without emitting text twice", async () => {
    const pieces: string[] = [];
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        event({ content: "ok" }, "stop") +
          event(
            { content: null, tool_calls: [], function_call: null },
            "stop",
          ) +
          done,
      );
    });
    expect(
      (await complete(provider, undefined, (text) => pieces.push(text))).message
        .content,
    ).toBe("ok");
    expect(pieces).toEqual(["ok"]);
  });

  it.each([
    terminal(finalUsage, {}, "stop"),
    terminal(finalUsage, {}, "length"),
    terminal(finalUsage, {}, ""),
    terminal(finalUsage, { content: "late" }),
    terminal(finalUsage, { tool_calls: [{ index: 0 }] }),
    terminal(finalUsage, {
      function_call: { name: "legacy", arguments: "{}" },
    }),
    done + terminal(finalUsage),
    done + event({ content: "late" }),
    done + event({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
  ])(
    "rejects conflicting or substantive terminal continuation %#",
    async (tail) => {
      const provider = await fixture((_request, response) => {
        response.setHeader("content-type", "text/event-stream");
        response.end(native + terminal(estimated) + tail);
      });
      await expect(complete(provider)).rejects.toMatchObject({
        classification: "protocol",
      });
    },
  );

  it.each([
    event({}, "tool_calls"),
    event(
      {
        tool_calls: [
          {
            index: 0,
            id: "call",
            type: "function",
            function: { name: "read_file", arguments: "{" },
          },
        ],
      },
      "tool_calls",
    ),
    native + event({}, "length"),
  ])(
    "repetition does not rescue incomplete or invalid completion %#",
    async (prefix) => {
      const provider = await fixture((_request, response) => {
        response.setHeader("content-type", "text/event-stream");
        response.end(prefix + terminal(finalUsage) + done);
      });
      await expect(complete(provider)).rejects.toMatchObject({
        classification: "protocol",
      });
    },
  );
});

describe("nullable cache usage compatibility", () => {
  const cases = [
    { metadata: { prompt_tokens_details: null }, expected: undefined },
    { metadata: { cached_tokens: null }, expected: undefined },
    {
      metadata: {
        prompt_tokens_details: { cached_tokens: null, audio_tokens: 0 },
        cached_tokens: null,
      },
      expected: undefined,
    },
    {
      metadata: { prompt_tokens_details: null, cached_tokens: 0 },
      expected: 0,
    },
    {
      metadata: {
        prompt_tokens_details: { cached_tokens: null },
        cached_tokens: 42,
      },
      expected: 42,
    },
    {
      metadata: {
        prompt_tokens_details: { cached_tokens: 0 },
        cached_tokens: 42,
      },
      expected: 0,
    },
    {
      metadata: {
        prompt_tokens_details: { cached_tokens: 72 },
        cached_tokens: 42,
      },
      expected: 72,
    },
    {
      metadata: {
        prompt_tokens_details: { audio_tokens: 0 },
        cached_tokens: null,
      },
      expected: undefined,
    },
  ];
  for (const mode of ["stream", "json"]) {
    it.each(cases)(
      `${mode} treats null as unreported and preserves numeric precedence %#`,
      async ({ metadata, expected }) => {
        const usage = {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          ...metadata,
        };
        const provider = await fixture((_request, response) => {
          if (mode === "json") json(response, { ...success, usage });
          else {
            response.setHeader("content-type", "text/event-stream");
            response.end(
              `${event({ content: "ok" }, "stop")}data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
            );
          }
        });
        const result = await complete(provider);
        expect(result.usage).toEqual({
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          ...(expected === undefined ? {} : { cachedPromptTokens: expected }),
        });
        if (expected === undefined)
          expect(result.usage).not.toHaveProperty("cachedPromptTokens");
      },
    );
  }
});

describe("gateway captured-shape compatibility", () => {
  const repeatedDone = "data: [DONE]\n\ndata: [DONE]\n\n";

  it.each(["stop", "tool_calls"])(
    "accepts duplicated DONE after valid %s exactly once without replay",
    async (finish) => {
      let requests = 0;
      const pieces: string[] = [];
      const provider = await fixture((_request, response) => {
        requests += 1;
        response.setHeader("content-type", "text/event-stream");
        const wire =
          finish === "stop"
            ? event({ content: "ok" }, "stop")
            : event(
                {
                  reasoning_content: "inspect",
                  function_call: null,
                  extra_fields: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: "native",
                      type: "function",
                      function: { name: "read_file", arguments: "" },
                    },
                  ],
                },
                "",
              ) +
              event(
                {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        name: "",
                        arguments: '{"path":"src/core/runtime.ts"}',
                      },
                    },
                  ],
                },
                "tool_calls",
              );
        response.end(wire + repeatedDone);
      });
      const result = await complete(provider, undefined, (text) =>
        pieces.push(text),
      );
      expect(requests).toBe(1);
      if (finish === "stop") {
        expect(result.message.content).toBe("ok");
        expect(pieces).toEqual(["ok"]);
      } else {
        expect(result.message.tool_calls).toHaveLength(1);
        expect(result.message.tool_calls?.[0]?.function.arguments).toBe(
          '{"path":"src/core/runtime.ts"}',
        );
      }
    },
  );

  it.each([
    repeatedDone,
    event({ content: "unfinished" }, "") + repeatedDone,
    event({ content: "clipped" }, "length") + repeatedDone,
    event(
      {
        tool_calls: [
          {
            index: 0,
            id: "bad",
            type: "function",
            function: { name: "read", arguments: "{" },
          },
        ],
      },
      "tool_calls",
    ) + repeatedDone,
    event({ content: "ok" }, "stop") +
      repeatedDone +
      event({ content: "late" }),
    event({ content: "ok" }, "stop") +
      repeatedDone +
      event({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
    event({ content: "ok" }, "stop") +
      event({ content: "late" }) +
      repeatedDone,
  ])(
    "does not let duplicate DONE legitimize invalid finishes or post-terminal data",
    async (wire) => {
      let requests = 0;
      const provider = await fixture((_request, response) => {
        requests += 1;
        response.setHeader("content-type", "text/event-stream");
        response.end(wire);
      });
      await expect(complete(provider)).rejects.toMatchObject({
        classification: "protocol",
      });
      expect(requests).toBe(1);
    },
  );
  it("accepts empty nonterminal finishes, reasoning/metadata, null optionals and indexed fragments at EOF", async () => {
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write(
        event(
          {
            role: "assistant",
            content: null,
            reasoning_content: "Inspect the source first.",
            function_call: null,
            refusal: "",
            extra_fields: null,
            tool_calls: null,
          },
          "",
        ),
      );
      response.write(
        event(
          {
            reasoning_content: "",
            function_call: { name: "", arguments: "" },
            tool_calls: [
              {
                index: 0,
                id: "gateway-call",
                type: "function",
                function: { name: "read_file", arguments: '{"path":' },
              },
            ],
          },
          "",
        ),
      );
      response.write(
        event(
          {
            content: null,
            tool_calls: [
              {
                index: 0,
                function: { name: "", arguments: '"src/core/runtime.ts"}' },
              },
            ],
          },
          "",
        ),
      );
      response.write(
        event({ function_call: null, tool_calls: null }, "tool_calls"),
      );
      response.end(
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"cached_tokens":50,"prompt_tokens_details":{"cached_tokens":50}},"extra_fields":null}\n\n',
      );
    });
    const result = await complete(provider);
    expect(result.message.tool_calls).toEqual([
      {
        id: "gateway-call",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"path":"src/core/runtime.ts"}',
        },
      },
    ]);
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 50,
    });
  });

  it("accepts gateways that echo role: null on every delta", async () => {
    const pieces: string[] = [];
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        event({ role: null, content: null }, "") +
          event({ role: null, content: "o" }, "") +
          event({ role: null, content: "k" }, "") +
          event({ role: null, content: "", tool_calls: null }, "stop") +
          repeatedDone,
      );
    });
    const result = await complete(provider, undefined, (text) =>
      pieces.push(text),
    );
    expect(result.message.content).toBe("ok");
    expect(pieces).toEqual(["o", "k"]);
  });

  it.each(["user", "system", "", "tool"])(
    "still rejects a non-assistant delta role %j",
    async (role) => {
      const provider = await fixture((_request, response) => {
        response.setHeader("content-type", "text/event-stream");
        response.end(event({ role, content: "ok" }, "stop") + repeatedDone);
      });
      await expect(complete(provider)).rejects.toMatchObject({
        classification: "protocol",
        message: expect.stringContaining("[protocol]"),
      });
    },
  );

  it.each([
    {
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      expected: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    },
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 0 },
      },
      expected: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedPromptTokens: 0,
      },
    },
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cached_tokens: 0,
      },
      expected: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedPromptTokens: 0,
      },
    },
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40 },
      },
      expected: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedPromptTokens: 40,
      },
    },
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cached_tokens: 30,
      },
      expected: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedPromptTokens: 30,
      },
    },
  ])(
    "normalizes gateway cache usage missing vs zero vs positive %#",
    async ({ usage, expected }) => {
      const provider = await fixture((_request, response) => {
        response.setHeader("content-type", "text/event-stream");
        response.write(event({ content: "ok" }, "stop"));
        response.end(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      });
      expect((await complete(provider)).usage).toEqual(expected);
    },
  );

  it.each([
    event({ content: "unfinished", tool_calls: null }, ""),
    event(
      {
        content: "ok",
        function_call: { name: "legacy_effect", arguments: "{}" },
      },
      "stop",
    ),
    event({ content: "ok", tool_calls: {} }, "stop"),
    event({ content: "ok" }, "stop") + event({ content: "late" }, ""),
  ])("keeps truncated and ambiguous sequences rejected", async (wire) => {
    const provider = await fixture((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.end(wire);
    });
    await expect(complete(provider)).rejects.toMatchObject({
      classification: "protocol",
      message: expect.stringContaining("[protocol]"),
    });
  });
});

it("sends reconciliation content without local origin and preserves chat tool references", async () => {
  const requests: unknown[] = [];
  const provider = await fixture(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "text/event-stream");
    response.end(event({ content: "ok" }) + event({}, "stop"));
  });
  const calls = [
    {
      id: "call_1",
      type: "function" as const,
      function: { name: "lookup", arguments: "{}" },
    },
  ];
  await provider.complete(
    [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: null, tool_calls: calls },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      {
        role: "user",
        content: "Retain this context",
        origin: "agent_reconciliation",
      },
    ],
    [],
    {
      model: "fixture-model",
      signal: new AbortController().signal,
      onText: () => {},
    },
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: null, tool_calls: calls },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "user", content: "Retain this context" },
    ],
  });
  expect((requests[0] as { messages: unknown[] }).messages).toEqual([
    { role: "system", content: "system" },
    { role: "user", content: "first" },
    { role: "assistant", content: null, tool_calls: calls },
    { role: "tool", tool_call_id: "call_1", content: "result" },
    { role: "user", content: "Retain this context" },
  ]);
});
