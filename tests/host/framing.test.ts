import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  MAX_RESPONSE_BYTES,
  readFrames,
  sendFrame,
} from "../../src/host/frames";
import { localSocketPath, verifyLocalSocket } from "../../src/host/socket-path";

it("frames split UTF-8 and multiple messages with per-frame byte bounds", () => {
  const socket = new EventEmitter() as Socket;
  const receive = vi.fn();
  const fail = vi.fn();
  readFrames(socket, 16, receive, fail);
  const bytes = Buffer.from('"你好"\n{"a":1}\n');
  for (const byte of bytes) socket.emit("data", Buffer.from([byte]));
  expect(receive.mock.calls.map((call) => call[0])).toEqual(["你好", { a: 1 }]);
  expect(fail).not.toHaveBeenCalled();
  socket.emit("data", Buffer.from("x".repeat(17)));
  expect(fail).toHaveBeenCalledTimes(1);
  socket.emit("data", Buffer.from('"ignored"\n'));
  expect(receive).toHaveBeenCalledTimes(2);
});
it("rejects malformed UTF-8 and bounds writes and slow-client buffers", () => {
  const socket = new EventEmitter() as Socket;
  const fail = vi.fn();
  readFrames(socket, 16, vi.fn(), fail);
  socket.emit("data", Buffer.from([34, 255, 34, 10]));
  expect(fail).toHaveBeenCalledTimes(1);
  const write = vi.fn();
  const destroy = vi.fn();
  const out = {
    destroyed: false,
    writableLength: MAX_RESPONSE_BYTES,
    write,
    destroy,
  } as unknown as Socket;
  expect(sendFrame(out, { data: "small" })).toBe(false);
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
});
it("rejects public directories, symlinks, non-sockets and unsafe paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-socket-path-"));
  try {
    expect(await localSocketPath(join(directory, "host.sock"))).toBe(
      join(directory, "host.sock"),
    );
    await writeFile(join(directory, "regular"), "fixture", { mode: 0o600 });
    await expect(verifyLocalSocket(join(directory, "regular"))).rejects.toThrow(
      "not private",
    );
    await symlink(directory, join(directory, "link"));
    await expect(
      localSocketPath(join(directory, "link", "host.sock")),
    ).rejects.toThrow("private directory");
    await expect(localSocketPath("relative.sock")).rejects.toThrow(
      "absolute Linux",
    );
    await expect(localSocketPath(`/${"x".repeat(101)}`)).rejects.toThrow(
      "100 bytes",
    );
    await chmod(directory, 0o755);
    await expect(localSocketPath(join(directory, "host.sock"))).rejects.toThrow(
      "private directory",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
