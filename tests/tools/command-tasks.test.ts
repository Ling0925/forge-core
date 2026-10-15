import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId, toolDefinitionSchema, toolResultSchema } from "../../src/shared/schemas";
import type { ToolCall, ToolResult } from "../../src/shared/schemas";
import { withCommandTasks } from "../../src/tools/command-tasks";
import { createLocalToolRegistry } from "../../src/tools/local";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value), isError };
}
function output(value: ToolResult) {
  toolResultSchema.parse(value);
  return JSON.parse(value.content);
}
function call(name: string, args: unknown): ToolCall {
  return { id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function context(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: parseSessionId(randomUUID()), toolCallId: "call", workspace: ".",
    permission: "workspace", signal: new AbortController().signal,
    approve: async () => true, onEvent: () => {}, ...extra,
  };
}
function fake(execute: LocalToolRegistry["execute"], dispose = vi.fn(async () => {})): LocalToolRegistry {
  return {
    definitions: [{ type: "function", function: {
      name: "run_command", description: "Base command limits.",
      parameters: { type: "object", properties: { argv: { type: "array" } }, required: ["argv"], additionalProperties: false },
    } }], execute, dispose,
  };
}
function controlled() {
  const commands: { context: ToolContext; done: ReturnType<typeof deferred<ToolResult>> }[] = [];
  const execute = vi.fn(async (_call: ToolCall, ctx: ToolContext) => {
    const done = deferred<ToolResult>();
    commands.push({ context: ctx, done });
    ctx.onCommandStarted?.();
    const abort = () => done.reject(new Error("cancelled"));
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) abort();
    try { return await done.promise; }
    finally { ctx.signal.removeEventListener("abort", abort); }
  });
  return { commands, base: fake(execute), execute };
}
const registries: LocalToolRegistry[] = [];
function wrap(base: LocalToolRegistry, secrets?: readonly string[]) {
  const tools = withCommandTasks(base, secrets ? { redactValues: secrets } : {});
  registries.push(tools);
  return tools;
}
afterEach(async () => {
  await Promise.all(registries.splice(0).map((tools) => tools.dispose()));
});
const start = (tools: LocalToolRegistry, ctx: ToolContext) => tools.execute(call("run_command", { argv: ["example"], background: true }), ctx);
const manage = (tools: LocalToolRegistry, ctx: ToolContext, args: unknown) => tools.execute(call("command_task", args), ctx);

