import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openInputQueue } from "../../src/core/input-queue";
import type { InputQueueHost } from "../../src/shared/input-queue";
import { type RunInput, parseSessionId } from "../../src/shared/schemas";
import { atomicJson } from "../../src/store/io";

let directory = "";
let queues: InputQueueHost[] = [];
const sessionId = parseSessionId(randomUUID());
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-input-queue-"));
  queues = [];
});
afterEach(async () => {
  await Promise.all(queues.map((queue) => queue.dispose()));
  await rm(directory, { recursive: true, force: true });
});
const input = (prompt = "work", id = sessionId): RunInput => ({
  sessionId: id,
  prompt,
});
async function create(binding = () => "a".repeat(64)) {
  const queue = await openInputQueue({
    directory,
    validateSession: async () => {},
    prepare: async (raw) => ({
      input: {
        ...raw,
        model: raw.model ?? "fixture",
        permission: raw.permission ?? "workspace",
        mode: raw.mode ?? "build",
      },
      providerBinding: binding(),
    }),
  });
  queues.push(queue);
  return queue;
}
const settled = async (queue: InputQueueHost, count: number) =>
  vi.waitFor(async () => {
    expect(
      (await queue.list(sessionId)).items.filter(
        (item) => item.state === "consumed",
      ),
    ).toHaveLength(count);
  });

