import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentWorktreeService } from "../../src/core/agent-worktrees";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  ...mocks,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])(
  "checks process identity before worktree escalation (replaced: %s)",
  async (replaced) => {
    const root = await mkdtemp(join(tmpdir(), "forge-worktree-cleanup-"));
    const child = Object.assign(new ChildProcess(), { pid: 101 });
    const controller = new AbortController();
    let snapshot = "101 101 S Fri Oct 30 02:59:00 2026";
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "kill").mockReturnValue(true);
    mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(null, snapshot),
    );
    let spawned = () => {};
    const ready = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    mocks.spawn.mockImplementation(() => {
      spawned();
      return child;
    });
    vi.useFakeTimers();
    const work = createAgentWorktreeService(join(root, "state")).create({
      workspace: root,
      sessionId: "00000000-0000-4000-8000-000000000001",
      signal: controller.signal,
    });
    const cancelled = expect(work).rejects.toMatchObject({ code: "cancelled" });
    try {
      await ready;
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(-101, "SIGTERM");
      if (replaced) snapshot = "101 101 S Fri Oct 30 03:00:00 2026";
      await vi.advanceTimersToNextTimerAsync();
      expect(vi.mocked(process.kill).mock.calls).toEqual(
        replaced
          ? [[-101, "SIGTERM"]]
          : [
              [-101, "SIGTERM"],
              [-101, "SIGKILL"],
            ],
      );
    } finally {
      child.emit("close", null);
      await cancelled;
      await rm(root, { recursive: true, force: true });
    }
  },
);