describe("command task wrapper", () => {
  it("adds only one control tool and leaves base definitions untouched", () => {
    const base = fake(async () => result({}));
    const tools = wrap(base);
    expect(tools.definitions.map((item) => item.function.name)).toEqual(["run_command", "command_task"]);
    for (const definition of tools.definitions) toolDefinitionSchema.parse(definition);
    expect(tools.definitions[0]?.function.parameters.properties).toHaveProperty("background", { type: "boolean", default: false });
    expect(base.definitions[0]?.function.parameters.properties).not.toHaveProperty("background");
    expect(() => withCommandTasks({ ...base, definitions: [] })).toThrow("run_command");
    expect(() => withCommandTasks(tools)).toThrow("Duplicate");
  });

  it("passes foreground and unrelated calls/context/results through without changes", async () => {
    const expected = result({ stdout: "exact" });
    const execute = vi.fn(async () => expected);
    const tools = wrap(fake(execute));
    const ctx = context();
    for (const name of ["run_command", "read_file"]) {
      const command = call(name, { argv: ["a"] });
      expect(await tools.execute(command, ctx)).toBe(expected);
      expect(execute).toHaveBeenLastCalledWith(command, ctx);
    }
    expect(await tools.execute(call("run_command", { argv: ["a"], background: false }), ctx)).toBe(expected);
    expect(execute.mock.calls.at(-1)).toEqual([call("run_command", { argv: ["a"] }), ctx]);
  });

  it("keeps approval pending until process start, preserving approval and context", async () => {
    const approval = deferred<boolean>();
    const completion = deferred<ToolResult>();
    const events: string[] = [];
    const ctx = context({ approve: async () => approval.promise, onCommandStarted: () => events.push("started") });
    const execute = vi.fn(async (command: ToolCall, inner: ToolContext) => {
      expect(command.function.arguments).not.toContain("background");
      expect(inner.approve).toBe(ctx.approve);
      expect(inner.onEvent).toBe(ctx.onEvent);
      expect(inner.permission).toBe(ctx.permission);
      expect(inner.sessionId).toBe(ctx.sessionId);
      expect(await inner.approve({} as never, inner.signal)).toBe(true);
      inner.onCommandStarted?.();
      return completion.promise;
    });
    const tools = wrap(fake(execute));
    let returned = false;
    const launched = start(tools, ctx).then((value) => { returned = true; return value; });
    await Promise.resolve();
    await Promise.resolve();
    expect(returned).toBe(false);
    approval.resolve(true);
    const launchedOutput = output(await launched);
    expect(launchedOutput.status).toBe("running");
    expect(launchedOutput.id).toBeTypeOf("string");
    expect(events).toEqual(["started"]);
    completion.resolve(result({ stdout: "done" }));
    expect(output(await manage(tools, ctx, { action: "wait", id: launchedOutput.id })).status).toBe("completed");
  });

  it.each(["refusal", "spawn failure", "invalid arguments"])("returns original pre-start %s without a task id", async (failure) => {
    const expected = result({ error: failure }, true);
    const tools = wrap(fake(async () => expected));
    const ctx = context();
    expect(await start(tools, ctx)).toBe(expected);
    expect(output(await manage(tools, ctx, { action: "list" }))).toEqual({ tasks: [], pending_ids: [] });
  });

  it("preserves pre-start rejection without fabricating a task", async () => {
    const failure = new Error("approval cancelled");
    const tools = wrap(fake(async () => { throw failure; }));
    const ctx = context();
    await expect(start(tools, ctx)).rejects.toBe(failure);
    expect(output(await manage(tools, ctx, { action: "list" })).tasks).toEqual([]);
  });

  it("withholds running chunks, redacts entire completed output before UTF-16 pagination", async () => {
    const { base, commands } = controlled();
    const forwarded = vi.fn();
    const tools = wrap(base, ["token-secret", "quoted\nsecret"]);
    const ctx = context({ onCommandOutput: forwarded });
    const { id } = output(await start(tools, ctx));
    commands[0]?.context.onCommandOutput?.("stdout", "token-");
    expect(output(await manage(tools, ctx, { action: "read", id }))).toEqual({ id, status: "running", output_available: false });
    commands[0]?.context.onCommandOutput?.("stdout", "secret");
    commands[0]?.context.onCommandOutput?.("stderr", "quoted\nsecret");
    expect(forwarded).not.toHaveBeenCalled();
    commands[0]?.done.resolve(result({ stdout: "😀token-secret", stderr: "quoted\nsecret" }));
    const completed = output(await manage(tools, ctx, { action: "wait", id }));
    expect(completed.status).toBe("completed");
    expect(completed.output).not.toContain("token-secret");
    expect(JSON.parse(completed.output)).toEqual({ stdout: "😀[REDACTED]", stderr: "[REDACTED]" });
    let text = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const page = output(await manage(tools, ctx, { action: "read", id, offset, limit: 3 }));
      expect(page.offset_units).toBe("utf16_code_units");
      expect(page.output.length).toBeLessThanOrEqual(3);
      text += page.output;
      offset = page.next_offset;
    }
    expect(text).toBe(completed.output);
    expect(output(await manage(tools, ctx, { action: "read", id, offset: 99999 })).output).toBe("");
  });

  it("does not retain raw chunks and preserves the base overflow withholding", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base, ["secret-tail"]);
    const ctx = context();
    const { id } = output(await start(tools, ctx));
    expect(commands[0]?.context.onCommandOutput).toBeUndefined();
    commands[0]?.done.resolve(result({ stdout: "[Output withheld after overflow]", truncated: true }, true));
    const complete = output(await manage(tools, ctx, { action: "wait", id }));
    expect(complete.output_truncated).toBe(true);
    expect(JSON.parse(complete.output).stdout).toBe("[Output withheld after overflow]");
    expect(complete.status).toBe("failed");
  });

  it("bounds completed result storage", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const { id } = output(await start(tools, ctx));
    commands[0]?.done.resolve(result({ stdout: "x".repeat(131072) }));
    const complete = output(await manage(tools, ctx, { action: "wait", id }));
    expect(complete.output_truncated).toBe(true);
    expect(complete.output).toBe("[Output withheld after overflow]");
  });

  it("isolates ownership by session and registry and denies readonly control without approvals", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base);
    const approve = vi.fn(async () => true);
    const ctx = context({ approve });
    const { id } = output(await start(tools, ctx));
    const other = context({ approve });
    const stranger = wrap(fake(async () => result({})));
    for (const action of ["read", "wait", "stop"]) {
      expect((await manage(tools, other, { action, id })).isError).toBe(true);
      expect((await manage(stranger, ctx, { action, id })).isError).toBe(true);
      expect((await manage(tools, { ...ctx, permission: "readonly" }, { action, id })).isError).toBe(true);
    }
    expect((await manage(tools, { ...ctx, permission: "readonly" }, { action: "list" })).isError).toBe(true);
    expect(output(await manage(tools, other, { action: "list" })).tasks).toEqual([]);
    expect(output(await manage(tools, ctx, { action: "list" })).pending_ids).toEqual([id]);
    expect(approve).not.toHaveBeenCalled();
    expect(commands[0]?.context.signal.aborted).toBe(false);
  });

  it.each([
    { action: "bad" }, { action: "read" }, { action: "read", id: "missing" },
    { action: "list", limit: 12001 }, { action: "list", offset: -1 },
    { action: "list", timeout_ms: 120001 }, { action: "list", timeout_ms: -1 },
    { action: "list", unexpected: true },
  ])("validates command_task args %j", async (args) => {
    const tools = wrap(fake(async () => result({})));
    expect((await manage(tools, context(), args)).isError).toBe(true);
  });

  it("rejects invalid background values without execution", async () => {
    const execute = vi.fn(async () => result({}));
    const tools = wrap(fake(execute));
    expect((await tools.execute(call("run_command", { background: "yes" }), context())).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("wait supports zero/positive timeout and cancellation without stopping or replaying", async () => {
    const { base, execute } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const { id } = output(await start(tools, ctx));
    for (const timeout_ms of [0, 1]) {
      const value = output(await manage(tools, ctx, { action: "wait", id, timeout_ms }));
      expect(value.status).toBe("running");
      expect(value.output_available).toBe(false);
    }
    const controller = new AbortController();
    const waiting = manage(tools, { ...ctx, signal: controller.signal }, { action: "wait", id });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    expect(output(await manage(tools, ctx, { action: "read", id })).status).toBe("running");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stop aborts and joins; parent abort also joins with cancelled rather than completed status", async () => {
    const { base, commands, execute } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const { id } = output(await start(tools, ctx));
    expect(output(await manage(tools, ctx, { action: "stop", id })).status).toBe("cancelled");
    expect(commands[0]?.context.signal.aborted).toBe(true);
    const controller = new AbortController();
    const parent = { ...ctx, signal: controller.signal };
    const second = output(await start(tools, parent));
    controller.abort();
    expect(output(await manage(tools, ctx, { action: "wait", id: second.id })).status).toBe("cancelled");
    expect(output(await manage(tools, ctx, { action: "list" })).pending_ids).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reports execution errors as failed, not successful completion", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const first = output(await start(tools, ctx));
    commands[0]?.done.resolve(result({ exit_code: 2 }, true));
    expect(output(await manage(tools, ctx, { action: "wait", id: first.id }))).toMatchObject({ status: "failed", result_is_error: true });
    const second = output(await start(tools, ctx));
    commands[1]?.done.reject(new Error("raw secret error"));
    const failed = output(await manage(tools, ctx, { action: "wait", id: second.id }));
    expect(failed.status).toBe("failed");
    expect(failed.output).not.toContain("raw secret");
  });

  it.each([
    { exit_code: 2 }, { timed_out: true }, { signal: "SIGKILL" },
    { exit_code: null }, { truncated: true }, { spawn_failed: true },
  ])("uses completion metadata to detect failure even when base isError is false: %j", async (metadata) => {
    const { base, commands } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const { id } = output(await start(tools, ctx));
    commands[0]?.done.resolve(result(metadata));
    const completed = await manage(tools, ctx, { action: "wait", id });
    expect(completed.isError).toBe(true);
    expect(output(completed)).toMatchObject({ id, status: "failed", result_is_error: true });
    // page.truncated means more pages; output_truncated is the command ceiling.
    if ("truncated" in metadata) expect(output(completed).output_truncated).toBe(true);
    expect(output(await manage(tools, ctx, { action: "list" })).tasks[0]).toMatchObject(metadata);
  });

  it("reserves capacity for approval-pending concurrent launches", async () => {
    const pending = deferred<ToolResult>();
    let count = 0;
    const tools = wrap(fake(async () => { count++; return pending.promise; }));
    const ctx = context();
    const starts = Array.from({ length: 4 }, () => start(tools, ctx));
    expect((await start(tools, ctx)).isError).toBe(true);
    expect(count).toBe(4);
    // Approval-pending capacity reservations must not disclose ids before spawn.
    expect(output(await manage(tools, ctx, { action: "list" })).pending_ids).toEqual([]);
    pending.resolve(result({ error: "denied" }, true));
    await Promise.all(starts);
  });

  it("enforces four active and 32 lifetime tasks even after completion", async () => {
    const { base, commands, execute } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const first = await Promise.all(Array.from({ length: 4 }, () => start(tools, ctx)));
    expect((await start(tools, ctx)).isError).toBe(true);
    for (const command of commands) command.done.resolve(result({}));
    for (const command of first) await manage(tools, ctx, { action: "wait", id: output(command).id });
    for (let index = 4; index < 32; index++) {
      const { id } = output(await start(tools, ctx));
      commands[index]?.done.resolve(result({}));
      await manage(tools, ctx, { action: "wait", id });
    }
    expect(output(await start(tools, ctx)).error).toContain("total limit");
    expect(execute).toHaveBeenCalledTimes(32);
  });

  it("dispose cancels/joins every command, is idempotent, and blocks future calls", async () => {
    const joined = deferred<ToolResult>();
    const base = fake(async (_call, ctx) => { ctx.onCommandStarted?.(); return joined.promise; });
    const tools = wrap(base);
    await start(tools, context());
    let settled = false;
    const disposal = tools.dispose().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    joined.resolve(result({}));
    await disposal;
    await tools.dispose();
    expect(base.dispose).toHaveBeenCalledTimes(1);
    expect((await start(tools, context())).isError).toBe(true);
  });

  it("settles pending tasks once with safe metadata and no stdout/body", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const { id } = output(await start(tools, ctx));
    let returned = false;
    const settled = tools.settleBackground?.(ctx.sessionId, ctx.signal).then((value) => { returned = true; return value; });
    await Promise.resolve();
    expect(returned).toBe(false);
    commands[0]?.done.resolve(result({ stdout: "never in summary", stderr: "also secret", exit_code: 0, signal: null, timed_out: false, truncated: false, spawn_failed: false }));
    const summary = await settled;
    expect(summary).toBeDefined();
    expect(output(summary!)).toEqual({ tasks: [{ id, status: "completed", exit_code: 0, signal: null, timed_out: false, truncated: false, spawn_failed: false }] });
    expect(summary?.isError).toBe(false);
    expect(summary?.content).not.toContain("secret");
    expect(await tools.settleBackground?.(ctx.sessionId, ctx.signal)).toBeUndefined();
    // Delivery of a summary does not remove completed output pagination.
    expect(output(await manage(tools, ctx, { action: "read", id })).output).toContain("never in summary");
  });

  it("terminal reads/waits/stops deliver once, while running read/wait and list do not", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const first = output(await start(tools, ctx));
    await manage(tools, ctx, { action: "read", id: first.id });
    await manage(tools, ctx, { action: "wait", id: first.id, timeout_ms: 0 });
    commands[0]?.done.resolve(result({ exit_code: 2 }, true));
    await commands[0]?.done.promise;
    await manage(tools, ctx, { action: "list" });
    const summary = await tools.settleBackground?.(ctx.sessionId, ctx.signal);
    expect(summary?.isError).toBe(true);
    expect(output(summary!).tasks).toEqual([{ id: first.id, status: "failed", exit_code: 2 }]);
    for (const action of ["read", "wait", "stop"]) {
      const next = output(await start(tools, ctx));
      if (action !== "stop") {
        commands.at(-1)?.done.resolve(result({ exit_code: 0 }));
        await vi.waitFor(async () => {
          const listed = output(await manage(tools, ctx, { action: "list" }));
          expect(listed.pending_ids).not.toContain(next.id);
        });
      }
      await manage(tools, ctx, { action, id: next.id });
      expect(await tools.settleBackground?.(ctx.sessionId, ctx.signal)).toBeUndefined();
    }
  });

  it("settle is session-scoped and parent cancellation aborts and joins rather than quiet completion", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const other = context();
    const first = output(await start(tools, ctx));
    const second = output(await start(tools, other));
    const controller = new AbortController();
    const settling = tools.settleBackground?.(ctx.sessionId, controller.signal);
    controller.abort();
    const summary = await settling;
    expect(summary?.isError).toBe(true);
    expect(output(summary!).tasks).toEqual([{ id: first.id, status: "cancelled" }]);
    expect(commands[0]?.context.signal.aborted).toBe(true);
    expect(commands[1]?.context.signal.aborted).toBe(false);
    commands[1]?.done.resolve(result({ exit_code: 0 }));
    expect(output((await tools.settleBackground?.(other.sessionId, other.signal))!).tasks).toEqual([{ id: second.id, status: "completed", exit_code: 0 }]);
  });

  it("settle cancellation waits for actual command join and concurrent settles do not redeliver", async () => {
    const joined = deferred<ToolResult>();
    let signal: AbortSignal | undefined;
    const tools = wrap(fake(async (_call, ctx) => { signal = ctx.signal; ctx.onCommandStarted?.(); return joined.promise; }));
    const ctx = context();
    const { id } = output(await start(tools, ctx));
    const controller = new AbortController();
    let returned = false;
    const first = tools.settleBackground?.(ctx.sessionId, controller.signal).then((value) => { returned = true; return value; });
    const second = tools.settleBackground?.(ctx.sessionId, ctx.signal);
    controller.abort();
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(signal?.aborted).toBe(true);
    joined.resolve(result({ exit_code: 0 }));
    const settled = await Promise.all([first, second]);
    expect(settled.filter(Boolean)).toHaveLength(1);
    expect(output(settled.find(Boolean)!).tasks).toEqual([{ id, status: "cancelled", exit_code: 0 }]);
  });

  it("does not swallow base dispose errors while still joining tasks", async () => {
    const { base, commands } = controlled();
    const failure = new Error("dispose failed");
    const tools = withCommandTasks({ ...base, dispose: async () => { throw failure; } });
    await start(tools, context());
    await expect(tools.dispose()).rejects.toMatchObject({ errors: [failure] });
    expect(commands[0]?.context.signal.aborted).toBe(true);
    await expect(tools.dispose()).rejects.toMatchObject({ errors: [failure] });
  });
});

