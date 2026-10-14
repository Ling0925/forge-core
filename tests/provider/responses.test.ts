import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { ProviderError, createModelProvider } from "../../src/provider/openai";
import type { Message } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
const requestBody = z
  .object({
    input: z.array(z.unknown()),
    tools: z.array(z.unknown()),
    store: z.boolean(),
  })
  .passthrough();

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    const done = new Promise<void>((resolve) => s.close(() => resolve()));
    s.closeAllConnections();
    await done;
  }
});
const wire = (type: string, fields: object = {}) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
const msg = (id: string, text: string) => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const call = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "lookup",
  arguments: '{"query":"hi"}',
  status: "completed",
};
const usage = {
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 14,
  input_tokens_details: { cached_tokens: 3 },
};
const completed = (output: unknown[]) =>
  wire("response.completed", {
    response: { id: "resp_1", status: "completed", output, usage },
  });
const item = (output_index: number, value: object) =>
  wire("response.output_item.added", { output_index, item: value });
const done = (output_index: number, value: object) =>
  wire("response.output_item.done", { output_index, item: value });
const textStream = (text: string) => {
  const m = msg("m_1", text);
  return (
    wire("response.created", {
      response: { id: "resp_1", status: "in_progress" },
    }) +
    wire("response.in_progress", {
      response: { id: "resp_1", status: "in_progress" },
    }) +
    item(0, {
      type: "message",
      id: m.id,
      role: "assistant",
      status: "in_progress",
      content: [],
    }) +
    wire("response.content_part.added", {
      output_index: 0,
      content_index: 0,
      item_id: m.id,
      part: { type: "output_text", text: "" },
    }) +
    wire("response.output_text.delta", {
      output_index: 0,
      item_id: "m_1",
      content_index: 0,
      delta: text,
    }) +
    wire("response.output_text.done", {
      output_index: 0,
      content_index: 0,
      item_id: m.id,
      text,
    }) +
    wire("response.content_part.done", {
      output_index: 0,
      content_index: 0,
      item_id: m.id,
      part: m.content[0],
    }) +
    done(0, m) +
    completed([m])
  );
};
async function setup(
  handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void,
  mode: "responses" | "chat-completions" = "responses",
  timeout = 2000,
) {
  const s = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c.toString();
    handler(req, res, JSON.parse(body));
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const a = s.address();
  if (!a || typeof a === "string") throw Error("address");
  return createModelProvider({
    baseUrl: `http://127.0.0.1:${a.port}/v1`,
    apiKey: "",
    requestTimeoutMs: timeout,
    apiMode: mode,
  });
}
const send = (res: ServerResponse, data: string) => {
  res.setHeader("content-type", "text/event-stream");
  res.end(data);
};
const run = (
  p: Awaited<ReturnType<typeof setup>>,
  history: readonly Message[] = [{ role: "user", content: "hello" }],
  signal?: AbortSignal,
  onText = (_: string) => {},
  model = "m",
) =>
  p.complete(
    history,
    [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "search",
          parameters: { type: "object" },
        },
      },
    ],
    { model, onText, signal: signal ?? new AbortController().signal },
  );
const classification = (kind: string) => (e: unknown) =>
  e instanceof ProviderError && e.classification === kind;

