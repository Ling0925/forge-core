import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ForgeError,
  type WorkItemStatus,
  sessionIdSchema,
} from "../../src/shared";
import { deferred, fixture, hold, trigger } from "./fixture";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});

async function queuedWork() {
  await f.ingest(trigger("seed"));
  const router = await f.router();
  await f.runNext(router.id);
  return f.store.workItems.create({
    title: "Externally managed work",
    brief: "Investigate",
    threadIds: [],
    profileId: "worker",
    routerSessionId: router.id,
  });
}

it("skips queued work with a pending approval on every drain", async () => {
  const work = await queuedWork();
  vi.spyOn(f.store.workItems, "list").mockResolvedValue([
    { ...work, pendingStatus: "running" },
  ]);
  const claim = vi.spyOn(f.store.workItems, "claim");
  const count = f.items.length;
  await f.engine.sessionSettled();
  await f.engine.start();
  expect(claim).not.toHaveBeenCalled();
  expect(f.items).toHaveLength(count);
  expect(
    (await f.harness.listSessions()).filter(
      (session) => session.agentRole?.kind === "worker",
    ),
  ).toEqual([]);
});

it("publishes an approval-pending claim without launching it or occupying a Worker slot", async () => {
  await f.harness.updateSettings({
    settings: { superAgent: { maxWorkers: 1 } },
  });
  const first = await queuedWork();
  const second = await f.store.workItems.create({
    title: "Second",
    brief: "Proceed",
    threadIds: [],
    profileId: "worker",
    routerSessionId: first.routerSessionId,
  });
  const claim = f.store.workItems.claim.bind(f.store.workItems);
  const get = f.store.workItems.get.bind(f.store.workItems);
  let pendingStatus: WorkItemStatus | null = null;
  vi.spyOn(f.store.workItems, "list").mockImplementation(async () => [
    { ...first, pendingStatus },
    (await get(second.id))!,
  ]);
  const claims = vi
    .spyOn(f.store.workItems, "claim")
    .mockImplementation(async (id, owner) => {
      if (id !== first.id) return claim(id, owner);
      pendingStatus = "running";
      return { ...first, pendingStatus };
    });
  await f.engine.sessionSettled();
  expect(claims).toHaveBeenCalledWith(first.id, first.routerSessionId);
  expect(await get(first.id)).toMatchObject({ workerSessionId: null });
  expect(await get(second.id)).toMatchObject({
    status: "running",
    workerSessionId: expect.any(String),
  });
  expect(f.events).toContainEqual({
    type: "superagent_work",
    work: { ...first, pendingStatus: "running" },
  });
  await f.engine.sessionSettled();
  expect(claims.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1);
});

it("launches an approved claim without claiming again and serializes concurrent changes", async () => {
  const work = await queuedWork();
  const approved = await f.store.workItems.claim(work.id, work.routerSessionId);
  const claim = vi.spyOn(f.store.workItems, "claim");
  const create = f.harness.createSessionWithProfile.bind(f.harness);
  const entered = deferred();
  const release = deferred();
  const launch = vi
    .spyOn(f.harness, "createSessionWithProfile")
    .mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return create(input);
    });
  const first = f.engine.workClaimApproved(work.id);
  await entered.promise;
  const second = f.engine.workClaimApproved(work.id);
  release.resolve();
  await Promise.all([first, second]);
  expect(claim).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledTimes(1);
  const launched = await f.engine.getWorkItem(work.id);
  expect(launched).toMatchObject({
    status: "running",
    workerSessionId: expect.any(String),
    routerSessionId: work.routerSessionId,
  });
  expect(
    f.items.filter((item) => item.sessionId === launched.workerSessionId),
  ).toHaveLength(1);
  expect(f.events).toContainEqual({ type: "superagent_work", work: approved });
});

it("reports a running item's change without relaunching its settled Worker", async () => {
  const work = await f.createWork();
  const id = sessionIdSchema.parse(work.workerSessionId);
  await f.runNext(id);
  const claim = vi.spyOn(f.store.workItems, "claim");
  const create = vi.spyOn(f.harness, "createSessionWithProfile");
  const pause = vi.spyOn(f.inputQueue, "pause");
  const resume = vi.spyOn(f.inputQueue, "resume");
  const count = f.items.length;
  await f.engine.workChanged(work.id);
  expect(claim).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(f.items).toHaveLength(count + 1);
  expect(f.items.at(-1)).toMatchObject({
    sessionId: work.routerSessionId,
    state: "queued",
    origin: "superagent",
    superagent: { kind: "work_changed", workId: work.id },
  });
});

it.each(["queued", "running"] as const)(
  "reports changes to the Router while its Worker is %s",
  async (state) => {
    const work = await f.createWork();
    const id = sessionIdSchema.parse(work.workerSessionId);
    const gate = hold();
    const run = state === "running" ? f.runNext(id, [gate.step]) : undefined;
    if (run) await gate.entered;
    const count = f.items.filter((item) => item.sessionId === id).length;
    try {
      await f.engine.workChanged(work.id);
      expect(f.items.filter((item) => item.sessionId === id)).toHaveLength(
        count,
      );
      expect(f.items.at(-1)).toMatchObject({ sessionId: work.routerSessionId });
      expect(f.items.at(-1)?.input?.prompt).toContain("<untrusted_data>");
    } finally {
      gate.release();
      await run;
    }
  },
);