describe("command tasks with the real local registry", () => {
  it("starts only after approval/spawn; preserves timeout, failure, and overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-command-tasks-"));
    const tools = withCommandTasks(await createLocalToolRegistry(root));
    const approve = vi.fn(async () => true);
    const ctx = context({ workspace: root, approve });
    const launch = (argv: string[], timeout_ms = 2000) => tools.execute(call("run_command", { argv, timeout_ms, background: true }), ctx);
    try {
      const missing = await launch([join(root, "missing")]);
      expect(missing.isError).toBe(true);
      expect(output(missing).spawn_failed).toBe(true);
      expect(output(missing).id).toBeUndefined();
      const timed = output(await launch([process.execPath, "-e", "setTimeout(()=>{}, 10000)"], 30));
      const timeoutResult = output(await manage(tools, ctx, { action: "wait", id: timed.id }));
      expect(timeoutResult.status).toBe("failed");
      expect(JSON.parse(timeoutResult.output).timed_out).toBe(true);
      const overflow = output(await launch([process.execPath, "-e", "process.stdout.write('x'.repeat(70000))"]));
      const overflowResult = output(await manage(tools, ctx, { action: "wait", id: overflow.id }));
      expect(overflowResult.status).toBe("failed");
      expect(overflowResult.output).not.toContain("x".repeat(100));
      expect(approve).toHaveBeenCalledTimes(3);
      expect(output(await manage(tools, ctx, { action: "list" })).pending_ids).toEqual([]);
    } finally {
      await tools.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns exact denial and readonly failure without publishing tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-command-tasks-"));
    const tools = withCommandTasks(await createLocalToolRegistry(root));
    const approve = vi.fn(async () => false);
    const ctx = context({ workspace: root, approve });
    try {
      const command = call("run_command", { argv: [process.execPath, "--version"], background: true });
      const denied = await tools.execute(command, ctx);
      expect(output(denied)).toEqual({ error: "Command approval denied." });
      expect(denied.isError).toBe(true);
      expect((await tools.execute(command, { ...ctx, permission: "readonly" })).isError).toBe(true);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(output(await manage(tools, ctx, { action: "list" })).tasks).toEqual([]);
    } finally {
      await tools.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
