import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createAdvisorCoordinator } from "../../src/core/advisor";
import type {
  AdvisorCoordinator,
  AdvisorRequest,
} from "../../src/shared/agent-coordination";

const coordinators: AdvisorCoordinator[] = [];
afterEach(async () => {
  await Promise.allSettled(
    coordinators
      .splice(0)
      .map((coordinator) => coordinator.close("interrupted")),
  );
  vi.useRealTimers();
});
const never = () => new Promise<void>(() => {});
const question = {
  question: "Which endpoint?",
  context: "Two callers disagree",
  recommendation: "Keep v1",
  timeout_ms: 1000,
};
function fixture(persist?: (record: AdvisorRequest) => Promise<void>) {
  const records: AdvisorRequest[] = [];
  const parentSessionId = randomUUID();
  const parentRunId = randomUUID();
  const child = randomUUID();
  const active = new Set<string>([child]);
  const coordinator = createAdvisorCoordinator({
    parentSessionId,
    parentRunId,
    isChildActive: (id) => active.has(id),
    persist: async (record) => {
      await persist?.(record);
      records.push(record);
    },
  });
  coordinators.push(coordinator);
  const port = coordinator.forChild(child);
  const signal = new AbortController();
  const registered = () => coordinator.wait(never(), signal.signal);
  return {
    coordinator,
    records,
    parentSessionId,
    parentRunId,
    child,
    active,
    port,
    signal,
    registered,
  };
}

it("persists the parent-bound question and answer before waking the child; receipts are separate", async () => {
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture((record) =>
    record.status === "answered" && !record.deliveredAt
      ? barrier
      : Promise.resolve(),
  );
  let delivered = false;
  const work = f.port.ask(question, "ask-1", f.signal.signal).then((record) => {
    delivered = true;
    return record;
  });
  await f.registered();
  const request = f.coordinator.pending()[0]!;
  expect(request).toMatchObject({
    parentSessionId: f.parentSessionId,
    parentRunId: f.parentRunId,
    childSessionId: f.child,
    toolCallId: "ask-1",
    status: "pending",
  });
  const answer = f.coordinator.answer({
    requestId: request.id,
    answer: "Use v1",
    nextInstruction: "Inspect its test",
  });
  await Promise.resolve();
  expect(delivered).toBe(false);
  expect(f.records).toHaveLength(1);
  release();
  await answer;
  expect(await work).toMatchObject({
    status: "answered",
    answer: "Use v1",
    nextInstruction: "Inspect its test",
  });
  expect(f.records.at(-1)?.deliveredAt).toBeUndefined();
  await f.port.delivered(request.id);
  expect(f.records.at(-1)?.deliveredAt).toBeTruthy();
  const count = f.records.length;
  await f.port.delivered(request.id);
  expect(f.records).toHaveLength(count);
});

it("deduplicates identical calls/replies and rejects conflicting or foreign operations", async () => {
  const f = fixture();
  const first = f.port.ask(question, "same", f.signal.signal);
  await f.registered();
  const second = f.port.ask(question, "same", f.signal.signal);
  await expect(
    f.port.ask({ ...question, question: "Different" }, "same", f.signal.signal),
  ).rejects.toThrow(/different question/);
  await expect(
    f.port.ask(question, "other-call", f.signal.signal),
  ).rejects.toMatchObject({ code: "busy" });
  const requestId = f.coordinator.pending()[0]!.id;
  await expect(
    f.coordinator.answer({ requestId: randomUUID(), answer: "wrong" }),
  ).rejects.toThrow(/Unknown/);
  await f.coordinator.answer({ requestId, answer: "Use v1" });
  expect(await second).toEqual(await first);
  const count = f.records.length;
  await f.coordinator.answer({ requestId, answer: "Use v1" });
  expect(f.records).toHaveLength(count);
  await expect(
    f.coordinator.answer({ requestId, answer: "Use v2" }),
  ).rejects.toThrow(/differently/);
  await expect(
    f.coordinator.forChild(randomUUID()).delivered(requestId),
  ).rejects.toThrow(/Unknown/);
});

it("serializes simultaneous questions without dropping any child or allowing two per child", async () => {
  const f = fixture();
  const ids = [f.child, randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) f.active.add(id);
  const work = ids.map((id) =>
    f.coordinator.forChild(id).ask(question, "call", f.signal.signal),
  );
  await f.registered();
  // An awaited queued rejection also fences all earlier admissions.
  await expect(
    f.port.ask(question, "second", f.signal.signal),
  ).rejects.toMatchObject({ code: "busy" });
  expect(f.coordinator.pending()).toHaveLength(4);
  await Promise.all(
    f.coordinator.pending().map((request) =>
      f.coordinator.answer({
        requestId: request.id,
        answer: request.childSessionId,
      }),
    ),
  );
  expect((await Promise.all(work)).map((record) => record.answer)).toEqual(ids);
});

