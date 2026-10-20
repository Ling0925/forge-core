import { afterEach, expect, it, vi } from "vitest";
import { fixture, textStream } from "../fixtures/responses-stream";

afterEach(() => vi.unstubAllGlobals());

it.each(["\n", "\r\n", "\r"])("accepts SSE line ending %j", async ending => {
  expect((await fixture(textStream().replaceAll("\n", ending)).run()).message.content).toBe("OK");
});

it("ignores extension SSE fields as the SDK decoder does", async () => {
  const data = textStream().replaceAll("data:", "vendor-trace: fixture\ndata:");
  expect((await fixture(data).run()).message.content).toBe("OK");
});

it.each(["\r\n", "\r"])("handles fragmented UTF-8 and line endings %j", async ending => {
  const f = fixture();
  const bytes = new TextEncoder().encode(textStream("你好").replaceAll("\n", ending));
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  expect((await f.run()).message.content).toBe("你好");
});

it.each(["\n", "\r\n", "\r"])("does not accept a terminal event without its blank line %j", async ending => {
  const data = textStream().replaceAll("\n", ending).slice(0, -ending.length);
  await expect(fixture(data).run()).rejects.toMatchObject({ classification: "protocol" });
});
