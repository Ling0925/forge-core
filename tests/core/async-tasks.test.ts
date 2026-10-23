import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAsyncTaskService } from "../../src/core/async-tasks";
import {
  type AsyncTaskService,
  type AsyncTaskStart,
  asyncTaskArguments,
} from "../../src/shared/async-tasks";
import { ForgeError } from "../../src/shared/errors";
import { parseSessionId } from "../../src/shared/schemas";
import type { ToolResult } from "../../src/shared/schemas";
import { atomicJson } from "../../src/store/io";
import * as io from "../../src/store/io";
import { createAsyncTaskToolRegistry } from "../../src/tools/async-tasks";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
let root: string;
let service: AsyncTaskService;
const notify = vi.fn(async (_request: unknown) => {});
const sessionId = parseSessionId(randomUUID());
const childId = parseSessionId(randomUUID());
const otherId = parseSessionId(randomUUID());
const context = (id = sessionId) => ({
  sessionId: id,
  permission: "unrestricted" as const,
  signal: new AbortController().signal,
});
const start = (extra: Partial<AsyncTaskStart> = {}) =>
  service.start({
    tool: "test_job",
    sessionId,
    wakeSessionId: sessionId,
    resume: { model: "fixture-model", permission: "unrestricted" },
    signal: new AbortController().signal,
    execute: async () => ({ content: "done", isError: false }),
    ...extra,
  });
