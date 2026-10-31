import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { EventRing } from "../../src/host/event-ring";
import { runEventSchema } from "../../src/shared/ipc";

const event = runEventSchema.parse({
  runId: randomUUID(),
  event: {
    type: "text_delta",
    sessionId: randomUUID(),
    timestamp: new Date().toISOString(),
    text: '你好"\n',
  },
});

it("retains the same count/UTF-8 byte window and cursor boundaries as the transports", () => {
  const size = Buffer.byteLength(JSON.stringify(event));
  for (const [count, bytes] of [
    [2, size * 4],
    [4, size * 2],
    [2, size - 1],
  ] as const) {
    const ring = new EventRing(count, bytes);
    const previous: { cursor: number; json: string; bytes: number }[] = [];
    let retained = 0;
    for (let i = 1; i <= 6; i++) {
      const entry = ring.append(event);
      previous.push(entry);
      retained += size;
      while (previous.length > count || retained > bytes)
        retained -= previous.shift()?.bytes ?? 0;
      expect(ring.after(0)).toEqual(previous);
      expect(ring.oldest).toBe(previous[0]?.cursor ?? i + 1);
      expect(ring.cursor).toBe(i);
      expect(ring.after(i - 2, i - 1)).toEqual(
        previous.filter(
          (entry) => entry.cursor > i - 2 && entry.cursor <= i - 1,
        ),
      );
    }
  }
});

it("serializes each append once and replays the original wire value", () => {
  const ring = new EventRing(2, Buffer.byteLength(JSON.stringify(event)) * 2);
  const stringify = vi.spyOn(JSON, "stringify");
  const first = ring.append(event);
  expect(stringify).toHaveBeenCalledTimes(1);
  expect(JSON.parse(first.json)).toEqual(event);
  expect(ring.after(0)[0]?.json).toBe(first.json);
  expect(ring.after(0)[0]?.json).toBe(first.json);
  expect(stringify).toHaveBeenCalledTimes(1);
});
