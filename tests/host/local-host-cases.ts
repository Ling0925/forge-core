import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { type RunEvent, rpcRequestSchema } from "../../src/shared/ipc";
import {
  type SessionSnapshot,
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
async function fixture(overrides: Partial<HarnessService> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "forge-host-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = createRuntimeHub(service(overrides));
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
              ...(command === "steer" ? { prompt: "continue" } : { wait: true }),
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
