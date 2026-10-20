/** A test-only duplex transport. Does not validate real Linux socket behavior. */
import { EventEmitter } from "node:events";
import { unlinkSync, writeFileSync } from "node:fs";
import { Duplex } from "node:stream";
const servers = new Map<string, MemoryServer>();
class MemorySocket extends Duplex {
  peer?: MemorySocket;
  constructor() {
    super({ allowHalfOpen: false });
  }
  override _read() {}
  override _write(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ) {
    if (!this.peer || this.peer.destroyed) {
      callback(new Error("Connection closed"));
      return;
    }
    this.peer.push(Buffer.from(chunk));
    callback();
  }
  override _final(callback: () => void) {
    this.peer?.push(null);
    callback();
  }
  override _destroy(
    error: Error | null,
    callback: (error: Error | null) => void,
  ) {
    this.peer?.push(null);
    callback(error);
  }
}
class MemoryServer extends EventEmitter {
  listening = false;
  private path = "";
  constructor(private connected: (socket: MemorySocket) => void) {
    super();
  }
  listen(path: string, done: () => void) {
    this.path = path;
    queueMicrotask(() => {
      if (servers.has(path)) {
        this.emit("error", new Error("Address already in use"));
        return;
      }
      writeFileSync(path, "TEST TRANSPORT", { mode: 0o600 });
      servers.set(path, this);
      this.listening = true;
      done();
    });
  }
  connect(socket: MemorySocket) {
    this.connected(socket);
  }
  close(done: (error?: Error) => void) {
    servers.delete(this.path);
    this.listening = false;
    try {
      unlinkSync(this.path);
    } catch {
      /* Fixture may already be cleaned. */
    }
    queueMicrotask(() => done());
  }
}
export const createServer = (connected: (socket: MemorySocket) => void) =>
  new MemoryServer(connected);
export const createConnection = (path: string) => {
  const client = new MemorySocket();
  const server = new MemorySocket();
  client.peer = server;
  server.peer = client;
  queueMicrotask(() => {
    const owner = servers.get(path);
    if (!owner) {
      client.destroy(new Error("Connection refused"));
      return;
    }
    owner.connect(server);
    client.emit("connect");
  });
  return client;
};
export function verifyMemorySocket(path: string) {
  if (!servers.has(path)) throw new Error("Test transport is unavailable.");
}
