import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import type { ModelProvider } from "../../src/shared/contracts";
import type { ToolCallPreview } from "../../src/shared/schemas";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

// Local HTTP fixture only: no real provider, credentials or network config.
async function fixture(
  handler: Handler,
  apiMode: "chat-completions" | "responses" = "chat-completions",
): Promise<ModelProvider> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    requestTimeoutMs: 5000,
    apiMode,
  });
}

const tools = [
  {
    type: "function" as const,
    function: {
      name: "lookup",
      description: "search",
      parameters: { type: "object" as const },
    },
  },
];

const complete = (
  provider: ModelProvider,
  onToolCall: (preview: ToolCallPreview) => void,
  signal = new AbortController().signal,
) =>
  provider.complete([{ role: "user", content: "hello" }], tools, {
    model: "fixture-model",
    signal,
    onText: () => {},
    onToolCall,
  });

const drain = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
};

const sse = (response: ServerResponse): void => {
  response.setHeader("content-type", "text/event-stream");
};

const chunk = (delta: object, finish: string | null = null): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;

const wire = (type: string, fields: object = {}): string =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
};

// Polls instead of sleeping a fixed delay so the assertion really observes the
// paused stream window rather than a timing coincidence.
const waitFor = async (
  check: () => boolean,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const args = '{"query":"hi"}';

it("emits cumulative Chat Completions previews before complete resolves", async () => {
  const gate = deferred();
  let requests = 0;
  const provider = await fixture(async (request, response) => {
    requests += 1;
    await drain(request);
    sse(response);
    // Name plus a partial argument fragment; terminal frames stay withheld.
    response.write(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query"' },
          },
        ],
      }),
    );
    response.write(
      chunk({ tool_calls: [{ index: 0, function: { arguments: ":" } }] }),
    );
    await gate.promise;
    response.write(
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }),
    );
    response.write(chunk({}, "tool_calls"));
    response.end("data: [DONE]\n\n");
  });

  const previews: ToolCallPreview[] = [];
  const task = complete(provider, (preview) => previews.push(preview));
  let settled = false;
  void task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await waitFor(
    () => previews.length >= 2,
    "no preview was observable while the stream was paused",
  );
  expect(settled).toBe(false);
  expect(previews).toEqual([
    { index: 0, name: "lookup", argumentsChars: 8 },
    { index: 0, name: "lookup", argumentsChars: 9 },
  ]);

  gate.resolve();
  const result = await task;
  expect(requests).toBe(1);
  expect(previews).toEqual([
    { index: 0, name: "lookup", argumentsChars: 8 },
    { index: 0, name: "lookup", argumentsChars: 9 },
    { index: 0, name: "lookup", argumentsChars: args.length },
  ]);
  // The preview never carries raw argument text.
  expect(JSON.stringify(previews)).not.toContain("query");
  expect(JSON.stringify(previews)).not.toContain("hi");
  // The final assembled call is untouched by the preview plumbing.
  expect(result.message.tool_calls).toEqual([
    {
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: args },
    },
  ]);
});

it("emits one complete Chat Completions preview for a non-streaming JSON reply", async () => {
  const provider = await fixture(async (request, response) => {
    await drain(request);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: args },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
  });

  const previews: ToolCallPreview[] = [];
  const result = await complete(provider, (preview) => previews.push(preview));
  expect(previews).toEqual([
    { index: 0, name: "lookup", argumentsChars: args.length },
  ]);
  expect(result.message.tool_calls?.[0]).toEqual({
    id: "call_1",
    type: "function",
    function: { name: "lookup", arguments: args },
  });
});

it("isolates a failing preview observer to the observer classification", async () => {
  let requests = 0;
  const provider = await fixture(async (request, response) => {
    requests += 1;
    await drain(request);
    sse(response);
    response.end(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: args },
            },
          ],
        },
        "tool_calls",
      ) + "data: [DONE]\n\n",
    );
  });
  await expect(
    complete(provider, () => {
      throw new Error("private preview observer details");
    }),
  ).rejects.toMatchObject({
    classification: "observer",
    message: "The response observer failed.",
  });
  expect(requests).toBe(1);
});

