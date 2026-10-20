import { createConnection } from "node:net";
import { ForgeError } from "../shared/errors";
import { HOST_PROTOCOL_VERSION, type HostState } from "../shared/host";
import {
  type RpcRequest,
  type RpcResponse,
  type RunEvent,
  rpcRequestSchema,
} from "../shared/ipc";
import { hostError } from "./errors";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  readFrames,
  sendFrame,
} from "./frames";
import { localMessageSchema } from "./protocol";
import { localSocketPath, verifyLocalSocket } from "./socket-path";

export interface LocalHostClient {
  readonly state: HostState;
  readonly cursor: number;
  readonly reset: boolean;
  readonly recovery: readonly RunEvent[];
  readonly closed: Promise<void>;
  request(request: RpcRequest): Promise<RpcResponse>;
  subscribe(listener: (event: RunEvent, cursor: number) => void): () => void;
  close(): Promise<void>;
}
export async function connectLocalHost(options: {
  socketPath: string;
  hostId?: string;
  cursor?: number;
  requestTimeoutMs?: number;
  /** Install before handshake/replay; RPC-only clients may explicitly discard events. */
  onEvent?: (event: RunEvent, cursor: number) => void;
}): Promise<LocalHostClient> {
  if (options.cursor !== undefined && !options.hostId)
    throw hostError(
      "An event cursor must be paired with its original host ID.",
    );
  const path = await localSocketPath(options.socketPath);
  await verifyLocalSocket(path);
  const socket = createConnection(path);
  let connectionId = "";
  let state: HostState | undefined;
  let sequence = 0;
  let cursor = 0;
  let reset = false;
  let recovery: readonly RunEvent[] = [];
  let settled = false;
  let disconnected = false;
  let error: Error | undefined;
  const listeners = new Set<(event: RunEvent, cursor: number) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  const buffer: { data: RunEvent; cursor: number }[] = [];
  let bufferedBytes = 0;
  const used = new Set<string>();
  const pending = new Map<
    string,
    {
      method: RpcRequest["method"];
      resolve(value: RpcResponse): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let resolveHello: () => void = () => {};
  let rejectHello: (error: Error) => void = () => {};
  const hello = new Promise<void>((done, reject) => {
    resolveHello = done;
    rejectHello = reject;
  });
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((done) => {
    resolveClosed = done;
  });
  const fail = (reason: Error) => {
    error =
      reason instanceof ForgeError
        ? reason
        : hostError(
            "Local host protocol or connection failed; pending effects may be uncertain. No execution instance was created and nothing was replayed.",
          );
    if (!settled) {
      settled = true;
      rejectHello(error);
    }
    socket.destroy();
  };
  const timer = setTimeout(
    () =>
      fail(
        hostError(
          "Local host handshake timed out. No execution instance was created.",
        ),
      ),
    5000,
  );
  const deliver = (data: RunEvent, at: number) => {
    if (!listeners.size) {
      buffer.push({ data, cursor: at });
      bufferedBytes += Buffer.byteLength(JSON.stringify(data));
      if (buffer.length > 2048 || bufferedBytes > 4 * 1024 * 1024)
        fail(
          hostError(
            "Local event backlog exceeded its bound. Reconnect without a cursor for recovery state.",
          ),
        );
    } else
      for (const listener of listeners) {
        try {
          listener(data, at);
        } catch {
          /* Isolate observers. */
        }
      }
  };
  socket.on("connect", () =>
    sendFrame(
      socket,
      {
        kind: "hello",
        protocolVersion: HOST_PROTOCOL_VERSION,
        ...(options.hostId ? { hostId: options.hostId } : {}),
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      },
      MAX_REQUEST_BYTES,
    ),
  );
  socket.on("error", fail);
  socket.on("close", () => {
    disconnected = true;
    clearTimeout(timer);
    const reason =
      error ??
      hostError(
        "Local host connection closed; pending effects are uncertain. Nothing was automatically replayed.",
      );
    if (!settled) {
      settled = true;
      rejectHello(reason);
    }
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
    listeners.clear();
    resolveClosed();
  });
  readFrames(
    socket,
    MAX_RESPONSE_BYTES,
    (raw) => {
      const message = localMessageSchema.parse(raw);
      if (message.kind === "error")
        throw hostError(
          Array.from(message.message, (char) =>
            char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
          ).join(""),
        );
      if (!state) {
        if (message.kind !== "hello")
          throw hostError("Local host did not send a compatible handshake.");
        if (options.hostId && message.state.hostId !== options.hostId)
          throw hostError("Local host identity changed.");
        state = message.state;
        connectionId = message.connectionId;
        cursor = message.cursor;
        reset = message.reset;
        recovery = message.recovery;
        for (const event of message.replay) deliver(event.data, event.cursor);
        clearTimeout(timer);
        settled = true;
        resolveHello();
        return;
      }
      if (message.kind === "hello")
        throw hostError("Repeated local host handshake.");
      if (message.kind === "event") {
        if (message.cursor <= cursor)
          throw hostError("Local event cursor moved backwards.");
        cursor = message.cursor;
        deliver(message.data, cursor);
        return;
      }
      const entry = pending.get(message.response.id);
      if (!entry) return; // A timed-out request is never retried, even if its late reply arrives.
      if (entry.method !== message.response.method)
        throw hostError("Local host response correlation failed.");
      pending.delete(message.response.id);
      clearTimeout(entry.timer);
      entry.resolve(message.response);
    },
    fail,
  );
  await hello;
  if (!state) throw hostError("Missing local host state.");
  const connectedState = state;
  return {
    state: connectedState,
    get cursor() {
      return cursor;
    },
    reset,
    recovery,
    closed,
    request(raw) {
      if (disconnected || socket.destroyed)
        return Promise.reject(
          error ??
            hostError("Local host is disconnected. Effects were not replayed."),
        );
      const request = rpcRequestSchema.parse(raw);
      if (used.has(request.id))
        return Promise.reject(
          hostError("Duplicate request ID; nothing was replayed."),
        );
      if (used.size >= 4096 || pending.size >= 128)
        return Promise.reject(
          hostError(
            "Local connection request bound reached. Reconnect explicitly; do not replay uncertain requests.",
          ),
        );
      used.add(request.id);
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(
            hostError(
              `Host request ${request.id} timed out; its effects are uncertain. Nothing was replayed.`,
            ),
          );
        }, options.requestTimeoutMs ?? 120000);
        pending.set(request.id, {
          method: request.method,
          resolve,
          reject,
          timer,
        });
        sendFrame(
          socket,
          {
            kind: "request",
            hostId: connectedState.hostId,
            connectionId,
            sequence: ++sequence,
            request,
          },
          MAX_REQUEST_BYTES,
        );
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      for (const event of buffer.splice(0)) {
        try {
          listener(event.data, event.cursor);
        } catch {
          /* Observer isolation. */
        }
      }
      bufferedBytes = 0;
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      socket.destroy();
      await closed;
    },
  };
}