const manage = async (
  action: string,
  id?: string,
  extra: object = {},
  ctx = context(),
) =>
  JSON.parse(
    (
      await service.manage(
        asyncTaskArguments.parse({ action, ...(id ? { id } : {}), ...extra }),
        ctx,
      )
    ).content,
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-async-tasks-"));
  notify.mockReset();
  notify.mockResolvedValue(undefined);
  service = await openAsyncTaskService({ directory: root, notify });
});
afterEach(async () => {
  await service.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("host-owned async task lifecycle", () => {
  it("returns before work completes, persists before notification, accounts usage and paginates results", async () => {
    const done = deferred<ToolResult>();
    const task = await start({
      execute: async (_signal, usage) => {
        usage({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
        return done.promise;
      },
    });
    expect(task.status).toBe("running");
    expect((await manage("read", task.id)).outputAvailable).toBe(false);
    expect((await manage("wait", task.id, { timeout_ms: 1 })).status).toBe(
      "running",
    );
    expect(notify).not.toHaveBeenCalled();
    notify.mockImplementation(async () => {
      const disk = JSON.parse(
        await readFile(join(root, "async-tasks", `${task.id}.json`), "utf8"),
      );
      expect(disk).toMatchObject({
        status: "completed",
        output: expect.stringContaining("abcdef"),
      });
    });
    done.resolve({
      content: JSON.stringify({ answer: "abcdef" }),
      isError: false,
    });
    await vi.waitFor(async () =>
      expect((await manage("read", task.id)).notification).toBe("queued"),
    );
    const first = await manage("read", task.id, { limit: 7 });
    const second = await manage("read", task.id, { offset: first.nextOffset });
    expect(JSON.parse(first.output + second.output)).toMatchObject({
      content: { answer: "abcdef" },
    });
    expect(second.nextOffset).toBeNull();
    expect(first).toMatchObject({
      usage: { totalTokens: 12 },
      usageComplete: true,
      persisted: true,
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        inputId: task.id,
        input: expect.objectContaining({
          sessionId,
          model: "fixture-model",
          prompt: expect.stringContaining(task.id),
        }),
      }),
    );
    await manage("wake", task.id);
    await manage("wake", task.id);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("restricts ownership to initiating/main sessions and permits only read operations in readonly mode", async () => {
    const task = await start({ sessionId: childId });
    await manage("wait", task.id);
    expect(
      (await manage("list", undefined, {}, context(childId))).tasks,
    ).toHaveLength(1);
    expect(
      (await manage("list", undefined, {}, context(otherId))).tasks,
    ).toEqual([]);
    await expect(
      manage("read", task.id, {}, context(otherId)),
    ).rejects.toMatchObject({ code: "not_found" });
    for (const action of ["stop", "wake"])
      await expect(
        service.manage(asyncTaskArguments.parse({ action, id: task.id }), {
          ...context(),
          permission: "readonly",
        }),
      ).rejects.toMatchObject({ code: "tool" });
    expect(
      JSON.parse(
        (
          await service.manage(
            asyncTaskArguments.parse({ action: "read", id: task.id }),
            { ...context(), permission: "readonly" },
          )
        ).content,
      ).status,
    ).toBe("completed");
  });

  it("wait cancellation does not cancel work; stop joins actual cooperative cleanup and suppresses wake", async () => {
    const abortSeen = deferred<void>();
    const cleanup = deferred<void>();
    let finished = false;
    const task = await start({
      execute: async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              abortSeen.resolve();
              resolve();
            },
            { once: true },
          );
        });
        await cleanup.promise;
        finished = true;
        throw new ForgeError("cancelled", "Stopped");
      },
    });
    const waiter = new AbortController();
    const waiting = service.manage(
      asyncTaskArguments.parse({ action: "wait", id: task.id }),
      { ...context(), signal: waiter.signal },
    );
    waiter.abort();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    expect((await manage("read", task.id)).status).toBe("running");
    let stopped = false;
    const stopping = manage("stop", task.id).then((value) => {
      stopped = true;
      return value;
    });
    await abortSeen.promise;
    expect(finished).toBe(false);
    expect(stopped).toBe(false);
    cleanup.resolve();
    expect(await stopping).toMatchObject({
      status: "cancelled",
      notification: "suppressed",
    });
    expect(finished).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("joins work on caller cancellation and on service disposal, including delegated jobs", async () => {
    const caller = new AbortController();
    const execute: AsyncTaskStart["execute"] = (signal) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(new ForgeError("cancelled", "cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    const first = await start({ signal: caller.signal, execute });
    caller.abort();
    await manage("wait", first.id);
    expect((await manage("read", first.id)).status).toBe("cancelled");
    const second = await start({ sessionId: childId, execute });
    expect(await service.cancelSession(sessionId)).toBe(true);
    expect((await manage("read", second.id)).status).toBe("cancelled");
    const third = await start({ execute });
    await service.dispose();
    expect(
      JSON.parse(
        await readFile(join(root, "async-tasks", `${third.id}.json`), "utf8"),
      ).status,
    ).toBe("cancelled");
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not mislabel a committed success when cancellation races the return", async () => {
    const done = deferred<ToolResult>();
    const task = await start({ execute: () => done.promise });
    const stopping = manage("stop", task.id);
    done.resolve({ content: "already committed", isError: false });
    expect(await stopping).toMatchObject({
      status: "completed",
      resultIsError: false,
      notification: "suppressed",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("reserves bounded capacity before persistence and releases active slots after cleanup", async () => {
    const done = deferred<ToolResult>();
    const tasks = await Promise.all(
      Array.from({ length: 4 }, () => start({ execute: () => done.promise })),
    );
    const extra = vi.fn(async () => ({
      content: "must not run",
      isError: false,
    }));
    await expect(start({ execute: extra })).rejects.toMatchObject({
      code: "busy",
    });
    expect(extra).not.toHaveBeenCalled();
    done.resolve({ content: "done", isError: false });
    await Promise.all(tasks.map((task) => manage("wait", task.id)));
    await expect(start()).resolves.toMatchObject({ tool: "test_job" });
  });

  it("redacts decoded content before paging/persistence and bounds multibyte output", async () => {
    const secret = 'private\n"value';
    const task = await start({
      execute: async () => ({
        content: JSON.stringify({ secret, body: "中文🙂".repeat(25000) }),
        isError: false,
      }),
      redact: (text) => text.split(secret).join("[REDACTED]"),
    });
    await manage("wait", task.id);
    const record = JSON.parse(
      await readFile(join(root, "async-tasks", `${task.id}.json`), "utf8"),
    );
    expect(record.output).toContain("[REDACTED]");
    expect(record.output).not.toContain("private");
    expect(Buffer.byteLength(record.output)).toBeLessThanOrEqual(128 * 1024);
    expect(record.output).not.toContain("�");
    expect(record.outputTruncated).toBe(true);
  });

  it("records failures once, and explicitly retries only a failed notification with the same id/input", async () => {
    notify.mockRejectedValueOnce(new Error("delivery unavailable"));
    const execute = vi.fn(async () => {
      throw new Error("private upstream exception");
    });
    const task = await start({ execute });
    await vi.waitFor(async () =>
      expect((await manage("read", task.id)).notification).toBe("failed"),
    );
    const report = await manage("read", task.id);
    expect(report).toMatchObject({ status: "failed", resultIsError: true });
    expect(report.output).not.toContain("private upstream");
    await manage("wake", task.id);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]).toEqual(notify.mock.calls[1]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rechecks a manual wake's live permission after persistence and before delivery", async () => {
    notify.mockRejectedValueOnce(new Error("offline"));
    const task = await start();
    await manage("wait", task.id);
    expect((await manage("read", task.id)).notification).toBe("failed");
    let permission: "unrestricted" | "readonly" = "unrestricted";
    const write = io.atomicJson;
    vi.spyOn(io, "atomicJson").mockImplementation(async (...args) => {
      permission = "readonly";
      return write(...args);
    });
    await expect(
      service.manage(
        asyncTaskArguments.parse({ action: "wake", id: task.id }),
        {
          ...context(),
          get permission() {
            return permission;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "tool" });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("retains completed results on restart, interrupts uncertain work and recovers only pending notifications", async () => {
    const task = await start();
    await manage("wait", task.id);
    await service.dispose();
    const path = join(root, "async-tasks", `${task.id}.json`);
    const disk = JSON.parse(await readFile(path, "utf8"));
    await atomicJson(path, { ...disk, notification: "pending" });
    notify.mockClear();
    service = await openAsyncTaskService({ directory: root, notify });
    await vi.waitFor(async () =>
      expect((await manage("read", task.id)).notification).toBe("queued"),
    );
    expect(notify).toHaveBeenCalledOnce();
    await service.dispose();
    await atomicJson(path, {
      ...disk,
      status: "running",
      output: undefined,
      notification: "pending",
    });
    notify.mockClear();
    service = await openAsyncTaskService({ directory: root, notify });
    expect(await manage("read", task.id)).toMatchObject({
      status: "interrupted",
      notification: "suppressed",
      usageComplete: false,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("never starts work without a durable intent and never replays effects on final persistence failure", async () => {
    const write = io.atomicJson;
    vi.spyOn(io, "atomicJson").mockRejectedValueOnce(
      new ForgeError("storage", "fixture write failure"),
    );
    const never = vi.fn(async () => ({ content: "unused", isError: false }));
    await expect(start({ execute: never })).rejects.toMatchObject({
      code: "storage",
    });
    expect(never).not.toHaveBeenCalled();
    expect((await manage("list")).tasks).toEqual([]);
    let writes = 0;
    vi.mocked(io.atomicJson).mockImplementation(async (...args) => {
      if (++writes === 2)
        throw new ForgeError("storage", "fixture final write failure");
      return write(...args);
    });
    const once = vi.fn(async () => ({ content: "committed", isError: false }));
    const task = await start({ execute: once });
    expect(await manage("wait", task.id)).toMatchObject({
      status: "completed",
      persisted: false,
    });
    expect(notify).not.toHaveBeenCalled();
    await manage("wake", task.id);
    expect(once).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect((await manage("read", task.id)).persisted).toBe(true);
  });

  it("contains result/adapter failures without an unhandled rejection or leaking exception text", async () => {
    const task = await start({
      redact: () => {
        throw new Error("private redactor failure");
      },
    });
    const report = await manage("wait", task.id);
    expect(report).toMatchObject({ status: "failed", persisted: true });
    expect(report.output).toContain("could not be safely captured");
    expect(report.output).not.toContain("private redactor");
  });

  it("has a single owner and the tool facade neither adopts another owner nor disposes host work", async () => {
    await expect(
      openAsyncTaskService({ directory: root, notify }),
    ).rejects.toMatchObject({ code: "busy" });
    const facade = createAsyncTaskToolRegistry(async () => service);
    await facade.dispose();
    const call = {
      id: "call",
      type: "function" as const,
      function: { name: "async_task", arguments: '{"action":"list"}' },
    };
    const ctx = {
      ...context(),
      workspace: root,
      toolCallId: "call",
      onEvent: () => {},
      approve: async () => false,
    };
    expect((await facade.execute(call, ctx)).isError).toBe(false);
    expect(
      (
        await facade.execute(
          {
            ...call,
            function: {
              ...call.function,
              arguments: '{"action":"wake","id":"bad"}',
            },
          },
          ctx,
        )
      ).isError,
    ).toBe(true);
  });
});