it("expires without permission, cancels on child abort and closes on parent failure", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const expired = f.port.ask(question, "expiry", f.signal.signal);
  await f.registered();
  const requestId = f.coordinator.pending()[0]!.id;
  await vi.advanceTimersByTimeAsync(1000);
  expect(await expired).toMatchObject({ status: "expired" });
  await expect(
    f.coordinator.answer({ requestId, answer: "late" }),
  ).rejects.toThrow(/no longer pending/);
  const cancelled = f.port.ask(question, "cancel", f.signal.signal);
  await f.registered();
  f.signal.abort();
  expect(await cancelled).toMatchObject({ status: "cancelled" });
  const interrupted = f.port.ask(
    question,
    "close",
    new AbortController().signal,
  );
  await f.coordinator.wait(never(), new AbortController().signal);
  await f.coordinator.close("interrupted");
  expect(await interrupted).toMatchObject({ status: "interrupted" });
  expect(vi.getTimerCount()).toBe(0);
  await expect(
    f.port.ask(question, "new", new AbortController().signal),
  ).rejects.toMatchObject({ code: "cancelled" });
});

it("does not revive a former run or accept inactive children", async () => {
  const f = fixture();
  const work = f.port.ask(question, "old", f.signal.signal);
  await f.registered();
  const requestId = f.coordinator.pending()[0]!.id;
  await f.coordinator.close("interrupted");
  await work;
  const recovered = fixture();
  await expect(
    recovered.coordinator.answer({ requestId, answer: "resume automatically" }),
  ).rejects.toThrow(/historical/);
  recovered.active.clear();
  await expect(
    recovered.port.ask(question, "unknown", recovered.signal.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
});

it("rejects an oversized escaped reply before committing it and permits a shorter correction", async () => {
  const f = fixture();
  const work = f.port.ask(
    {
      question: "\u0000".repeat(2048),
      context: "\u0000".repeat(4096),
      options: Array.from({ length: 8 }, () => "\u0000".repeat(256)),
      recommendation: "\u0000".repeat(1024),
      timeout_ms: 1000,
    },
    "large",
    f.signal.signal,
  );
  await f.registered();
  const requestId = f.coordinator.pending()[0]!.id;
  await expect(
    f.coordinator.answer({
      requestId,
      answer: "\u0000".repeat(8192),
      nextInstruction: "\u0000".repeat(4096),
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.coordinator.pending()).toHaveLength(1);
  await f.coordinator.answer({ requestId, answer: "Short correction" });
  expect((await work).answer).toBe("Short correction");
});

it("never releases an uncommitted answer and refuses automatic replay after a storage fault", async () => {
  let attempts = 0;
  const f = fixture(async (record) => {
    if (record.status === "answered") {
      attempts++;
      throw Error("no disk");
    }
  });
  const work = f.port.ask(question, "ask", f.signal.signal);
  await f.registered();
  const requestId = f.coordinator.pending()[0]!.id;
  const failed = expect(work).rejects.toMatchObject({ code: "storage" });
  await expect(
    f.coordinator.answer({ requestId, answer: "Must not deliver" }),
  ).rejects.toMatchObject({ code: "storage" });
  await failed;
  await expect(
    f.coordinator.answer({ requestId, answer: "Must not replay" }),
  ).rejects.toMatchObject({ code: "storage" });
  expect(attempts).toBe(1);
  expect(f.records.some((record) => record.status === "answered")).toBe(false);
});

it("fails closed on persistence failure, and aborts waits without leaving a waiter", async () => {
  const f = fixture(async () => {
    throw Error("storage unavailable");
  });
  const wait = f.coordinator.wait(never(), f.signal.signal);
  const failedWait = expect(wait).rejects.toMatchObject({ code: "storage" });
  await expect(
    f.port.ask(question, "write-fail", f.signal.signal),
  ).rejects.toMatchObject({ code: "storage" });
  await failedWait;
  expect(f.records).toHaveLength(0);
  const healthy = fixture();
  await healthy.coordinator.wait(Promise.resolve(), healthy.signal.signal);
  const cancelled = healthy.coordinator.wait(never(), healthy.signal.signal);
  const assertion = expect(cancelled).rejects.toMatchObject({
    code: "cancelled",
  });
  healthy.signal.abort();
  await assertion;
});