it("streams text, native function call arguments and tool output continuation, retaining opaque reasoning", async () => {
  const bodies: unknown[] = [];
  const reason = {
    type: "reasoning",
    id: "r_1",
    summary: [],
    encrypted_content: "opaque",
  };
  const provider = await setup((req, res, body) => {
    expect(req.url).toBe("/v1/responses");
    bodies.push(requestBody.parse(body));
    if (bodies.length === 1) {
      const m = msg("m_1", "checking");
      send(
        res,
        item(0, reason) +
          done(0, reason) +
          item(1, m) +
          wire("response.output_text.delta", {
            output_index: 1,
            item_id: "m_1",
            content_index: 0,
            delta: "checking",
          }) +
          done(1, m) +
          item(2, { ...call, arguments: "", status: "in_progress" }) +
          wire("response.function_call_arguments.delta", {
            output_index: 2,
            item_id: "fc_1",
            delta: '{"query":',
          }) +
          wire("response.function_call_arguments.delta", {
            output_index: 2,
            item_id: "fc_1",
            delta: '"hi"}',
          }) +
          wire("response.function_call_arguments.done", {
            output_index: 2,
            item_id: "fc_1",
            arguments: call.arguments,
          }) +
          done(2, call) +
          completed([reason, m, call]),
      );
    } else send(res, textStream("result"));
  });
  const deltas: string[] = [];
  const first = await run(provider, undefined, undefined, (t) =>
    deltas.push(t),
  );
  expect(deltas).toEqual(["checking"]);
  expect(first.usage).toEqual({
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
    cachedPromptTokens: 3,
  });
  expect(first.message.tool_calls?.[0]).toEqual({
    id: "call_1",
    type: "function",
    function: { name: "lookup", arguments: call.arguments },
  });
  const second = await run(provider, [
    { role: "user", content: "hello" },
    first.message,
    { role: "tool", tool_call_id: "call_1", content: "found" },
  ]);
  expect(second.message.content).toBe("result");
  expect(requestBody.parse(bodies[0]).tools[0]).toEqual({
    type: "function",
    name: "lookup",
    description: "search",
    parameters: { type: "object" },
    strict: false,
  });
  expect(requestBody.parse(bodies[0]).store).toBe(false);
  expect(requestBody.parse(bodies[1]).input).toEqual([
    { role: "user", content: "hello" },
    reason,
    msg("m_1", "checking"),
    call,
    { type: "function_call_output", call_id: "call_1", output: "found" },
  ]);
});

it("rejects conflicting terminal function identity before returning a call", async () => {
  const original = { ...call, name: "read_file", call_id: "call-original" };
  const changed = { ...original, name: "delete_file", call_id: "call-changed" };
  const p = await setup((_req, res) =>
    send(
      res,
      item(0, { ...original, arguments: "", status: "in_progress" }) +
        wire("response.function_call_arguments.delta", {
          output_index: 0,
          item_id: original.id,
          delta: original.arguments,
        }) +
        done(0, original) +
        completed([changed]),
    ),
  );
  await expect(run(p)).rejects.toSatisfy(classification("protocol"));
});

it("replays same-text reasoning only from matching message origin across new adapters", async () => {
  const bodies: unknown[] = [];
  let counter = 0;
  const p = await setup((_req, res, body) => {
    bodies.push(requestBody.parse(body));
    counter++;
    const reason = {
      type: "reasoning",
      id: `reason-${counter}`,
      summary: [],
      encrypted_content: `opaque-${counter}`,
    };
    const m = msg(`message-${counter}`, "same text");
    send(
      res,
      item(0, reason) +
        done(0, reason) +
        item(1, m) +
        wire("response.output_text.delta", {
          output_index: 1,
          item_id: m.id,
          content_index: 0,
          delta: "same text",
        }) +
        done(1, m) +
        completed([reason, m]),
    );
  });
  const a = (await run(p)).message;
  const b = (await run(p)).message;
  expect(a.content).toBe(b.content);
  expect(a.providerState?.output).not.toEqual(b.providerState?.output);
  await run(p, [
    { role: "user", content: "hello" },
    a,
    { role: "user", content: "next" },
  ]);
  await run(p, [
    { role: "user", content: "hello" },
    b,
    { role: "user", content: "next" },
  ]);
  expect(requestBody.parse(bodies[2]).input[1]).toEqual(
    a.providerState?.output[0],
  );
  expect(requestBody.parse(bodies[3]).input[1]).toEqual(
    b.providerState?.output[0],
  );
  const switched = [
    { role: "user", content: "hello" } as const,
    a,
    { role: "user", content: "next" } as const,
  ];
  await p.complete(switched, [], {
    model: "other",
    onText: () => {},
    signal: new AbortController().signal,
  });
  expect(requestBody.parse(bodies[4]).input).toEqual([
    switched[0],
    { role: "assistant", content: "same text" },
    switched[2],
  ]);
});

