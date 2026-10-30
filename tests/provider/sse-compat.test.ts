import { afterEach, expect, it, vi } from "vitest";
import { fixture, textStream } from "../fixtures/responses-stream";

afterEach(() => vi.unstubAllGlobals());

it.each(["\n", "\r\n", "\r"])("accepts SSE line ending %j", async (ending) => {
  expect(
    (await fixture(textStream().replaceAll("\n", ending)).run()).message
      .content,
  ).toBe("OK");
});

it("ignores extension SSE fields as the SDK decoder does", async () => {
  const data = textStream().replaceAll("data:", "vendor-trace: fixture\ndata:");
  expect((await fixture(data).run()).message.content).toBe("OK");
});

it.each(["\r\n", "\r"])(
  "handles fragmented UTF-8 and line endings %j",
  async (ending) => {
    const f = fixture();
    const bytes = new TextEncoder().encode(
      textStream("你好").replaceAll("\n", ending),
    );
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect((await f.run()).message.content).toBe("你好");
  },
);

it.each(["\n", "\r\n", "\r"])(
  "does not accept a terminal event without its blank line %j",
  async (ending) => {
    const data = textStream().replaceAll("\n", ending).slice(0, -ending.length);
    await expect(fixture(data).run()).rejects.toMatchObject({
      classification: "protocol",
    });
  },
);

it.each(["event: ping\n\n", "event: response.completed\n\n", "event:\n\n"])(
  "ignores data-free SSE records %j instead of parsing empty JSON",
  async (heartbeat) => {
    expect(
      (await fixture(heartbeat + textStream() + heartbeat).run()).message
        .content,
    ).toBe("OK");
  },
);

it.each(["\n", "\r\n", "\r"])(
  "allows trailing comments and control fields with fragmented line endings %j",
  async (ending) => {
    for (const suffix of [
      ": keepalive",
      ": keepalive\n",
      "id: 1\nretry: 1000\n",
      "event: ping\n",
    ]) {
      const f = fixture();
      const bytes = new TextEncoder().encode(
        (textStream("你好") + suffix).replaceAll("\n", ending),
      );
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const byte of bytes)
                  controller.enqueue(Uint8Array.of(byte));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream; charset=utf-8" } },
          ),
      );
      expect((await f.run()).message.content).toBe("你好");
    }
  },
);

it.each(["\n", "\r\n", "\r"])(
  "does not let trailing comments hide an unterminated data event %j",
  async (ending) => {
    const data =
      `${textStream()}data: {"type":"response.metadata"}\n: keepalive\n`.replaceAll(
        "\n",
        ending,
      );
    await expect(fixture(data).run()).rejects.toMatchObject({
      reason: "unterminated_event",
    });
  },
);

it("still rejects nonempty malformed JSON without replaying the request", async () => {
  const f = fixture(
    `event: response.output_text.delta\ndata: {broken}\n\n${textStream()}`,
  );
  await expect(f.run()).rejects.toMatchObject({
    reason: "invalid_json",
    retryable: false,
  });
  expect(f.bodies).toHaveLength(1);
});

it("enforces data framing for case-insensitive SSE content types", async () => {
  const f = fixture();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(textStream().slice(0, -1), {
        headers: { "content-type": "Text/Event-Stream; charset=utf-8" },
      }),
  );
  await expect(f.run()).rejects.toMatchObject({ reason: "unterminated_event" });
});

it("does not treat data-free completion or heartbeats as successful generation", async () => {
  const f = fixture("event: response.completed\n\nevent: ping\n\n: keepalive");
  await expect(f.run()).rejects.toMatchObject({
    reason: "missing_completion",
    retryable: false,
  });
  expect(f.bodies).toHaveLength(1);
});

it.each(["error", "response.failed", "response.incomplete"])(
  "does not hide a data-free failure event %s",
  async (name) => {
    const f = fixture(`event: ${name}\n\n${textStream()}`);
    await expect(f.run()).rejects.toMatchObject({
      reason: "provider_error_event",
      retryable: false,
    });
    expect(f.bodies).toHaveLength(1);
  },
);
