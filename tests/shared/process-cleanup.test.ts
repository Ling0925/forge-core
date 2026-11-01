import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProcessGroup } from "../../src/store/process-cleanup";

const ps = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: ps,
}));

let snapshot: string;
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "kill").mockReturnValue(true);
  snapshot = "101 101 S Fri Oct 30 02:59:00 2026";
  ps.mockImplementation((_command, _args, _options, callback) =>
    callback(null, snapshot),
  );
});
afterEach(() => vi.restoreAllMocks());

it("does not signal a group whose start-time identity changed between TERM and KILL", async () => {
  const signal = createProcessGroup(
    Object.assign(new ChildProcess(), { pid: 101 }),
  );
  expect(await signal("SIGTERM")).toBe(true);
  snapshot = "101 101 S Fri Oct 30 03:00:00 2026";
  expect(await signal("SIGKILL")).toBe(false);
  expect(await signal("SIGKILL")).toBe(false);
  expect(process.kill).toHaveBeenCalledExactlyOnceWith(-101, "SIGTERM");
});

it("retains descendant ownership after the leader exits", async () => {
  const signal = createProcessGroup(
    Object.assign(new ChildProcess(), { pid: 101 }),
  );
  expect(await signal("SIGTERM")).toBe(true);
  snapshot += "\n102 101 S Fri Oct 30 02:59:01 2026";
  expect(await signal(0)).toBe(true);
  snapshot = "102 101 S Fri Oct 30 02:59:01 2026";
  expect(await signal("SIGKILL")).toBe(true);
  expect(vi.mocked(process.kill).mock.calls).toEqual([
    [-101, "SIGTERM"],
    [-101, "SIGKILL"],
  ]);
});

it("does not signal groups containing only exited members", async () => {
  snapshot = "101 101 Z Fri Oct 30 02:59:00 2026";
  const signal = createProcessGroup(
    Object.assign(new ChildProcess(), { pid: 101 }),
  );
  expect(await signal("SIGKILL")).toBe(false);
  expect(process.kill).not.toHaveBeenCalled();
});
