import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { subscribeBoardEvents } from "../../src/host/board-events";
import {
  ForgeError,
  type WorkItem,
  workerMessageSchema,
} from "../../src/shared";
import { superAgentStateSchema } from "../../src/shared/superagent";
import { createBoardClient, openSuperAgentStore } from "../../src/store";
import { deferred, fixture } from "./fixture";

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