it("emits Responses previews keyed by tool sequence and completes a missing name", async () => {
  const gate = deferred();
  const reason = { type: "reasoning", id: "r_1", summary: [] };
  const finished = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "lookup",
    arguments: args,
    status: "completed",
  };
  const provider = await fixture(async (request, response) => {
    await drain(request);
    sse(response);
    // A reasoning item occupies output_index 0, so the tool must not inherit it.
    response.write(
      wire("response.output_item.added", {
        output_index: 0,
        item: { ...reason, status: "in_progress" },
      }),
    );
    response.write(
      wire("response.output_item.done", { output_index: 0, item: reason }),
    );
    // The added frame legitimately omits the tool name.
    response.write(
      wire("response.output_item.added", {
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          arguments: "",
          status: "in_progress",
        },
      }),
    );
    response.write(
      wire("response.function_call_arguments.delta", {
        output_index: 1,
        item_id: "fc_1",
        delta: '{"query":',
      }),
    );
    response.write(
      wire("response.function_call_arguments.delta", {
        output_index: 1,
        item_id: "fc_1",
        delta: '"hi"}',
      }),
    );
    await gate.promise;
    response.write(
      wire("response.function_call_arguments.done", {
        output_index: 1,
        item_id: "fc_1",
        arguments: args,
      }),
    );
    response.write(
      wire("response.output_item.done", { output_index: 1, item: finished }),
    );
    response.end(
      wire("response.completed", {
        response: { id: "resp_1", status: "completed", output: [reason, finished] },
      }) + "data: [DONE]\n\n",
    );
  }, "responses");

  const previews: ToolCallPreview[] = [];
  const task = complete(provider, (preview) => previews.push(preview));
  let settled = false;
  void task.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await waitFor(
    () => previews.length >= 3,
    "no Responses preview was observable while the stream was paused",
  );
  expect(settled).toBe(false);
  expect(previews).toEqual([
    { index: 0, name: "", argumentsChars: 0 },
    { index: 0, name: "", argumentsChars: 9 },
    { index: 0, name: "", argumentsChars: args.length },
  ]);

  gate.resolve();
  const result = await task;
  expect(previews).toEqual([
    { index: 0, name: "", argumentsChars: 0 },
    { index: 0, name: "", argumentsChars: 9 },
    { index: 0, name: "", argumentsChars: args.length },
    { index: 0, name: "lookup", argumentsChars: args.length },
  ]);
  expect(JSON.stringify(previews)).not.toContain("query");
  expect(result.message.tool_calls).toEqual([
    {
      id: "call_1",
      type: "function",
      function: { name: "lookup", arguments: args },
    },
  ]);
  // The reasoning item is still replayed unchanged through providerState.
  expect(result.message.providerState).toMatchObject({
    apiMode: "responses",
    output: [reason, finished],
  });
});

it("estimates write_file lines live without leaking Chat Completions arguments", async () => {
  const gate = deferred();
  const written = '{"path":"a.ts","content":"one\\ntwo\\nthree"}';
  const provider = await fixture(async (request, response) => {
    await drain(request);
    sse(response);
    response.write(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "write_file", arguments: '{"path":"a.ts"' },
          },
        ],
      }),
    );
    // Mid-stream: the content string is still open but already countable.
    response.write(
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: ',"content":"one\\ntwo' } },
        ],
      }),
    );
    await gate.promise;
    response.write(
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '\\nthree"}' } }],
      }),
    );
    response.write(chunk({}, "tool_calls"));
    response.end("data: [DONE]\n\n");
  });

  const previews: ToolCallPreview[] = [];
  const task = complete(provider, (preview) => previews.push(preview));
  await waitFor(
    () => previews.length >= 2,
    "no write_file line estimate was observable while streaming",
  );
  // Only bounded counters cross the boundary; the content never does.
  expect(JSON.stringify(previews)).not.toContain("one");
  expect(previews.at(-1)).toMatchObject({ index: 0, name: "write_file" });
  expect(previews.at(-1)?.linesAdded).toBeGreaterThanOrEqual(2);
  expect(previews.at(-1)?.linesRemoved).toBeUndefined();

  gate.resolve();
  const result = await task;
  expect(previews.at(-1)).toMatchObject({
    index: 0,
    name: "write_file",
    argumentsChars: written.length,
    linesAdded: 3,
  });
  expect(previews.at(-1)?.linesRemoved).toBeUndefined();
  expect(result.message.tool_calls?.[0]?.function.arguments).toBe(written);
});

it("estimates both edit_file directions from Responses argument deltas", async () => {
  const gate = deferred();
  const args =
    '{"path":"a.ts","old_text":"gone\\nold","new_text":"one\\ntwo\\nthree"}';
  const finished = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "edit_file",
    arguments: args,
    status: "completed",
  };
  const provider = await fixture(async (request, response) => {
    await drain(request);
    sse(response);
    response.write(
      wire("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "edit_file",
          arguments: "",
          status: "in_progress",
        },
      }),
    );
    response.write(
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_1",
        delta: '{"path":"a.ts","old_text":"gone\\nold"',
      }),
    );
    await gate.promise;
    response.write(
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_1",
        delta: ',"new_text":"one\\ntwo\\nthree"}',
      }),
    );
    response.write(
      wire("response.function_call_arguments.done", {
        output_index: 0,
        item_id: "fc_1",
        arguments: args,
      }),
    );
    response.write(
      wire("response.output_item.done", { output_index: 0, item: finished }),
    );
    response.end(
      wire("response.completed", {
        response: { id: "resp_1", status: "completed", output: [finished] },
      }) + "data: [DONE]\n\n",
    );
  }, "responses");

  const previews: ToolCallPreview[] = [];
  const task = complete(provider, (preview) => previews.push(preview));
  await waitFor(
    () => previews.some((preview) => preview.linesRemoved === 2),
    "no edit_file removal estimate was observable while streaming",
  );
  expect(previews.at(-1)).toMatchObject({
    index: 0,
    name: "edit_file",
    linesRemoved: 2,
  });
  expect(previews.at(-1)?.linesAdded).toBeUndefined();

  gate.resolve();
  await task;
  expect(previews.at(-1)).toMatchObject({
    index: 0,
    name: "edit_file",
    argumentsChars: args.length,
    linesAdded: 3,
    linesRemoved: 2,
  });
  expect(JSON.stringify(previews)).not.toContain("gone");
});
