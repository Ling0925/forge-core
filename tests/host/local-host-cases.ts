import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRunEvents } from "../../src/core/runtime-events";
import { createRunState } from "../../src/core/runtime-state";
import { readFrames, sendFrame } from "../../src/host/frames";
import {
  type LocalHostClient,
  connectLocalHost,
} from "../../src/host/local-client";
import { createLocalHost } from "../../src/host/local-server";
import { localMessageSchema } from "../../src/host/protocol";
import { createRuntimeHub } from "../../src/host/runtime";
import type {
  EventSink,
  HarnessService,
  RunControl,
} from "../../src/shared/contracts";
import {
  type RunEvent,
  rpcRequestSchema,
  runEventSchema,
  workerMessageSchema,
} from "../../src/shared/ipc";
import {
  type SessionSnapshot,
  agentEventSchema,
  defaultPublicSettings,
  parseSessionId,
} from "../../src/shared/schemas";
import { extendedService } from "./service-fixture";

const sessionId = parseSessionId(randomUUID());
const timestamp = new Date().toISOString();
const snapshot: SessionSnapshot = {
  version: 1,
  id: sessionId,
  title: "Fixture",
  workspace: "/tmp",
  model: "fixture",
  createdAt: timestamp,
  updatedAt: timestamp,
  status: "completed",
  messages: [],
  events: [],
  changes: [],
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
function service(overrides: Partial<HarnessService> = {}): HarnessService {
  return {
    ...extendedService(),
    getSettings: async () => defaultPublicSettings,
    updateSettings: async () => defaultPublicSettings,
    listModels: async () => [],
    listSessions: async () => [],
    createSession: async () => snapshot,
    createSessionWithProfile: async () => snapshot,
    getSession: async () => snapshot,
    run: async () => snapshot,
    compactSession: async () => snapshot,
    cancelSession: async () => false,
    forkSession: async () => snapshot,
    renameSession: async () => snapshot,
    archiveSession: async () => snapshot,
    getDiagnostics: async () => ({
      transcriptChars: 0,
      projectedChars: 0,
      messageCount: 0,
      summaryFallback: false,
    }),
    dispose: async () => {},
    ...overrides,
  };
}
async function fixture(
  overrides: Partial<HarnessService> = {},
  options: Parameters<typeof createRuntimeHub>[1] = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "forge-host-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = createRuntimeHub(service(overrides), options);
  cleanup.push(() => runtime.dispose());
  const socketPath = join(directory, "local.sock");
  const server = await createLocalHost({ runtime, socketPath });
  cleanup.push(() => server.close());
  const connect = async (
    options: Partial<Parameters<typeof connectLocalHost>[0]> = {},
  ) => {
    const client = await connectLocalHost({ socketPath, ...options });
    cleanup.push(() => client.close());
    return client;
  };
  return { directory, runtime, socketPath, server, connect };
}
const request = (client: LocalHostClient, data: object) =>
  client.request(rpcRequestSchema.parse({ id: randomUUID(), ...data }));
const aborted = (signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) done();
    else signal.addEventListener("abort", () => done(), { once: true });
  });

