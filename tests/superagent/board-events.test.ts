import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { openInputQueue } from "../../src/core/input-queue";
import { subscribeBoardEvents } from "../../src/host/board-events";
import {
  ForgeError,
  type QueuedInput,
  type WorkItem,
  workerMessageSchema,
} from "../../src/shared";
import { superAgentStateSchema } from "../../src/shared/superagent";
import { createBoardClient, openSuperAgentStore } from "../../src/store";
import { deferred, fixture, hold, trigger } from "./fixture";

const url = "http://board.invalid";
const projectId = "project";
const cursorKey = `superagent:board:${JSON.stringify([url, projectId])}`;
const work: WorkItem = {
  id: "known",
  status: "running",
  pendingStatus: null,
  title: "Work",
  brief: "Brief",
  threadIds: [],
  workerSessionId: null,
  routerSessionId: "router",
  profileId: "worker",
  worktree: null,
  progress: null,
  claimedBy: "router",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
function transport() {
  const connections: {
    controller: ReadableStreamDefaultController<Uint8Array>;
    headers: Headers;
    signal: AbortSignal;
  }[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const endpoint = new URL(String(input));
    if (endpoint.pathname === "/v1/me")
      return Response.json({ principal: { id: "our-agent" } });
    if (endpoint.pathname === "/v1/approvals")
      return Response.json({
        items: [
          { id: "claim", taskId: "known", action: "claim", to: "in_progress" },
          {
            id: "transition",
            taskId: "known",
            action: "transition",
            to: "in_progress",
          },
        ],
        nextCursor: null,
      });
    expect(endpoint.pathname).toBe("/v1/events");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      project: projectId,
    });
    const signal = init!.signal!;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          connections.push({
            controller,
            headers: new Headers(init?.headers),
            signal,
          });
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", request);
  return { connections, request };
}
const frame = (seq: number, event: object) =>
  `id: ${seq}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
const event = (type = "task_updated", data = {}) => ({
  taskId: "known",
  actor: "human",
  type,
  data,
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("persists only handled events, skips our own and unknown tasks, and resumes after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-board-events-"));
  let store = await openSuperAgentStore(directory);
  const { connections } = transport();
  const client = createBoardClient({
    url,
    settings: { getBoardToken: async () => "private-token" },
  });
  const pending = deferred();
  const entered = deferred();
  const engine = {
    workChanged: vi.fn(async () => {
      entered.resolve();
      await pending.promise;
    }),
    workClaimApproved: vi.fn(async () => {}),
    reportBoardEventsFailure: vi.fn(),
  };
  const workItems = {
    get: vi.fn(async (id: string) => (id === work.id ? work : undefined)),
  };
  const start = () =>
    subscribeBoardEvents({
      client,
      url,
      projectId,
      store,
      workItems,
      engine,
    });
  let subscription = start();
  try {
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    const first = connections[0]!;
    expect(first.headers.get("Last-Event-ID")).toBeNull();
    const text = `: connected\r\n\r\n${frame(1, { ...event(), actor: "our-agent" })}${frame(2, { ...event(), taskId: "unknown" })}${frame(3, event())}`;
    const bytes = new TextEncoder().encode(text);
    for (const byte of bytes) first.controller.enqueue(Uint8Array.of(byte));
    await entered.promise;
    expect(await store.getCursor(cursorKey)).toBe("2");
    expect(workItems.get).toHaveBeenCalledTimes(2);
    pending.resolve();
    await vi.waitFor(async () =>
      expect(await store.getCursor(cursorKey)).toBe("3"),
    );
    await subscription.close();
    expect(first.signal.aborted).toBe(true);
    expect(engine.reportBoardEventsFailure).not.toHaveBeenCalled();
    await store.close();
    store = await openSuperAgentStore(directory);
    subscription = start();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    const second = connections[1]!;
    expect(second.headers.get("Last-Event-ID")).toBe("3");
    second.controller.enqueue(
      new TextEncoder().encode(
        frame(4, event("approval_approved", { approvalId: "claim" })) +
          frame(5, event("approval_approved", { approvalId: "transition" })) +
          frame(6, event("approval_rejected", { approvalId: "claim" })),
      ),
    );
    await vi.waitFor(async () =>
      expect(await store.getCursor(cursorKey)).toBe("6"),
    );
    expect(engine.workClaimApproved).toHaveBeenCalledExactlyOnceWith("known");
    expect(engine.workChanged).toHaveBeenCalledTimes(3);
    expect(engine.workChanged).toHaveBeenCalledWith("known", {
      cursorKey,
      eventId: "3",
    });
  } finally {
    pending.resolve();
    await subscription.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["end", "error", "handler", "forge"] as const)(
  "reports %s failure, backs off reconnects up to 60s, and resets to 1s after connecting without advancing an unhandled event",
  async (failure) => {
    const f = await fixture();
    vi.useFakeTimers();
    const { connections } = transport();
    const client = createBoardClient({
      url,
      settings: { getBoardToken: async () => "private-token" },
    });
    const store = {
      getCursor: vi.fn(async () => "7"),
      setCursor: vi.fn(async () => {}),
    };
    const engine = f.engine;
    vi.spyOn(engine, "workChanged").mockRejectedValue(
      failure === "forge"
        ? new ForgeError("busy", "Board task changed.")
        : new Error("Handler failed."),
    );
    const reportBoardEventsFailure = vi.spyOn(
      engine,
      "reportBoardEventsFailure",
    );
    const reportCatchUpFailure = vi.spyOn(engine, "reportCatchUpFailure");
    const subscription = subscribeBoardEvents({
      client,
      url,
      projectId,
      store,
      workItems: { get: async () => work },
      engine,
    });
    try {
      const initial = await engine.getSuperAgentState();
      expect(initial).not.toHaveProperty("catchUp");
      expect(initial).not.toHaveProperty("boardEvents");
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      if (failure === "end") connections[0]!.controller.close();
      else if (failure === "error")
        connections[0]!.controller.error(new Error("Stream connection lost."));
      else
        connections[0]!.controller.enqueue(
          new TextEncoder().encode(frame(8, event())),
        );
      await vi.advanceTimersByTimeAsync(0);
      expect(reportBoardEventsFailure).toHaveBeenCalledOnce();
      const boardEvents = {
        at: expect.any(String),
        error: {
          end: "Board event stream ended.",
          error: "Stream connection lost.",
          handler: "Handler failed.",
          forge: "Board task changed.",
        }[failure],
      };
      expect(reportBoardEventsFailure.mock.calls[0]).toMatchObject([
        { message: boardEvents.error },
      ]);
      const state = superAgentStateSchema.parse(
        await engine.getSuperAgentState(),
      );
      expect(state.boardEvents).toEqual(boardEvents);
      expect(state).not.toHaveProperty("catchUp");
      expect(reportCatchUpFailure).not.toHaveBeenCalled();
      expect(
        workerMessageSchema.parse({ kind: "event", data: f.events.at(-1) }),
      ).toEqual({
        kind: "event",
        data: {
          type: "superagent_board_events",
          boardEvents: state.boardEvents,
        },
      });
      expect(store.setCursor).not.toHaveBeenCalled();
      expect(connections).toHaveLength(1);
      engine.reportCatchUpFailure(
        new ForgeError("storage", "GitHub catch-up failed."),
      );
      const catchUp = (await engine.getSuperAgentState()).catchUp;
      expect((await engine.getSuperAgentState()).boardEvents).toEqual(
        boardEvents,
      );
      const request = vi
        .spyOn(client, "request")
        .mockRejectedValue(new Error("Connection failed."));
      const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
      for (const [index, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(request).toHaveBeenCalledTimes(index);
        await vi.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledTimes(index + 1);
        expect(reportBoardEventsFailure).toHaveBeenCalledTimes(index + 2);
      }
      expect(connections).toHaveLength(1);
      request.mockRestore();
      await vi.advanceTimersByTimeAsync(60000);
      expect(connections).toHaveLength(2);
      expect(connections[1]!.headers.get("Last-Event-ID")).toBe("7");
      if (failure === "error")
        connections[1]!.controller.error(new Error("Stream connection lost."));
      else connections[1]!.controller.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(reportBoardEventsFailure).toHaveBeenCalledTimes(delays.length + 2);
      const reconnectedState = await engine.getSuperAgentState();
      expect(reconnectedState).toMatchObject({
        catchUp,
        boardEvents: {
          at: expect.any(String),
          error:
            failure === "error"
              ? "Stream connection lost."
              : "Board event stream ended.",
        },
      });
      expect(reconnectedState.boardEvents?.at).not.toBe(state.boardEvents?.at);
      expect(reportCatchUpFailure).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(connections).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connections).toHaveLength(3);
      connections[2]!.controller.close();
      await vi.advanceTimersByTimeAsync(0);
      await subscription.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(connections).toHaveLength(3);
    } finally {
      await subscription.close();
      vi.useRealTimers();
      await f.close();
    }
  },
);

it.each([
  { failureAt: "cursor", consume: false },
  { failureAt: "cursor", consume: true },
  { failureAt: "admission", consume: false },
  { failureAt: "acknowledgement", consume: true },
  { failureAt: "drain", consume: true },
  { failureAt: "completion", consume: true },
] as const)(
  "preserves exactly one durable Router admission across $failureAt failure, reopen and changed task data (consumed=$consume)",
  async ({ failureAt, consume }) => {
    const f = await fixture();
    const openQueue = () =>
      openInputQueue({
        directory: join(f.directory, "queue"),
        validateSession: async () => {},
        prepare: async (input) => ({
          input: {
            ...input,
            model: "fixture",
            mode: "build",
            permission: "workspace",
          },
          providerBinding: "a".repeat(64),
        }),
      });
    let queue = await openQueue();
    const { connections } = transport();
    const client = createBoardClient({
      url,
      settings: { getBoardToken: async () => "fixture-token" },
    });
    let subscription: ReturnType<typeof subscribeBoardEvents> | undefined;
    try {
      await f.ingest(trigger("replay"));
      const router = await f.router();
      await f.runNext(router.id);
      const work = await f.store.workItems.create({
        title: "Replay window",
        brief: "Changed externally",
        threadIds: [],
        profileId: "worker",
        routerSessionId: router.id,
      });
      await f.store.workItems.update(work.id, { status: "blocked" });
      vi.spyOn(f.inputQueue, "notify").mockImplementation((...args) =>
        queue.notify(...args),
      );
      await f.store.setCursor(cursorKey, "7");
      const identity = { cursorKey, eventId: "8", workId: work.id };
      const failed = deferred();
      const failure = new Error(`Injected ${failureAt} failure`);
      const report = vi
        .spyOn(f.engine, "reportBoardEventsFailure")
        .mockImplementation(() => failed.resolve());
      if (failureAt === "cursor")
        vi.spyOn(f.store, "setCursor").mockImplementationOnce(async () => {
          expect((await queue.list(router.id)).items).toHaveLength(1);
          throw failure;
        });
      else if (failureAt === "admission")
        vi.mocked(f.inputQueue.notify).mockRejectedValueOnce(failure);
      else if (failureAt === "acknowledgement")
        vi.mocked(f.inputQueue.notify).mockImplementationOnce(
          async (...args) => {
            await queue.notify(...args);
            throw failure;
          },
        );
      else if (failureAt === "drain")
        vi.spyOn(f.store.workItems, "list").mockRejectedValueOnce(failure);
      else
        vi.spyOn(f.store.boardNotifications, "complete").mockRejectedValueOnce(
          failure,
        );
      const receipts = async (): Promise<QueuedInput[]> =>
        Promise.all(
          (await readdir(join(f.directory, "queue/input-queue/receipts")))
            .filter((file) => file.endsWith(".json"))
            .map(async (file) =>
              JSON.parse(
                await readFile(
                  join(f.directory, "queue/input-queue/receipts", file),
                  "utf8",
                ),
              ),
            ),
        );
      const consumeNotification = async () => {
        await queue.attach({
          isBusy: () => false,
          start: async (
            input,
            _runId,
            _binding,
            _predecessor,
            inputOrigin,
            superagent,
          ) =>
            (
              await f.harness.run(
                input,
                () => {},
                async () => false,
                new AbortController().signal,
                {
                  drainSteering: () => [],
                  ...(inputOrigin ? { inputOrigin } : {}),
                  ...(superagent ? { superagent } : {}),
                },
              )
            ).status,
        });
        await vi.waitFor(async () => expect(await receipts()).toHaveLength(1));
      };
      const start = () =>
        subscribeBoardEvents({
          client,
          url,
          projectId,
          store: f.store,
          workItems: f.store.workItems,
          engine: f.engine,
        });
      subscription = start();
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      const bytes = new TextEncoder().encode(
        frame(8, { ...event(), taskId: work.id }),
      );
      connections[0]!.controller.enqueue(bytes);
      await failed.promise;
      expect(report).toHaveBeenCalledExactlyOnceWith(failure);
      expect(await f.store.getCursor(cursorKey)).toBe("7");
      const saved = (await f.store.boardNotifications.get(identity))!;
      expect(saved.handled).toBe(failureAt === "cursor");
      const first = (await queue.list(router.id)).items[0];
      if (failureAt === "admission") expect(first).toBeUndefined();
      else {
        expect(first).toMatchObject({
          inputId: saved.request.inputId,
          state: "queued",
          origin: "superagent",
          superagent: { kind: "work_changed", workId: work.id },
          input: saved.request.input,
        });
        if (consume) await consumeNotification();
      }
      await subscription.close();
      await queue.dispose();
      const otherRouter = await f.harness.createSessionWithProfile({
        workspace: f.workspace,
        profileId: "router",
        isolation: "shared",
        agentRole: { kind: "router", ownerId: f.workspace },
      });
      const database = new DatabaseSync(
        join(f.directory, "state/superagent.sqlite"),
      );
      try {
        database
          .prepare(
            "UPDATE work_items SET title = ?, brief = ?, progress = ?, router_session_id = ? WHERE id = ?",
          )
          .run(
            "New title",
            "New brief",
            "New progress",
            otherRouter.id,
            work.id,
          );
      } finally {
        database.close();
      }
      await f.restart();
      queue = await openQueue();
      expect(await f.store.boardNotifications.get(identity)).toEqual(saved);
      expect((await queue.list(router.id)).items).toEqual(
        first && !consume ? [first] : [],
      );
      subscription = start();
      await vi.waitFor(() => expect(connections).toHaveLength(2));
      expect(connections[1]!.headers.get("Last-Event-ID")).toBe("7");
      connections[1]!.controller.enqueue(bytes);
      await vi.waitFor(async () =>
        expect(await f.store.getCursor(cursorKey)).toBe("8"),
      );
      const items = (await queue.list(router.id)).items;
      if (!consume) {
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          inputId: saved.request.inputId,
          input: saved.request.input,
        });
      }
      expect((await queue.list(otherRouter.id)).items).toEqual([]);
      expect(await f.store.boardNotifications.get(identity)).toBeUndefined();
      await consumeNotification();
      expect(await receipts()).toEqual([
        expect.objectContaining({
          inputId: saved.request.inputId,
          state: "consumed",
          outcome: "completed",
          input: null,
          superagent: { kind: "work_changed", workId: work.id },
        }),
      ]);
      const snapshot = await f.harness.getSession(router.id);
      expect(
        snapshot.messages.filter(
          (message) =>
            message.role === "user" &&
            message.superagent?.kind === "work_changed",
        ),
      ).toEqual([
        expect.objectContaining({
          content: saved.request.input.prompt,
          superagent: { kind: "work_changed", workId: work.id },
        }),
      ]);
      const ledger = JSON.parse(
        await readFile(
          join(f.directory, "queue/input-queue/queue.json"),
          "utf8",
        ),
      );
      expect(ledger.nextSequence).toBe(2);
      expect(ledger.items).toEqual([]);
    } finally {
      await subscription?.close();
      await queue.dispose();
      await f.close();
    }
  },
);

async function notificationFixture(worker?: "worker") {
  const f = await fixture();
  await f.ingest(trigger("admission"));
  const router = await f.router();
  await f.runNext(router.id);
  const work = worker && (await f.createWork(trigger("worker-replay")));
  const queue = await openInputQueue({
    directory: join(f.directory, "queue"),
    validateSession: async () => {},
    prepare: async (input) => ({
      input: {
        ...input,
        model: "fixture",
        mode: "build",
        permission: "workspace",
      },
      providerBinding: "a".repeat(64),
    }),
  });
  const notify = f.inputQueue.notify;
  vi.spyOn(f.inputQueue, "notify").mockImplementation((request, ...args) =>
    request.input.sessionId === router.id
      ? queue.notify(request, ...args)
      : notify(request, ...args),
  );
  return { f, router, queue, work };
}

it("resumes from a committed cursor after its acknowledgement is lost and retains the original admission", async () => {
  const { f, router, queue } = await notificationFixture();
  const { connections } = transport();
  const client = createBoardClient({
    url,
    settings: { getBoardToken: async () => "fixture-token" },
  });
  let subscription: ReturnType<typeof subscribeBoardEvents> | undefined;
  try {
    const work = await f.store.workItems.create({
      title: "Work",
      brief: "Original",
      threadIds: [],
      profileId: "worker",
      routerSessionId: router.id,
    });
    await f.store.workItems.update(work.id, { status: "blocked" });
    await f.store.setCursor(cursorKey, "7");
    const persist = f.store.setCursor;
    const failed = deferred();
    vi.spyOn(f.store, "setCursor").mockImplementationOnce(async (...args) => {
      await persist(...args);
      throw new ForgeError("storage", "Injected cursor acknowledgement loss");
    });
    vi.spyOn(f.engine, "reportBoardEventsFailure").mockImplementation(() =>
      failed.resolve(),
    );
    const start = () =>
      subscribeBoardEvents({
        client,
        url,
        projectId,
        store: f.store,
        workItems: f.store.workItems,
        engine: f.engine,
      });
    subscription = start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    connections[0]!.controller.enqueue(
      new TextEncoder().encode(frame(8, { ...event(), taskId: work.id })),
    );
    await failed.promise;
    expect(await f.store.getCursor(cursorKey)).toBe("8");
    expect(
      await f.store.boardNotifications.get({
        cursorKey,
        eventId: "8",
        workId: work.id,
      }),
    ).toBeUndefined();
    const original = (await queue.list(router.id)).items;
    expect(original).toHaveLength(1);
    await subscription.close();
    await f.restart();
    subscription = start();
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    expect(connections[1]!.headers.get("Last-Event-ID")).toBe("8");
    expect((await queue.list(router.id)).items).toEqual(original);
    await f.store.workItems.update(work.id, { progress: "Later event" });
    connections[1]!.controller.enqueue(
      new TextEncoder().encode(frame(9, { ...event(), taskId: work.id })),
    );
    await vi.waitFor(async () =>
      expect(await f.store.getCursor(cursorKey)).toBe("9"),
    );
    const items = (await queue.list(router.id)).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(original[0]);
    expect(items[1]!.inputId).not.toBe(original[0]!.inputId);
    expect(items[1]!.input?.prompt).toContain("Later event");
  } finally {
    await subscription?.close();
    await queue.dispose();
    await f.close();
  }
});

it("does not admit a notification when its Board identity cannot be persisted", async () => {
  const { f, router, queue } = await notificationFixture();
  const database = new DatabaseSync(
    join(f.directory, "state/superagent.sqlite"),
  );
  try {
    const work = await f.store.workItems.create({
      title: "Work",
      brief: "Original",
      threadIds: [],
      profileId: "worker",
      routerSessionId: router.id,
    });
    await f.store.workItems.update(work.id, { status: "blocked" });
    const identity = { cursorKey, eventId: "8", workId: work.id };
    database.exec(
      "CREATE TRIGGER fail_notification BEFORE INSERT ON board_notifications BEGIN SELECT RAISE(ABORT, 'injected admission persistence failure'); END",
    );
    await expect(f.engine.workChanged(work.id, identity)).rejects.toMatchObject(
      { code: "storage" },
    );
    expect((await queue.list(router.id)).items).toEqual([]);
    expect(await f.store.boardNotifications.get(identity)).toBeUndefined();
    database.exec("DROP TRIGGER fail_notification");
    await f.engine.workChanged(work.id, identity);
    const saved = (await f.store.boardNotifications.get(identity))!;
    expect((await queue.list(router.id)).items).toMatchObject([
      {
        inputId: saved.request.inputId,
        input: saved.request.input,
      },
    ]);
  } finally {
    database.close();
    await queue.dispose();
    await f.close();
  }
});

it("keeps Board sources, projects and later events independent when sequences and task IDs overlap", async () => {
  const { f, router, queue } = await notificationFixture();
  try {
    const work = await f.store.workItems.create({
      title: "Work",
      brief: "Original",
      threadIds: [],
      profileId: "worker",
      routerSessionId: router.id,
    });
    await f.store.workItems.update(work.id, { status: "blocked" });
    const sources = [
      cursorKey,
      `superagent:board:${JSON.stringify(["http://other-board.invalid", projectId])}`,
      `superagent:board:${JSON.stringify([url, "other-project"])}`,
    ];
    for (const [index, source] of sources.entries()) {
      await f.store.workItems.update(work.id, { progress: `Source ${index}` });
      await f.engine.workChanged(work.id, { cursorKey: source, eventId: "8" });
    }
    const original = (await queue.list(router.id)).items;
    expect(new Set(original.map((item) => item.inputId)).size).toBe(3);
    for (const [index, item] of original.entries())
      expect(item.input?.prompt).toContain(`Source ${index}`);
    await f.restart();
    await f.engine.workChanged(work.id, { cursorKey, eventId: "8" });
    expect((await queue.list(router.id)).items).toEqual(original);
    await f.store.setCursor(sources[1]!, "8");
    expect(
      await f.store.boardNotifications.get({
        cursorKey,
        eventId: "8",
        workId: work.id,
      }),
    ).toBeDefined();
    expect(await f.store.getCursor(cursorKey)).toBeUndefined();
    await f.engine.workChanged(work.id, { cursorKey, eventId: "9" });
    expect((await queue.list(router.id)).items).toHaveLength(4);
  } finally {
    await queue.dispose();
    await f.close();
  }
});

it.each([true, false])(
  "preserves a resumed Worker's actual run on replay after cancellation (handling recorded=%s)",
  async (handled) => {
    const {
      f,
      router,
      queue,
      work: seeded,
    } = await notificationFixture("worker");
    const firstGate = hold();
    const resumedGate = hold();
    let firstRun: ReturnType<typeof f.runNext> | undefined;
    let resumedRun: ReturnType<typeof f.runNext> | undefined;
    try {
      const work = seeded!;
      const worker = (await f.harness.listSessions()).find(
        (session) => session.id === work.workerSessionId,
      )!;
      firstRun = f.runNext(worker.id, [firstGate.step]);
      await firstGate.entered;
      await f.store.workItems.update(work.id, { status: "stopped" });
      const identity = { cursorKey, eventId: "8", workId: work.id };
      if (!handled)
        vi.spyOn(f.store.boardNotifications, "complete").mockRejectedValueOnce(
          new ForgeError("storage", "Injected completion failure"),
        );
      const change = f.engine.workChanged(work.id, identity);
      if (handled) await change;
      else await expect(change).rejects.toMatchObject({ code: "storage" });
      expect((await firstRun).status).toBe("cancelled");
      const original = (await queue.list(router.id)).items;
      await f.restart();
      await f.engine.resumeWorkItem(work.id);
      resumedRun = f.runNext(worker.id, [resumedGate.step]);
      await resumedGate.entered;
      const next = await f.store.workItems.create({
        title: "Later work",
        brief: "Later",
        threadIds: [],
        profileId: "worker",
        routerSessionId: router.id,
      });
      await f.engine.workChanged(work.id, identity);
      expect((await f.harness.getSession(worker.id)).status).toBe("running");
      expect((await queue.list(router.id)).items).toEqual(original);
      expect(await f.store.workItems.get(work.id)).toMatchObject({
        status: "running",
        workerSessionId: worker.id,
      });
      expect(await f.store.workItems.get(next.id)).toMatchObject({
        status: handled ? "queued" : "running",
      });
      resumedGate.release();
      expect((await resumedRun).status).toBe("completed");
    } finally {
      firstGate.release();
      resumedGate.release();
      await firstRun;
      await resumedRun;
      await queue.dispose();
      await f.close();
    }
  },
);
