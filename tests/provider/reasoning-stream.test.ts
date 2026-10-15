import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createModelProvider } from "../../src/provider/openai";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  handler: (body: unknown, response: import("node:http").ServerResponse) => void,
) {
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    handler(JSON.parse(raw), response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  });
  return createModelProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    requestTimeoutMs: 3000,
  });
}

const wire = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

it("streams reasoning_content through onReasoning without polluting assistant content", async () => {
  const provider = await fixture((_body, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.write(wire({ role: "assistant", reasoning_content: "step one " }));
    response.write(wire({ reasoning_content: "step two" }));
    response.write(wire({ content: "answer" }, "stop"));
    response.end("data: [DONE]\n\n");
  });
  const reasoning: string[] = [];
  const textParts: string[] = [];
  const result = await provider.complete([{ role: "user", content: "x" }], [], {
    model: "m",
    signal: new AbortController().signal,
    onText: (value) => textParts.push(value),
    onReasoning: (value) => reasoning.push(value),
  });
  expect(reasoning.join("")).toBe("step one step two");
  expect(textParts.join("")).toBe("answer");
  expect(result.message.content).toBe("answer");
});

it("requests stream usage so a compliant gateway can report the cache rate", async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = await fixture((body, response) => {
    bodies.push(body as Record<string, unknown>);
    response.setHeader("content-type", "text/event-stream");
    response.write(wire({ content: "ok" }, "stop"));
    response.end("data: [DONE]\n\n");
  });
  await provider.complete([{ role: "user", content: "x" }], [], {
    model: "m",
    signal: new AbortController().signal,
    onText: () => {},
  });
  expect(bodies[0]).toMatchObject({
    stream: true,
    stream_options: { include_usage: true },
  });
});

it("delivers non-streaming fallback reasoning_content without adding it to content", async () => {
  let requests = 0;
  const provider = await fixture((body, response) => {
    requests += 1;
    if (body && (body as { stream?: boolean }).stream) {
      // Force the non-streaming fallback with a streaming-unsupported rejection.
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ error: { message: "Streaming is not supported", param: "stream" } }),
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "answer", reasoning_content: "thought" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  const reasoning: string[] = [];
  const result = await provider.complete([{ role: "user", content: "x" }], [], {
    model: "m",
    signal: new AbortController().signal,
    onText: () => {},
    onReasoning: (value) => reasoning.push(value),
  });
  expect(requests).toBe(2);
  expect(reasoning.join("")).toBe("thought");
  expect(result.message.content).toBe("answer");
});
