import { randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { type Socket, createServer } from "node:net";
import type { DesktopRuntime } from "../desktop/runtime";
import { toErrorInfo } from "../shared/errors";
import { type RunEvent, workerRequestSchema } from "../shared/ipc";
import { hasCode } from "../store/io";
import { hostError } from "./errors";
import { MAX_REQUEST_BYTES, readFrames, sendFrame } from "./frames";
import { helloSchema, localRequestSchema } from "./protocol";
import { localSocketPath } from "./socket-path";

const MAX_EVENTS = 2048;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
export async function createLocalHost(options: {
  runtime: DesktopRuntime;
  socketPath: string;
}) {
  const path = await localSocketPath(options.socketPath, true);
  try {
    await lstat(path);
    throw hostError(
      "Socket path already exists. No file was replaced; verify the old host has exited before removing a stale socket.",
    );
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const runtime = options.runtime;
  const clients = new Map<Socket, { ready: boolean }>();
  const events: { cursor: number; data: RunEvent; bytes: number }[] = [];
  let cursor = 0;
  let eventBytes = 0;
  let closing: Promise<void> | undefined;
  const unsubscribe = runtime.subscribe((message) => {
    if (message.kind !== "event") return;
    const entry = {
      cursor: ++cursor,
      data: message.data,
      bytes: Buffer.byteLength(JSON.stringify(message.data)),
    };
    events.push(entry);
    eventBytes += entry.bytes;
    while (events.length > MAX_EVENTS || eventBytes > MAX_EVENT_BYTES)
      eventBytes -= events.shift()?.bytes ?? 0;
    for (const [socket, client] of clients)
      if (client.ready)
        sendFrame(socket, { kind: "event", cursor, data: entry.data });
  });
  const server = createServer((socket) => {
    if (clients.size >= 32) {
      socket.destroy();
      return;
    }
    const client = { ready: false };
    clients.set(socket, client);
    const connectionId = randomUUID();
    let hostId = "";
    let sequence = 0;
    let inFlight = 0;
    let hello = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const fail = (error: Error) => {
      sendFrame(socket, {
        kind: "error",
        message: toErrorInfo(error).message.slice(0, 1024),
      });
      client.ready = false;
      socket.end(() => socket.destroy());
    };
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(timer);
      clients.delete(socket);
    });
    readFrames(
      socket,
      MAX_REQUEST_BYTES,
      (raw) => {
        if (!hello) {
          hello = true;
          const parsed = helloSchema.safeParse(raw);
          if (!parsed.success)
            throw hostError(
              "Unsupported local host protocol or invalid handshake. No request was executed.",
            );
          const greeting = parsed.data;
          const state = runtime.hostState();
          hostId = state.hostId;
          if (greeting.hostId && greeting.hostId !== hostId)
            throw hostError(
              "Host instance changed. Reconnect deliberately without the old host ID; no request was executed.",
            );
          const oldest = events[0]?.cursor ?? cursor + 1;
          const reset =
            greeting.cursor === undefined ||
            greeting.cursor < oldest - 1 ||
            greeting.cursor > cursor;
          const replay = reset
            ? []
            : events
                .filter((item) => item.cursor > (greeting.cursor ?? 0))
                .map(({ bytes: _bytes, ...item }) => item);
          // State, recovery and cursor are captured synchronously: no terminal event
          // can slip between a stale state snapshot and the start of live delivery.
          if (
            sendFrame(socket, {
              kind: "hello",
              state,
              connectionId,
              cursor,
              reset,
              replay,
              recovery: reset ? runtime.recoveryEvents() : [],
            })
          ) {
            client.ready = true;
            clearTimeout(timer);
          }
          return;
        }
        if (!client.ready)
          throw hostError("Complete the local host handshake first.");
        const message = localRequestSchema.parse(raw);
        if (
          message.hostId !== hostId ||
          message.connectionId !== connectionId ||
          message.sequence !== sequence + 1
        )
          throw hostError(
            "Wrong host/connection or repeated request sequence. Nothing was replayed.",
          );
        sequence = message.sequence;
        if (!workerRequestSchema.safeParse(message.request).success)
          throw hostError(
            "This operation requires a desktop-only dialog and is unavailable through local attach.",
          );
        if (++inFlight > 128)
          throw hostError("Too many concurrent local requests.");
        // A closed socket never cancels the host operation. It only loses its reply.
        void runtime
          .request(message.request)
          .then(
            (response) => {
              sendFrame(socket, { kind: "response", response });
            },
            () => {
              fail(
                hostError(
                  "Host response unavailable; effects are uncertain. Do not retry automatically.",
                ),
              );
            },
          )
          .finally(() => {
            inFlight--;
          });
      },
      fail,
    );
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        done();
      });
    });
    await chmod(path, 0o600);
  } catch (error) {
    unsubscribe();
    for (const socket of clients.keys()) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    path,
    close(): Promise<void> {
      if (closing) return closing;
      unsubscribe();
      for (const socket of clients.keys()) socket.destroy();
      closing = new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      return closing;
    },
  };
}