it("durably acknowledges once, deduplicates concurrent retries and preserves sequence across restart", async () => {
  const queue = await create();
  await queue.pause(sessionId);
  const inputId = randomUUID();
  const records = await Promise.all([
    queue.enqueue({ inputId, input: input() }),
    queue.enqueue({ inputId, input: input() }),
    queue.enqueue({ inputId: randomUUID(), input: input("second") }),
  ]);
  expect(records[0]).toEqual(records[1]);
  expect(records[2]?.sequence).toBeGreaterThan(records[0]?.sequence ?? 0);
  expect(
    JSON.parse(
      await readFile(join(directory, "input-queue/queue.json"), "utf8"),
    ).items,
  ).toHaveLength(2);
  await queue.dispose();
  const recovered = await create(() => "b".repeat(64));
  expect(await recovered.enqueue({ inputId, input: input() })).toEqual(
    records[0],
  );
  await expect(
    recovered.enqueue({ inputId, input: input("different") }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    recovered.enqueue({
      inputId,
      input: input("work", parseSessionId(randomUUID())),
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

it("serializes two submitters and consumes accepted inputs without client callbacks", async () => {
  const queue = await create();
  await queue.pause(sessionId);
  const accepted = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      queue.enqueue({ inputId: randomUUID(), input: input(String(i)) }),
    ),
  );
  let running = 0;
  const prompts: string[] = [];
  await queue.attach({
    isBusy: () => false,
    start: async (raw) => {
      expect(++running).toBe(1);
      prompts.push(raw.prompt);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return "completed";
    },
  });
  const observer = await create();
  expect(await observer.list(sessionId)).toEqual(await queue.list(sessionId));
  await queue.resume(sessionId);
  await settled(queue, 10);
  expect(prompts).toEqual(
    accepted
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => item.input?.prompt),
  );
  expect(
    (await observer.list(sessionId)).items.every(
      (item) =>
        item.input === null && item.runId && item.outcome === "completed",
    ),
  ).toBe(true);
});

it.each(["failed", "cancelled", "interrupted"] as const)(
  "pauses following inputs after %s, and resumes only explicitly",
  async (outcome) => {
    const queue = await create();
    await queue.pause(sessionId);
    await queue.enqueue({ inputId: randomUUID(), input: input("first") });
    await queue.enqueue({ inputId: randomUUID(), input: input("second") });
    let count = 0;
    const start = vi.fn(async () =>
      ++count === 1 ? outcome : ("completed" as const),
    );
    await queue.attach({ isBusy: () => false, start });
    await queue.resume(sessionId);
    await settled(queue, 1);
    expect((await queue.list(sessionId)).paused).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect((await queue.list(sessionId)).items[0]?.input?.prompt).toBe("first");
    await queue.resume(sessionId);
    await settled(queue, 2);
  },
);

it("keeps cancellation of waiting input separate from active-run cancellation", async () => {
  const queue = await create();
  await queue.pause(sessionId);
  const cancelled = await queue.enqueue({
    inputId: randomUUID(),
    input: input("cancel me"),
  });
  const kept = await queue.enqueue({
    inputId: randomUUID(),
    input: input("keep me"),
  });
  expect(await queue.cancel(sessionId, cancelled.inputId)).toBe(true);
  const start = vi.fn(async (_input: RunInput) => "completed" as const);
  await queue.attach({ isBusy: () => false, start });
  await queue.resume(sessionId);
  await settled(queue, 1);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]?.[0]).toMatchObject({ prompt: "keep me" });
  expect(await queue.cancel(sessionId, kept.inputId)).toBe(false);
});

it("pauses unavailable pinned configuration instead of silently changing providers", async () => {
  let binding = "a".repeat(64);
  const queue = await create(() => binding);
  await queue.pause(sessionId);
  const accepted = await queue.enqueue({
    inputId: randomUUID(),
    input: input(),
  });
  binding = "b".repeat(64);
  const start = vi.fn(async (_input: RunInput) => "completed" as const);
  await queue.attach({ isBusy: () => false, start });
  await queue.resume(sessionId);
  await vi.waitFor(async () =>
    expect((await queue.list(sessionId)).items[0]?.state).toBe("blocked"),
  );
  expect(start).not.toHaveBeenCalled();
  expect((await queue.list(sessionId)).items[0]?.selection).toEqual(
    accepted.selection,
  );
  binding = "a".repeat(64);
  await queue.resume(sessionId);
  await settled(queue, 1);
});

it("recovers an uncertain binding without replay and keeps unbound accepted inputs", async () => {
  const queue = await create();
  await queue.pause(sessionId);
  const first = await queue.enqueue({
    inputId: randomUUID(),
    input: input("uncertain"),
  });
  await queue.enqueue({ inputId: randomUUID(), input: input("not started") });
  await queue.dispose();
  const path = join(directory, "input-queue/queue.json");
  const ledger = JSON.parse(await readFile(path, "utf8"));
  ledger.items[0].state = "bound";
  ledger.items[0].runId = randomUUID();
  ledger.sessions[sessionId].paused = false;
  await atomicJson(path, ledger);
  const recovered = await create();
  const start = vi.fn(async (_input: RunInput) => "completed" as const);
  await recovered.attach({ isBusy: () => false, start });
  expect(await recovered.list(sessionId)).toMatchObject({
    paused: true,
    items: [
      { inputId: first.inputId, state: "uncertain" },
      { state: "queued" },
    ],
  });
  expect(start).not.toHaveBeenCalled();
  await recovered.resume(sessionId);
  await settled(recovered, 1);
  expect(start.mock.calls[0]?.[0].prompt).toBe("not started");
});

it("allows only one durable consumer and does not lose queued items on ownership transfer", async () => {
  const first = await create();
  const second = await create();
  await first.pause(sessionId);
  await first.enqueue({ inputId: randomUUID(), input: input() });
  const start = vi.fn(async (_input: RunInput) => "completed" as const);
  await first.attach({ isBusy: () => false, start });
  await expect(
    second.attach({ isBusy: () => false, start }),
  ).rejects.toMatchObject({ code: "busy" });
  await first.dispose();
  const third = await create();
  await third.attach({ isBusy: () => false, start });
  await third.resume(sessionId);
  await settled(third, 1);
  expect(start).toHaveBeenCalledTimes(1);
});

it("bounds queue counts, bytes and retry receipts and rejects malformed attachments", async () => {
  const queue = await create();
  const first = await queue.enqueue({ inputId: randomUUID(), input: input() });
  const path = join(directory, "input-queue/queue.json");
  const original = JSON.parse(await readFile(path, "utf8"));
  const fill = async (
    count: number,
    prompt = "work",
    sessions = false,
    consumed = false,
  ) => {
    const ledger = structuredClone(original);
    ledger.items = Array.from({ length: count }, (_, i) => ({
      ...original.items[0],
      inputId: randomUUID(),
      sequence: i + 1,
      sessionId: sessions ? parseSessionId(randomUUID()) : sessionId,
      input: { ...original.items[0].input, prompt },
      ...(consumed
        ? {
            state: "consumed",
            outcome: "completed",
            runId: randomUUID(),
            input: null,
          }
        : {}),
    }));
    for (const item of ledger.items)
      if (item.input) item.input.sessionId = item.sessionId;
    ledger.nextSequence = count + 1;
    await atomicJson(path, ledger, 48 * 1024 * 1024);
  };
  await fill(100);
  await expect(
    queue.enqueue({ inputId: randomUUID(), input: input() }),
  ).rejects.toMatchObject({ code: "busy" });
  await fill(500, "work", true);
  await expect(
    queue.enqueue({ inputId: randomUUID(), input: input() }),
  ).rejects.toMatchObject({ code: "busy" });
  await fill(16, "x".repeat(1_000_000));
  await expect(
    queue.enqueue({
      inputId: randomUUID(),
      input: input("x".repeat(1_000_000)),
    }),
  ).rejects.toMatchObject({ code: "busy" });
  await fill(33, "x".repeat(1_000_000), true);
  await expect(
    queue.enqueue({
      inputId: randomUUID(),
      input: input("x".repeat(1_000_000)),
    }),
  ).rejects.toMatchObject({ code: "busy" });
  await fill(4096, "work", true, true);
  await expect(
    queue.enqueue({ inputId: randomUUID(), input: input() }),
  ).rejects.toMatchObject({ code: "busy" });
  await expect(
    queue.enqueue({
      inputId: randomUUID(),
      input: {
        ...input(),
        images: [{ name: "invalid.png", dataUrl: "invalid" }],
      },
    }),
  ).rejects.toThrow();
  expect(first.state).toBe("queued");
});