it.each(["response.failed", "response.incomplete", "error"])(
  "rejects %s without retries",
  async (type) => {
    let requests = 0;
    const p = await setup((_req, res) => {
      requests++;
      send(
        res,
        wire(type, {
          response: { status: "failed" },
          error: { message: "secret error" },
        }),
      );
    });
    await expect(run(p)).rejects.toSatisfy(classification("protocol"));
    expect(requests).toBe(1);
  },
);
it("rejects EOF without completion and malformed ids, arguments and terminal text", async () => {
  const invalid = [
    item(0, msg("m_1", "x")),
    item(0, { ...call, arguments: "", status: "in_progress" }) +
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "unknown",
        delta: call.arguments,
      }) +
      done(0, call) +
      completed([call]),
    item(0, { ...call, arguments: "", status: "in_progress" }) +
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: "fc_1",
        delta: "{",
      }) +
      done(0, { ...call, arguments: "{" }) +
      completed([{ ...call, arguments: "{" }]),
    textStream("ok").replace('"delta":"ok"', '"delta":"other"'),
  ];
  for (const data of invalid) {
    const p = await setup((_req, res) => send(res, data));
    await expect(run(p)).rejects.toSatisfy(classification("protocol"));
  }
});
it("rejects non-stream JSON and HTTP failures without fallback", async () => {
  for (const status of [200, 400, 500]) {
    let requests = 0;
    const p = await setup((_req, res) => {
      requests++;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end('{"error":{"message":"sensitive"}}');
    });
    await expect(run(p)).rejects.toSatisfy(
      classification(status === 200 ? "protocol" : "http"),
    );
    expect(requests).toBe(1);
  }
});
it("cancels and times out after stream headers without replay", async () => {
  for (const cancel of [true, false]) {
    let requests = 0;
    const controller = new AbortController();
    const p = await setup(
      (_req, res) => {
        requests++;
        res.setHeader("content-type", "text/event-stream");
        res.write(": heartbeat\n\n");
        if (cancel) setTimeout(() => controller.abort(), 20);
      },
      "responses",
      1000,
    );
    await expect(
      run(p, undefined, cancel ? controller.signal : undefined),
    ).rejects.toSatisfy(classification(cancel ? "aborted" : "timeout"));
    expect(requests).toBe(1);
  }
});
it("omitted apiMode retains original Chat Completions route", async () => {
  const s = createServer((req, res) => {
    expect(req.url).toBe("/v1/chat/completions");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  servers.push(s);
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const a = s.address();
  if (!a || typeof a === "string") throw Error("address");
  const p = createModelProvider({
    baseUrl: `http://127.0.0.1:${a.port}/v1`,
    apiKey: "",
    requestTimeoutMs: 2000,
  });
  expect((await run(p)).message.content).toBe("ok");
});

it("migrates completed native tool history across model and endpoint, never foreign reasoning", async () => {
  const bodies: unknown[] = [];
  const origin = await setup((_req, res) =>
    send(
      res,
      item(0, {
        type: "reasoning",
        id: "r",
        summary: [],
        encrypted_content: "opaque",
      }) +
        done(0, {
          type: "reasoning",
          id: "r",
          summary: [],
          encrypted_content: "opaque",
        }) +
        item(1, { ...call, arguments: "", status: "in_progress" }) +
        wire("response.function_call_arguments.delta", {
          output_index: 1,
          item_id: call.id,
          delta: call.arguments,
        }) +
        wire("response.function_call_arguments.done", {
          output_index: 1,
          item_id: call.id,
          arguments: call.arguments,
        }) +
        done(1, call) +
        completed([
          {
            type: "reasoning",
            id: "r",
            summary: [],
            encrypted_content: "opaque",
          },
          call,
        ]),
    ),
  );
  const first = (await run(origin)).message;
  const history: Message[] = [
    { role: "user", content: "hello" },
    first,
    { role: "tool", tool_call_id: call.call_id, content: "found" },
    { role: "assistant", content: "completed task" },
    { role: "user", content: "another task" },
  ];
  await run(origin, history);
  const foreign = await setup((_req, res, body) => {
    bodies.push(requestBody.parse(body));
    send(res, textStream("done"));
  });
  await run(origin, history, undefined, undefined, "other-model");
  await run(foreign, history);
  for (const body of bodies) {
    expect(requestBody.parse(body).input).toEqual([
      { role: "user", content: "hello" },
      {
        type: "function_call",
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
      },
      { type: "function_call_output", call_id: call.call_id, output: "found" },
      { role: "assistant", content: "completed task" },
      { role: "user", content: "another task" },
    ]);
  }
  await expect(run(foreign, history.slice(0, 2))).rejects.toSatisfy(
    classification("protocol"),
  );
  await expect(
    run(origin, history.slice(0, 2), undefined, undefined, "other-model"),
  ).rejects.toSatisfy(classification("protocol"));
  expect(bodies).toHaveLength(1);
});

it("rejects contradictory initial argument prefix and terminal argument deltas", async () => {
  for (const stream of [
    item(0, { ...call, arguments: "wrong", status: "in_progress" }) +
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: call.id,
        delta: call.arguments,
      }) +
      done(0, call) +
      completed([call]),
    item(0, { ...call, arguments: "", status: "in_progress" }) +
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: call.id,
        delta: "{}",
      }) +
      wire("response.function_call_arguments.done", {
        output_index: 0,
        item_id: call.id,
        arguments: call.arguments,
      }) +
      done(0, call) +
      completed([call]),
  ]) {
    const p = await setup((_req, res) => send(res, stream));
    await expect(run(p)).rejects.toSatisfy(classification("protocol"));
  }
});

