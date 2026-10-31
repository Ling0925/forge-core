import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { getCompileCacheDir, registerHooks } from "node:module";

const apiMode = process.argv[2];
const imports = [];
const loaded = [];
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^(openai|@anthropic-ai\/sdk)(\/|$)/.test(specifier))
      imports.push(specifier);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (/\/(openai|@anthropic-ai\/sdk)\//.test(url)) loaded.push(url);
    return nextLoad(url, context);
  },
});

const { createHarness } = await import("../../dist/core/harness.js");
assert.deepEqual(loaded, []);
const harness = await createHarness();
try {
  assert.deepEqual(await harness.listSessions(), []);
  assert.deepEqual(loaded, []);
  await import("../../dist/index.js");
  assert.equal(getCompileCacheDir(), undefined);
} finally {
  await harness.dispose();
}

const { createModelProvider } = await import("../../dist/provider/openai.js");
const { defaultPublicSettings } = await import("../../dist/shared/schemas.js");
const model = "fixture";
let reject = false;
const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
const server = createServer((request, response) => {
  if (reject) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "PRIVATE_UPSTREAM" } }));
  } else if (request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        apiMode === "gemini"
          ? { models: [{ name: `models/${model}` }] }
          : { data: [{ id: model }], has_more: false },
      ),
    );
  } else {
    response.setHeader("content-type", "text/event-stream");
    const events =
      apiMode === "anthropic"
        ? [
            { type: "message_start", message: { content: [] } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]
        : apiMode === "responses"
          ? [
              {
                type: "response.completed",
                response: {
                  id: "response_fixture",
                  status: "completed",
                  output: [
                    {
                      type: "message",
                      id: "message_fixture",
                      role: "assistant",
                      status: "completed",
                      content: [{ type: "output_text", text: "ok" }],
                    },
                  ],
                },
              },
            ]
          : apiMode === "gemini"
            ? [
                {
                  candidates: [
                    {
                      content: { parts: [{ text: "ok" }] },
                      finishReason: "STOP",
                    },
                  ],
                },
              ]
            : [
                {
                  choices: [
                    {
                      index: 0,
                      delta: { content: "ok" },
                      finish_reason: "stop",
                    },
                  ],
                },
              ];
    response.end(events.map(sse).join(""));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const config = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: "fixture-key",
    apiMode,
    requestTimeoutMs: defaultPublicSettings.requestTimeoutMs,
  };
  const provider = createModelProvider(config);
  assert.deepEqual(imports, []);
  assert.deepEqual(loaded, []);
  await assert.rejects(provider.listModels(AbortSignal.abort()), {
    classification: "aborted",
    message: "The provider request was cancelled.",
  });

  assert.deepEqual(
    await Promise.all([provider.listModels(), provider.listModels()]),
    [[model], [model]],
  );
  const sdk = apiMode === "anthropic" ? "@anthropic-ai/sdk" : "openai";
  assert.equal(
    imports.filter((name) => name === sdk).length,
    apiMode === "gemini" ? 0 : 1,
  );
  assert(
    !loaded.some((url) =>
      url.includes(
        apiMode === "anthropic" ? "/openai/" : "/@anthropic-ai/sdk/",
      ),
    ),
  );
  if (apiMode === "gemini") assert.deepEqual(loaded, []);

  const complete = () =>
    provider.complete([{ role: "user", content: "hello" }], [], {
      model,
      signal: new AbortController().signal,
      onText: () => {},
    });
  for (const result of await Promise.all([complete(), complete()]))
    assert.equal(result.message.content, "ok");
  assert.equal(
    imports.filter((name) => name === sdk).length,
    apiMode === "gemini" ? 0 : 1,
  );
  assert.equal(
    imports.filter((name) => name === "openai/core/streaming").length,
    1,
  );

  reject = true;
  const failure = {
    classification: "http",
    status: 401,
    retryable: false,
    message:
      "Provider authorization was rejected. Check provider credentials and access. [http HTTP 401]",
  };
  await assert.rejects(complete(), failure);
  assert.equal(
    imports.filter((name) => name === "openai").length,
    apiMode === "chat-completions" || apiMode === "responses" ? 1 : 0,
  );
  assert.equal(
    imports.filter((name) => name === "@anthropic-ai/sdk").length,
    apiMode === "anthropic" ? 1 : 0,
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  hooks.deregister();
}