export function registerLocalHostTests() {
  it.each(["compactSession", "listModels"] as const)(
    "lets %s exceed both transport deadlines",
    async (method) => {
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const entered = vi.fn();
      const f = await fixture({
        compactSession: async () => {
          entered();
          await gate;
          return snapshot;
        },
        listModels: async () => {
          entered();
          await gate;
          return [];
        },
      });
      const client = await f.connect();
      vi.useFakeTimers();
      const result = request(client, {
        method,
        ...(method === "compactSession" ? { sessionId } : { refresh: true }),
      });
      const settled = vi.fn();
      void result.then(settled, settled);
      try {
        await vi.waitFor(() => expect(entered).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(120001);
        expect(settled).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        release();
      }
      expect(await result).toMatchObject({ ok: true, method });
    },
  );

  it("discards a timed-out hub request's late response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const f = await fixture({
      createSession: async () => {
        await gate;
        return snapshot;
      },
    });
    const messages = vi.fn();
    f.runtime.subscribe(messages);
    vi.useFakeTimers();
    const result = f.runtime
      .request(
        rpcRequestSchema.parse({
          id: randomUUID(),
          method: "createSession",
          input: { workspace: "/tmp" },
        }),
      )
      .catch((error) => error);
    try {
      await vi.advanceTimersByTimeAsync(120001);
      expect(await result).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
      release();
    }
    await new Promise<void>((done) => setImmediate(done));
    expect(messages).not.toHaveBeenCalled();
  });

  it("reports malformed service events without throwing into the sink", async () => {
    let emit!: EventSink;
    const f = await fixture({
      run: async (_input, sink, _approve, signal) => {
        emit = sink;
        await aborted(signal);
        return snapshot;
      },
    });
    await f.runtime.request(
      rpcRequestSchema.parse({
        id: randomUUID(),
        method: "startRun",
        input: { sessionId, prompt: "stream" },
      }),
    );
    const received = vi.fn();
    f.runtime.subscribe(received);
    const value = {
      type: "text_delta" as const,
      sessionId,
      timestamp,
      text: "valid",
    };
    Reflect.set(value, "text", 42);
    expect(() => emit(value)).not.toThrow();
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: expect.objectContaining({
            type: "error",
            error: {
              code: "invalid_input",
              message: "Input failed validation.",
              retryable: false,
            },
          }),
        }),
      }),
    );
  });

  it("keeps the socket open on a hub timeout and does not publish its late response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const entered = vi.fn();
    const f = await fixture(
      {
        createSession: async () => {
          entered();
          await gate;
          return snapshot;
        },
      },
      { requestTimeoutMs: 1 },
    );
    const messages = vi.fn();
    f.runtime.subscribe(messages);
    const client = await f.connect({ requestTimeoutMs: 240000 });
    vi.useFakeTimers();
    try {
      const result = request(client, {
        method: "createSession",
        input: { workspace: "/tmp" },
      }).catch(() => undefined);
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(120001);
      vi.useRealTimers();
      expect(await result).toMatchObject({
        ok: false,
        error: {
          message:
            "Host response unavailable; effects are uncertain. Do not retry automatically.",
        },
      });
      expect(await request(client, { method: "getHostState" })).toMatchObject({
        ok: true,
      });
    } finally {
      vi.useRealTimers();
      release();
    }
    await new Promise<void>((done) => setImmediate(done));
    expect(messages).not.toHaveBeenCalled();
    await f.runtime.handle({ id: randomUUID(), method: "getHostState" });
    expect(messages).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "response" }),
    );
  });

  it.each(["compactSession", "listModels"] as const)(
    "cancels %s when its local client disconnects",
    async (method) => {
      let signal: AbortSignal | undefined;
      const wait = async (value?: AbortSignal) => {
        signal = value;
        if (value) await aborted(value);
      };
      const f = await fixture({
        compactSession: async (_id, signal) => {
          await wait(signal);
          return snapshot;
        },
        listModels: async (signal) => {
          await wait(signal);
          return [];
        },
      });
      const client = await f.connect();
      const result = request(client, {
        method,
        ...(method === "compactSession" ? { sessionId } : {}),
      }).catch(() => undefined);
      await vi.waitFor(() => expect(signal).toBeDefined());
      await client.close();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      await result;
    },
  );

  it("waits for cancelled run teardown beyond the transport deadline", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((done) => {
      finish = done;
    });
    const stopping = vi.fn();
    const f = await fixture(
      {
        run: async (_input, _sink, _approve, signal) => {
          await aborted(signal);
          stopping();
          await gate;
          return snapshot;
        },
      },
      { requestTimeoutMs: 1 },
    );
    const client = await f.connect({ requestTimeoutMs: 1 });
    const started = await request(client, {
      method: "startRun",
      input: { sessionId, prompt: "work" },
    });
    if (!started.ok || started.method !== "startRun")
      throw new Error("Missing run");
    const result = request(client, {
      method: "cancelRun",
      runId: started.result.runId,
      wait: true,
    });
    const settled = vi.fn();
    void result.then(settled, settled);
    await vi.waitFor(() => expect(stopping).toHaveBeenCalled());
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(120001);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      finish();
    }
    expect(await result).toMatchObject({ ok: true });
  });

  it.each(["duplicate", "mismatch", "schema"] as const)(
    "surfaces a %s approval event failure and preserves the approval reason",
    async (failure) => {
      const rejected = vi.fn();
      const throws = vi.fn();
      const f = await fixture({
        run: async (_input, sink, approve, signal) => {
          const approval = {
            id: randomUUID(),
            sessionId:
              failure === "mismatch" ? parseSessionId(randomUUID()) : sessionId,
            toolCallId: "call",
            toolName: "run_command",
            description: "fixture",
          };
          if (failure === "schema") Reflect.set(approval, "description", 42);
          const value = {
            type: "approval_requested" as const,
            sessionId,
            timestamp,
            request: approval,
          };
          if (failure === "duplicate") sink(value);
          try {
            sink(value);
          } catch (error) {
            throws(error);
          }
          try {
            await approve(approval, signal);
          } catch (error) {
            rejected(error);
          }
          return snapshot;
        },
      });
      const messages: RunEvent[] = [];
      f.runtime.subscribe((message) => {
        if (message.kind === "event") messages.push(message.data);
      });
      await f.runtime.request(
        rpcRequestSchema.parse({
          id: randomUUID(),
          method: "startRun",
          input: { sessionId, prompt: "approval" },
        }),
      );
      await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
      expect(throws).not.toHaveBeenCalled();
      expect(messages).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "error",
            error: expect.objectContaining({
              code: "invalid_input",
              message:
                failure === "schema"
                  ? "Input failed validation."
                  : "Invalid approval request.",
            }),
          }),
        }),
      );
      expect(rejected.mock.calls[0]?.[0].message).not.toContain(
        "does not match",
      );
    },
  );

  it("rejects an already claimed approval when a duplicate event arrives", async () => {
    const failure = vi.fn();
    const f = await fixture({
      run: async (_input, sink, approve, signal) => {
        const approval = {
          id: randomUUID(),
          sessionId,
          toolCallId: "call",
          toolName: "run_command",
          description: "fixture",
        };
        const value = {
          type: "approval_requested" as const,
          sessionId,
          timestamp,
          request: approval,
        };
        sink(value);
        const answer = approve(approval, signal).catch(failure);
        expect(() => sink(value)).not.toThrow();
        await answer;
        return snapshot;
      },
    });
    await f.runtime.request(
      rpcRequestSchema.parse({
        id: randomUUID(),
        method: "startRun",
        input: { sessionId, prompt: "approval" },
      }),
    );
    await vi.waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Invalid approval request." }),
      ),
    );
    expect(
      f.runtime.hostState().runs.flatMap((run) => run.pendingApprovals),
    ).toEqual([]);
  });

  it("forwards explicit request cancellation to model access without publishing the reply", async () => {
    let received: AbortSignal | undefined;
    const f = await fixture({
      modelAccess: async (_input, signal) => {
        received = signal;
        if (signal) await aborted(signal);
        return { type: "presets", presets: [] };
      },
    });
    const abort = new AbortController();
    const messages = vi.fn();
    f.runtime.subscribe(messages);
    const response = f.runtime
      .request(
        rpcRequestSchema.parse({
          id: randomUUID(),
          method: "modelAccess",
          input: { type: "presets" },
        }),
        abort.signal,
      )
      .catch((error) => error);
    await vi.waitFor(() => expect(received).toBe(abort.signal));
    const reason = new Error("caller cancelled");
    abort.abort(reason);
    expect(await response).toBe(reason);
    await new Promise<void>((done) => setImmediate(done));
    expect(messages).not.toHaveBeenCalled();
  });

  it("validates each streamed event once between runtime and subscribers", async () => {
    let emit!: ReturnType<typeof createRunEvents>;
    const f = await fixture({
      run: async (_input, sink, _approve, signal) => {
        emit = createRunEvents(
          createRunState(),
          sessionId,
          sink,
          () => timestamp,
        );
        await aborted(signal);
        return snapshot;
      },
    });
    await f.runtime.request(
      rpcRequestSchema.parse({
        id: randomUUID(),
        method: "startRun",
        input: { sessionId, prompt: "stream" },
      }),
    );
    const agentParse = vi.spyOn(agentEventSchema, "parse");
    const workerParse = vi.spyOn(workerMessageSchema, "parse");
    const runParse = vi.spyOn(runEventSchema, "parse");
    const received = vi.fn();
    f.runtime.subscribe(received);
    emit.ephemeral({ type: "text_delta", text: '"你好\n' });
    expect(
      agentParse.mock.calls.length +
        workerParse.mock.calls.length +
        runParse.mock.calls.length,
    ).toBe(1);
    expect(received).toHaveBeenCalledWith({
      kind: "event",
      data: {
        runId: expect.any(String),
        event: { type: "text_delta", text: '"你好\n', sessionId, timestamp },
      },
    });
  });

  it("serializes an event once for local subscribers and replay", async () => {
    let emit!: EventSink;
    const f = await fixture({
      run: async (_input, sink, _approve, signal) => {
        emit = sink;
        await aborted(signal);
        return snapshot;
      },
    });
    const firstEvents: RunEvent[] = [];
    const secondEvents: RunEvent[] = [];
    const first = await f.connect({
      onEvent: (event) => firstEvents.push(event),
    });
    await f.connect({ onEvent: (event) => secondEvents.push(event) });
    await request(first, {
      method: "startRun",
      input: { sessionId, prompt: "stream" },
    });
    const stringify = vi.spyOn(JSON, "stringify");
    emit({
      type: "text_delta",
      sessionId,
      timestamp,
      text: 'serialized-local-你好"\n',
    });
    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));
    const replay: RunEvent[] = [];
    await f.connect({
      hostId: f.runtime.hostState().hostId,
      cursor: 0,
      onEvent: (event) => replay.push(event),
    });
    expect(replay).toEqual(firstEvents);
    expect(secondEvents).toEqual(firstEvents);
    expect(
      stringify.mock.results.filter(
        (result) =>
          result.type === "return" &&
          result.value?.includes("serialized-local-"),
      ).length,
    ).toBe(1);
  });

  it.each(["listWorkspaceEntries", "readWorkspaceFile"] as const)(
    "does not bypass a missing service %s implementation",
    async (method) => {
      const custom = service();
      Reflect.deleteProperty(custom, method);
      const getSession = vi.spyOn(custom, "getSession");
      const runtime = createRuntimeHub(custom);
      cleanup.push(() => runtime.dispose());
      const response = await runtime.request(
        rpcRequestSchema.parse({
          id: randomUUID(),
          method,
          sessionId,
          path: ".",
        }),
      );
      expect(getSession).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        ok: false,
        error: { code: "internal" },
      });
    },
  );
  for (const command of ["steer", "cancel"] as const) {
    it.each(["count", "bytes"] as const)(
      `${command} control response survives the %s unrelated event bound`,
      async (bound) => {
        const otherId = parseSessionId(randomUUID());
        let emitOther: EventSink = () => {};
        let control: RunControl | undefined;
        let release = () => {};
        const gate = new Promise<void>((done) => {
          release = done;
        });
        const f = await fixture({
          run: async (input, emit, _approve, signal, ownedControl) => {
            if (input.sessionId === otherId) emitOther = emit;
            else control = ownedControl;
            await aborted(signal);
            if (input.sessionId !== otherId && command === "cancel") await gate;
            return { ...snapshot, id: input.sessionId, status: "cancelled" };
          },
        });
        const observer = await f.connect({ onEvent: () => {} });
        const target = await request(observer, {
          method: "startRun",
          input: { sessionId, prompt: "target" },
        });
        if (!target.ok || target.method !== "startRun")
          throw new Error("Missing target");
        const other = await request(observer, {
          method: "startRun",
          input: { sessionId: otherId, prompt: "unrelated" },
        });
        if (!other.ok || other.method !== "startRun")
          throw new Error("Missing other run");
        let requests = 0;
        const original = f.runtime.request.bind(f.runtime);
        const spy = vi.spyOn(f.runtime, "request").mockImplementation((rpc) => {
          if (rpc.method === (command === "steer" ? "steerRun" : "cancelRun"))
            requests++;
          return original(rpc);
        });
        const controlClient = await f.connect({ onEvent: () => {} });
        let answered = false;
        const done = controlClient
          .request(
            rpcRequestSchema.parse({
              id: randomUUID(),
              method: command === "steer" ? "steerRun" : "cancelRun",
              runId: target.result.runId,
              ...(command === "steer"
                ? { prompt: "continue" }
                : { wait: true }),
            }),
          )
          .then(
            (response) => ({ response }),
            (error) => ({ error }),
          )
          .finally(() => {
            answered = true;
          });
        try {
          await vi.waitFor(() => expect(requests).toBe(1));
          const count = bound === "count" ? 2100 : 34;
          for (let index = 0; index < count; index++) {
            emitOther({
              type: "text_delta",
              sessionId: otherId,
              timestamp,
              text: bound === "count" ? "x" : "x".repeat(131072),
            });
            // Keep socket flow below its per-write bound; total unread events
            // still exceed the client backlog. This is not a slow socket test.
            if (index % 8 === 0)
              await new Promise<void>((resolve) => setImmediate(resolve));
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(answered).toBe(false);
          if (command === "steer") {
            expect(control?.drainSteering()).toEqual(["continue"]);
            control?.onSteeringApplied?.();
          } else release();
          expect(await done).toMatchObject({ response: { ok: true } });
          expect(requests).toBe(1);
          expect(
            f.runtime
              .hostState()
              .runs.some((run) => run.runId === other.result.runId),
          ).toBe(true);
        } finally {
          release();
          spy.mockRestore();
        }
      },
    );
  }

  it("still bounds an unconsumed watcher and leaves the host run alive", async () => {
    let emit: EventSink = () => {};
    const f = await fixture({
      run: async (_input, sink, _approve, signal) => {
        emit = sink;
        await aborted(signal);
        return snapshot;
      },
    });
    const client = await f.connect();
    await request(client, {
      method: "startRun",
      input: { sessionId, prompt: "observe" },
    });
    for (let index = 0; index < 2100; index++) {
      emit({ type: "text_delta", sessionId, timestamp, text: "x" });
      if (index % 8 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await client.closed;
    expect(f.runtime.hostState().runs).toHaveLength(1);
  });

  it("starts through the public host client without owning the run, reconnects missed events and waits for explicit cancellation cleanup", async () => {
    let emit: EventSink = () => {};
    let release = () => {};
    const cleanupGate = new Promise<void>((done) => {
      release = done;
    });
    let abortSeen = false;
    const f = await fixture({
      run: async (_input, sink, _approve, signal) => {
        emit = sink;
        sink({
          type: "run_started",
          sessionId,
          timestamp,
          model: "fixture",
          permission: "workspace",
        });
        await aborted(signal);
        abortSeen = true;
        await cleanupGate;
        return { ...snapshot, status: "cancelled" };
      },
    });
    const submitter = await f.connect();
    const started = await request(submitter, {
      method: "startRun",
      input: { sessionId, prompt: "work" },
    });
    if (!started.ok || started.method !== "startRun")
      throw new Error("Missing run");
    const runId = started.result.runId;
    await submitter.close();
    const a = await f.connect();
    expect(a.state.runs).toMatchObject([{ runId, sessionId }]);
    expect(abortSeen).toBe(false); // The submitting connection closed; the host retains the run.
    const cursor = a.cursor;
    const hostId = a.state.hostId;
    await a.close();
    emit({
      type: "text_delta",
      sessionId,
      timestamp,
      text: "while disconnected",
    });
    const b = await f.connect({ hostId, cursor });
    expect(b.reset).toBe(false);
    const events: RunEvent[] = [];
    b.subscribe((event) => events.push(event));
    expect(
      events.some(
        (item) =>
          item.runId === runId &&
          item.event.type === "text_delta" &&
          item.event.text === "while disconnected",
      ),
    ).toBe(true);
    let replied = false;
    const cancel = request(b, { method: "cancelRun", runId, wait: true }).then(
      (result) => {
        replied = true;
        return result;
      },
    );
    try {
      await vi.waitFor(() => expect(abortSeen).toBe(true));
      expect(replied).toBe(false);
      expect(f.runtime.hostState().runs).toMatchObject([
        { runId, stopping: true },
      ]);
    } finally {
      release();
    }
    expect(await cancel).toMatchObject({ ok: true });
    expect(f.runtime.hostState().runs).toEqual([]);
    expect(
      await request(b, { method: "cancelRun", runId, wait: true }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("shares pending approval identity and allows only one of two racing answers", async () => {
    let answers = 0;
    const approvalId = randomUUID();
    const f = await fixture({
      run: async (_input, emit, approve, signal) => {
        const approval = {
          id: approvalId,
          sessionId,
          toolCallId: "call",
          toolName: "run_command",
          description: "Fixture",
        };
        emit({
          type: "approval_requested",
          sessionId,
          timestamp,
          request: approval,
        });
        if (await approve(approval, signal)) answers++;
        return snapshot;
      },
    });
    const a = await f.connect();
    const start = await request(a, {
      method: "startRun",
      input: { sessionId, prompt: "work" },
    });
    if (!start.ok || start.method !== "startRun")
      throw new Error("Missing run");
    const b = await f.connect();
    expect(b.state.hostId).toBe(a.state.hostId);
    expect(b.state.runs).toMatchObject([
      { runId: start.result.runId, pendingApprovals: [{ id: approvalId }] },
    ]);
    expect(
      b.recovery.some((item) => item.event.type === "approval_requested"),
    ).toBe(true);
    const results = await Promise.all(
      [a, b].map((client) =>
        request(client, {
          method: "answerApproval",
          runId: start.result.runId,
          approvalId,
          approved: true,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    await vi.waitFor(() => expect(answers).toBe(1));
  });

  it("fails explicitly for changed host identity, nonexistent or occupied socket paths, and incompatible protocols", async () => {
    const f = await fixture();
    await expect(f.connect({ hostId: randomUUID() })).rejects.toThrow(
      "Host instance changed",
    );
    await expect(
      connectLocalHost({ socketPath: join(f.directory, "missing.sock") }),
    ).rejects.toThrow();
    const occupied = join(f.directory, "occupied.sock");
    await writeFile(occupied, "keep me", { mode: 0o600 });
    await expect(
      createLocalHost({ runtime: f.runtime, socketPath: occupied }),
    ).rejects.toThrow("No file was replaced");
    expect(await readFile(occupied, "utf8")).toBe("keep me");
    const socket = createConnection(f.socketPath);
    const reply = new Promise<unknown>((done) =>
      readFrames(socket, 10000, done, (error) => done(error)),
    );
    sendFrame(socket, { kind: "hello", protocolVersion: 999 });
    expect(await reply).toMatchObject({ kind: "error" });
    socket.destroy();
  });

  it("rejects repeated wire sequences and old connection envelopes instead of repeating effects", async () => {
    let creates = 0;
    const f = await fixture({
      createSession: async () => {
        creates++;
        return snapshot;
      },
    });
    const wire = async () => {
      const socket = createConnection(f.socketPath);
      cleanup.push(async () => socket.destroy());
      const messages: unknown[] = [];
      readFrames(
        socket,
        100000,
        (value) => messages.push(value),
        () => socket.destroy(),
      );
      sendFrame(socket, { kind: "hello", protocolVersion: 1 });
      await vi.waitFor(() => expect(messages.length).toBe(1));
      const hello = localMessageSchema.parse(messages[0]);
      if (hello.kind !== "hello") throw new Error("Missing hello");
      return { socket, messages, hello };
    };
    const first = await wire();
    const envelope = {
      kind: "request",
      hostId: first.hello.state.hostId,
      connectionId: first.hello.connectionId,
      sequence: 1,
      request: {
        id: randomUUID(),
        method: "createSession",
        input: { workspace: "/tmp" },
      },
    };
    sendFrame(first.socket, envelope);
    sendFrame(first.socket, envelope);
    await vi.waitFor(() =>
      expect(
        first.messages.some(
          (value) => localMessageSchema.parse(value).kind === "error",
        ),
      ).toBe(true),
    );
    expect(creates).toBe(1);
    const second = await wire();
    sendFrame(second.socket, envelope);
    await vi.waitFor(() => expect(second.messages).toHaveLength(2));
    expect(second.messages[1]).toMatchObject({ kind: "error" });
    expect(creates).toBe(1);
  });

  it("times out without replay, rejects duplicate client request IDs and reports an event retention gap", async () => {
    let creates = 0;
    let release = () => {};
    let emit: EventSink = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const f = await fixture({
      createSession: async () => {
        creates++;
        await gate;
        return snapshot;
      },
      run: async (_input, sink, _approve, signal) => {
        emit = sink;
        await aborted(signal);
        return snapshot;
      },
    });
    const a = await f.connect({ requestTimeoutMs: 10 });
    const rpc = rpcRequestSchema.parse({
      id: randomUUID(),
      method: "createSession",
      input: { workspace: "/tmp" },
    });
    try {
      await expect(a.request(rpc)).rejects.toThrow("effects are uncertain");
    } finally {
      release();
    }
    await expect(a.request(rpc)).rejects.toThrow("Duplicate request ID");
    expect(creates).toBe(1);
    await request(a, {
      method: "startRun",
      input: { sessionId, prompt: "work" },
    });
    await a.close();
    for (let i = 0; i < 2100; i++)
      emit({ type: "text_delta", sessionId, timestamp, text: "x" });
    const b = await f.connect({
      hostId: f.runtime.hostState().hostId,
      cursor: 0,
    });
    expect(b.reset).toBe(true);
    expect(
      b.recovery.some(
        (item) =>
          item.event.type === "text_delta" && item.event.text.length === 2100,
      ),
    ).toBe(true);
  });
}