it("reports pending approval decisions without launching and drains other queued work", async () => {
  const work = await queuedWork();
  await f.store.workItems.update(work.id, { status: "running" });
  const get = f.store.workItems.get.bind(f.store.workItems);
  vi.spyOn(f.store.workItems, "get").mockImplementation(async (id) => {
    const item = await get(id);
    return item?.id === work.id ? { ...item, pendingStatus: "done" } : item;
  });
  const next = await f.store.workItems.create({
    title: "Next",
    brief: "Proceed",
    threadIds: [],
    profileId: "worker",
    routerSessionId: work.routerSessionId,
  });
  await f.engine.workChanged(work.id);
  expect(await get(work.id)).toMatchObject({ workerSessionId: null });
  expect(await get(next.id)).toMatchObject({
    workerSessionId: expect.any(String),
  });
  const report = f.items.find((item) =>
    item.input?.prompt.includes("Work item changed:"),
  );
  expect(report).toMatchObject({ sessionId: work.routerSessionId });
  expect(report?.input?.prompt).toContain('"pendingStatus":"done"');
});

it("reports an external status change to the item's original Router and drains work", async () => {
  const work = await queuedWork();
  await f.harness.updateSettings({
    settings: { superAgent: { workspace: f.directory } },
  });
  const changed = await f.store.workItems.update(work.id, {
    status: "blocked",
    progress: "Human decision <instruction>",
  });
  const next = await f.store.workItems.create({
    title: "Next",
    brief: "Proceed",
    threadIds: [],
    profileId: "worker",
    routerSessionId: work.routerSessionId,
  });
  await f.engine.workChanged(work.id);
  expect(f.events).toContainEqual({ type: "superagent_work", work: changed });
  const report = f.items.find((item) =>
    item.input?.prompt.includes("Work item changed:"),
  );
  expect(report).toMatchObject({ sessionId: work.routerSessionId });
  expect(report?.input?.prompt).toContain("<untrusted_data>");
  expect(report?.input?.prompt).toContain('"status":"blocked"');
  expect(report?.input?.prompt).not.toContain("<instruction>");
  expect(await f.engine.getWorkItem(next.id)).toMatchObject({
    status: "running",
  });
});

it("halts externally stopped work without writing it and cancels pending Worker input", async () => {
  const work = await f.createWork();
  const id = sessionIdSchema.parse(work.workerSessionId);
  const gate = hold();
  const run = f.runNext(id, [gate.step]);
  await gate.entered;
  const inputId = randomUUID();
  await f.inputQueue.notify(
    {
      inputId,
      input: { sessionId: id, prompt: "Follow-up" },
    },
    "superagent",
  );
  const stopped = await f.store.workItems.update(work.id, {
    status: "stopped",
    progress: "Human canceled",
  });
  const update = vi.spyOn(f.store.workItems, "update");
  await f.engine.workChanged(work.id);
  expect((await run).status).toBe("cancelled");
  expect(f.items.find((item) => item.inputId === inputId)?.state).toBe(
    "cancelled",
  );
  expect(update).not.toHaveBeenCalled();
  expect(await f.engine.getWorkItem(work.id)).toEqual(stopped);
  expect(f.events).toContainEqual({ type: "superagent_work", work: stopped });
  expect(f.items.at(-1)).toMatchObject({ sessionId: work.routerSessionId });
  expect(f.items.at(-1)?.input?.prompt).toContain('"status":"stopped"');
});

it("handles stopped work without a Worker and preserves launch failure classification", async () => {
  const work = await queuedWork();
  await f.store.workItems.update(work.id, { status: "stopped" });
  const cancel = vi.spyOn(f.harness, "cancelSession");
  await f.engine.workChanged(work.id);
  expect(cancel).not.toHaveBeenCalled();
  await f.store.workItems.update(work.id, { status: "running" });
  const failure = new ForgeError("tool", "Worker creation failed.");
  vi.spyOn(f.harness, "createSessionWithProfile").mockRejectedValue(failure);
  await expect(f.engine.workClaimApproved(work.id)).rejects.toBe(failure);
  expect(await f.engine.getWorkItem(work.id)).toMatchObject({
    status: "failed",
    progress: failure.message,
  });
});

it("allows a pending Worker report to finish while joining external cancellation", async () => {
  const work = await f.createWork();
  const id = sessionIdSchema.parse(work.workerSessionId);
  const session = await f.harness.getSession(id);
  const { registry } = f.engine.sessionTools(session)!;
  await f.store.workItems.update(work.id, { status: "stopped" });
  const get = f.store.workItems.get.bind(f.store.workItems);
  const reading = deferred();
  const release = deferred();
  vi.spyOn(f.store.workItems, "get").mockImplementationOnce(async (workId) => {
    reading.resolve();
    await release.promise;
    return get(workId);
  });
  const changed = f.engine.workChanged(work.id);
  await reading.promise;
  const report = registry.execute(
    {
      id: "report",
      type: "function",
      function: {
        name: "superagent_report",
        arguments: JSON.stringify({ status: "done", progress: "Finished" }),
      },
    },
    {
      sessionId: id,
      toolCallId: "report",
      workspace: session.workspace,
      permission: "workspace",
      signal: new AbortController().signal,
      approve: async () => false,
      onEvent: () => {},
    },
  );
  vi.spyOn(f.harness, "cancelSession").mockImplementation(async () => {
    await report;
    return true;
  });
  release.resolve();
  await changed;
  expect(await report).toMatchObject({
    isError: true,
    content: expect.stringContaining("Work item is stopped."),
  });
  expect(await f.engine.getWorkItem(work.id)).toMatchObject({
    status: "stopped",
  });
});