it("reopens stored native continuation and replays it through a new provider and stored fork", async () => {
  const dir = await mkdtemp(join(tmpdir(), "responses-replay-"));
  try {
    await mkdir(join(dir, "workspace"));
    const bodies: unknown[] = [];
    const provider = await setup((_req, res, body) => {
      bodies.push(requestBody.parse(body));
      if (bodies.length === 1)
        send(
          res,
          item(0, { ...call, arguments: "", status: "in_progress" }) +
            wire("response.function_call_arguments.delta", {
              output_index: 0,
              item_id: call.id,
              delta: call.arguments,
            }) +
            wire("response.function_call_arguments.done", {
              output_index: 0,
              item_id: call.id,
              arguments: call.arguments,
            }) +
            done(0, call) +
            completed([call]),
        );
      else send(res, textStream("continued"));
    });
    const first = (await run(provider)).message;
    const store = await openSessionStore(join(dir, "state"));
    const root = await store.create({
      workspace: join(dir, "workspace"),
      title: "root",
      model: "m",
    });
    const messages: Message[] = [
      { role: "user", content: "hello" },
      first,
      { role: "tool", tool_call_id: call.call_id, content: "found" },
    ];
    await store.save({ ...root, messages });
    const fork = await store.create({
      workspace: join(dir, "workspace"),
      title: "fork",
      model: "m",
    });
    await store.save({ ...fork, parentSessionId: root.id, messages });
    const origin = first.providerState?.baseUrl;
    if (!origin) throw Error("missing origin");
    const reopened = await openSessionStore(join(dir, "state"));
    for (const id of [root.id, fork.id]) {
      const snapshot = await reopened.get(id);
      const fresh = createModelProvider({
        baseUrl: origin,
        apiKey: "",
        apiMode: "responses",
        requestTimeoutMs: 2000,
      });
      expect((await run(fresh, snapshot.messages)).message.content).toBe(
        "continued",
      );
    }
    const expected = [
      { role: "user", content: "hello" },
      call,
      { type: "function_call_output", call_id: call.call_id, output: "found" },
    ];
    expect(requestBody.parse(bodies[1]).input).toEqual(expected);
    expect(requestBody.parse(bodies[2]).input).toEqual(expected);
    expect((await reopened.get(fork.id)).parentSessionId).toBe(root.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Gateway-compatible streams omit only the terminal output array, not item completion.
it("normalizes completed empty terminal function and opaque reasoning with next tool result", async () => {
  const bodies: z.infer<typeof requestBody>[] = [];
  const reason = {
    type: "reasoning",
    id: "rs_2",
    summary: [],
    encrypted_content: "opaque-native",
  };
  const provider = await setup((_req, res, raw) => {
    bodies.push(requestBody.parse(raw));
    if (bodies.length === 1) {
      send(
        res,
        wire("response.created", {
          response: { id: "resp_1", status: "in_progress" },
        }) +
          wire("response.in_progress", {
            response: { id: "resp_1", status: "in_progress" },
          }) +
          item(0, { type: "reasoning", id: reason.id, summary: [] }) +
          done(0, reason) +
          item(1, { ...call, arguments: "", status: "in_progress" }) +
          wire("response.function_call_arguments.delta", {
            output_index: 1,
            item_id: call.id,
            delta: call.arguments,
          }) +
          wire("response.function_call_arguments.done", {
            output_index: 1,
            item_id: call.id,
            arguments: call.arguments,
          }) +
          done(1, call) +
          completed([]),
      );
    } else
      send(
        res,
        textStream("result received").replace(
          completed([msg("m_1", "result received")]),
          completed([]),
        ),
      );
  });
  const first = await run(provider);
  expect(first.message.tool_calls?.[0]?.id).toBe(call.call_id);
  expect(first.message.providerState?.output).toEqual([reason, call]);
  const next = await run(provider, [
    { role: "user", content: "hello" },
    first.message,
    { role: "tool", tool_call_id: call.call_id, content: "found" },
  ]);
  expect(next.message.content).toBe("result received");
  expect(bodies[1]?.input).toEqual([
    { role: "user", content: "hello" },
    reason,
    call,
    { type: "function_call_output", call_id: call.call_id, output: "found" },
  ]);
});

it("rejects empty-terminal incomplete, duplicated, mismatched and unfinished events", async () => {
  const m = msg("m_1", "hello");
  const prefix = wire("response.created", { response: { id: "resp_1" } });
  const text =
    item(0, { type: "message", id: m.id, role: "assistant" }) +
    wire("response.output_text.delta", {
      output_index: 0,
      item_id: m.id,
      content_index: 0,
      delta: "hello",
    });
  const textDone = wire("response.output_text.done", {
    output_index: 0,
    item_id: m.id,
    content_index: 0,
    text: "hello",
  });
  const cases = [
    text + textDone + completed([]), // no item.done
    text + done(0, m) + completed([]), // no text.done
    text +
      textDone +
      done(0, m) +
      item(1, { type: "reasoning", id: m.id }) +
      completed([]),
    text +
      textDone +
      done(0, m) +
      wire("response.in_progress", { response: { id: "other" } }) +
      completed([]),
    text +
      textDone +
      done(0, m) +
      wire("response.completed", {
        response: { id: "other", status: "completed", output: [] },
      }),
    text +
      textDone +
      done(0, m) +
      wire("response.completed", {
        response: { id: "resp_1", status: "incomplete", output: [] },
      }),
    text + textDone + done(0, m), // stream closed without terminal
    item(0, { ...call, arguments: "" }) +
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: call.id,
        delta: call.arguments,
      }) +
      done(0, call) +
      completed([]), // no arguments.done
    item(0, { ...call, arguments: "", name: "different" }) +
      wire("response.function_call_arguments.delta", {
        output_index: 0,
        item_id: call.id,
        delta: call.arguments,
      }) +
      wire("response.function_call_arguments.done", {
        item_id: call.id,
        arguments: call.arguments,
      }) +
      done(0, call) +
      completed([]),
  ];
  for (const data of cases) {
    const provider = await setup((_req, res) => send(res, prefix + data));
    await expect(run(provider)).rejects.toBeDefined();
  }
});

const doneMarker = "data: [DONE]\r\n\r\n";
it("accepts a single trailing transport marker after empty-terminal tool and text streams", async () => {
  const reason = {
    type: "reasoning",
    id: "r_marker",
    summary: [],
    encrypted_content: "opaque",
  };
  const provider = await setup((_req, res, body) => {
    const input = requestBody.parse(body).input;
    if (
      input.some(
        (part) =>
          z.object({ type: z.literal("function_call_output") }).safeParse(part)
            .success,
      )
    ) {
      send(
        res,
        textStream("finished").replace(
          completed([msg("m_1", "finished")]),
          completed([]),
        ) + doneMarker,
      );
    } else {
      send(
        res,
        wire("response.created", { response: { id: "resp_1" } }) +
          item(0, { type: "reasoning", id: reason.id }) +
          done(0, reason) +
          item(1, { ...call, arguments: "", status: "in_progress" }) +
          wire("response.function_call_arguments.delta", {
            output_index: 1,
            item_id: call.id,
            delta: call.arguments,
          }) +
          wire("response.function_call_arguments.done", {
            output_index: 1,
            item_id: call.id,
            arguments: call.arguments,
          }) +
          done(1, call) +
          completed([]) +
          doneMarker,
      );
    }
  });
  const first = await run(provider);
  expect(first.message.tool_calls?.[0]?.id).toBe(call.call_id);
  expect(first.message.providerState?.output).toEqual([reason, call]);
  const next = await run(provider, [
    { role: "user", content: "hello" },
    first.message,
    { role: "tool", tool_call_id: call.call_id, content: "found" },
  ]);
  expect(next.message.content).toBe("finished");
});

it("rejects early, repeated and followed-by-data transport markers", async () => {
  const m = msg("m_1", "ready");
  const valid = textStream("ready").replace(completed([m]), completed([]));
  const cases = [
    doneMarker,
    doneMarker + valid,
    valid.replace(completed([]), doneMarker + completed([])),
    valid + doneMarker + doneMarker,
    valid + doneMarker + completed([]),
    valid +
      doneMarker +
      wire("response.output_text.delta", {
        output_index: 0,
        item_id: m.id,
        content_index: 0,
        delta: "extra",
      }),
    valid.replace(done(0, m), "") + doneMarker,
    valid.replace(
      wire("response.output_text.done", {
        output_index: 0,
        content_index: 0,
        item_id: m.id,
        text: "ready",
      }),
      "",
    ) + doneMarker,
  ];
  for (const data of cases) {
    const provider = await setup((_req, res) => send(res, data));
    await expect(run(provider)).rejects.toBeDefined();
  }
});

it("sends reconciliation content without local origin while preserving native tool continuation", async () => {
  const requests: z.infer<typeof requestBody>[] = [];
  const provider = await setup((_req, res, body) => {
    requests.push(requestBody.parse(body));
    if (requests.length === 1) {
      send(
        res,
        item(0, { ...call, arguments: "", status: "in_progress" }) +
          wire("response.function_call_arguments.delta", {
            output_index: 0,
            item_id: call.id,
            delta: call.arguments,
          }) +
          wire("response.function_call_arguments.done", {
            output_index: 0,
            item_id: call.id,
            arguments: call.arguments,
          }) +
          done(0, call) +
          completed([]),
      );
    } else send(res, textStream("ok"));
  });
  const initial = await run(provider);
  expect(initial.message.tool_calls?.[0]?.id).toBe(call.call_id);
  await run(provider, [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    initial.message,
    { role: "tool", tool_call_id: call.call_id, content: "found" },
    {
      role: "user",
      content: "Retain this context",
      origin: "agent_reconciliation",
    },
  ]);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.input).toEqual([
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    call,
    { type: "function_call_output", call_id: call.call_id, output: "found" },
    { role: "user", content: "Retain this context" },
  ]);
});
