import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import type { ToolCall, ToolResult } from "../../src/shared/schemas";
import { withCommandTasks } from "../../src/tools/command-tasks";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value), isError };
}
function call(name: string, args: unknown): ToolCall {
  return { id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function context(): ToolContext {
  return {
    sessionId: parseSessionId(randomUUID()), toolCallId: "call", workspace: ".",
    permission: "workspace", signal: new AbortController().signal,
    approve: async () => true, onEvent: () => {},
  };
}
function fake(execute: LocalToolRegistry["execute"]): LocalToolRegistry {
  return {
    definitions: [{ type: "function", function: {
      name: "run_command", description: "Base command limits.",
      parameters: { type: "object", properties: { argv: { type: "array" } } },
    } }], execute, dispose: vi.fn(async () => {}),
  };
}
function controlled() {
  const commands: { context: ToolContext; done: ReturnType<typeof deferred<ToolResult>> }[] = [];
  const execute = vi.fn(async (_call: ToolCall, ctx: ToolContext) => {
    const done = deferred<ToolResult>();
    commands.push({ context: ctx, done });
    ctx.onCommandStarted?.();
    const abort = () => done.resolve(result({ error: "cancelled" }, true));
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) abort();
    try { return await done.promise; }
    finally { ctx.signal.removeEventListener("abort", abort); }
  });
  return { commands, base: fake(execute), execute };
}
const registries: LocalToolRegistry[] = [];
function wrap(base: LocalToolRegistry, secrets: readonly string[] = []) {
  const tools = withCommandTasks(base, { redactValues: secrets });
  registries.push(tools);
  return tools;
}
afterEach(async () => {
  await Promise.all(registries.splice(0).map((tools) => tools.dispose()));
});
async function start(tools: LocalToolRegistry, ctx: ToolContext, argv = ["example"]) {
  const value = await tools.execute(call("run_command", { argv, background: true }), ctx);
  return JSON.parse(value.content) as { id: string };
}

// Host observation is separate from command_task tool delivery and authorization.
describe("command task host access", () => {
  it("lists only successfully spawned tasks and isolates sessions and registries", async () => {
    const gate = deferred<ToolResult>();
    const ctx = context();
    const tools = wrap(fake(async () => gate.promise));
    const starting = start(tools, ctx);
    await Promise.resolve();
    expect(tools.commandTasks?.list(ctx.sessionId)).toEqual([]);
    gate.resolve(result({ spawn_failed: true }, true));
    await starting;
    expect(tools.commandTasks?.list(ctx.sessionId)).toEqual([]);

    const { base } = controlled();
    const active = wrap(base);
    const { id } = await start(active, ctx);
    const access = active.commandTasks!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(access.list(ctx.sessionId)).toEqual([expect.objectContaining({
      id, kind: "command", sessionId: ctx.sessionId, title: "example", status: "running",
      active: true, controllable: true, historical: false,
    })]);
    expect(new Date(access.list(ctx.sessionId)[0]!.startedAt!).toISOString()).toBe(access.list(ctx.sessionId)[0]!.startedAt);
    const other = context();
    expect(access.list(other.sessionId)).toEqual([]);
    expect(access.read(other.sessionId, id, 0, 10)).toBeUndefined();
    expect(await access.stop(other.sessionId, id)).toBe(false);
    const separate = wrap(controlled().base).commandTasks!;
    expect(separate.read(ctx.sessionId, id, 0, 10)).toBeUndefined();
    expect(await separate.stop(ctx.sessionId, id)).toBe(false);
    expect(access.list(ctx.sessionId)[0]?.status).toBe("running");
  });

  it("reads only complete redacted output and does not consume model finalization", async () => {
    const { base, commands } = controlled();
    const tools = wrap(base, ["private-secret", "quoted\nsecret"]);
    const ctx = context();
    const { id } = await start(tools, ctx);
    const access = tools.commandTasks!;
    expect(access.read(ctx.sessionId, id, 0, 10)).toMatchObject({ content: "", nextOffset: null, task: { active: true } });
    expect(commands[0]?.context.onCommandOutput).toBeUndefined();
    commands[0]!.done.resolve(result({ stdout: "😀private-secret", stderr: "quoted\nsecret", exit_code: 0 }));
    await vi.waitFor(() => expect(access.list(ctx.sessionId)[0]?.status).toBe("completed"));
    let content = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const page: import("../../src/shared/task-view").TaskDetail = access.read(ctx.sessionId, id, offset, 3)!;
      expect(page.content.length).toBeLessThanOrEqual(3);
      content += page.content;
      offset = page.nextOffset;
    }
    expect(JSON.parse(content)).toEqual({ stdout: "😀[REDACTED]", stderr: "[REDACTED]", exit_code: 0 });
    expect(access.list(ctx.sessionId)[0]).toMatchObject({ exitCode: 0, active: false, controllable: false });
    expect(access.read(ctx.sessionId, id, 999999, 10)?.content).toBe("");
    const finalized = await tools.settleBackground!(ctx.sessionId, ctx.signal);
    expect(JSON.parse(finalized!.content).tasks).toEqual([{ id, status: "completed", exit_code: 0 }]);
    expect(await tools.settleBackground!(ctx.sessionId, ctx.signal)).toBeUndefined();
    expect(access.read(ctx.sessionId, id, 0, 12000)?.content).toBe(content);
  });

  it("joins a host stop without consuming the cancelled model result", async () => {
    const { base, commands, execute } = controlled();
    const tools = wrap(base);
    const ctx = context();
    const { id } = await start(tools, ctx);
    expect(await tools.commandTasks!.stop(ctx.sessionId, id)).toBe(true);
    expect(commands[0]!.context.signal.aborted).toBe(true);
    expect(tools.commandTasks!.list(ctx.sessionId)[0]).toMatchObject({ status: "cancelled", active: false, controllable: false });
    expect(await tools.commandTasks!.stop(ctx.sessionId, id)).toBe(false);
    const finalized = await tools.settleBackground!(ctx.sessionId, ctx.signal);
    expect(finalized?.isError).toBe(true);
    expect(JSON.parse(finalized!.content).tasks).toEqual([{ id, status: "cancelled" }]);
    const observed = await tools.execute(call("command_task", { action: "read", id }), ctx);
    expect(JSON.parse(observed.content).status).toBe("cancelled");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("awaits close on stop and permits only read-only access after disposal begins", async () => {
    const close = deferred<ToolResult>();
    let signal: AbortSignal | undefined;
    const tools = wrap(fake(async (_call, ctx) => {
      signal = ctx.signal;
      ctx.onCommandStarted?.();
      return close.promise;
    }));
    const ctx = context();
    const { id } = await start(tools, ctx);
    let stopped = false;
    const stopping = tools.commandTasks!.stop(ctx.sessionId, id).then((value) => { stopped = true; return value; });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    const disposing = tools.dispose();
    expect(tools.commandTasks!.list(ctx.sessionId)[0]).toMatchObject({ historical: true, controllable: false });
    expect(await tools.commandTasks!.stop(ctx.sessionId, id)).toBe(false);
    expect((await tools.execute(call("run_command", { argv: ["example"], background: true }), ctx)).isError).toBe(true);
    close.resolve(result({ stdout: "closed", exit_code: null }));
    expect(await stopping).toBe(true);
    await disposing;
    expect(tools.commandTasks!.read(ctx.sessionId, id, 0, 12000)).toMatchObject({
      task: { historical: true, active: false, controllable: false, status: "cancelled", exitCode: null },
      content: JSON.stringify({ stdout: "closed", exit_code: null }),
    });
  });

  it.each([
    ["/usr/bin/example", "configured-value", "--password", "pass-value"],
    ["example", "--token=flag-value", "sk-abcdefghijk", "ghp_abcdefghijklmnopqrstuvwx"],
    ["example", "https://user:pass@example.test", "Bearer bearer-value", "ignored"],
    ["sh", "-c", "echo unsafe-script", "ignored"],
    ["node", "--eval", "unsafe-script", "ignored"],
    ["sh", "-lc", "unsafe-script", "ignored"],
    ["node", "--eval=unsafe-script", "ignored", "ignored"],
    ["python", "-cunsafe-script", "ignored", "ignored"],
    ["example", "x".repeat(10000), "ignored", "ignored"],
  ])("stores only a bounded masked command title for %j", async (...argv) => {
    const { base } = controlled();
    const tools = wrap(base, ["configured-value"]);
    const ctx = context();
    await start(tools, ctx, [...argv, "never-in-title"]);
    const title = tools.commandTasks!.list(ctx.sessionId)[0]!.title;
    expect(title.length).toBeLessThanOrEqual(160);
    expect(title).not.toMatch(/configured-value|pass-value|flag-value|sk-abcdefghijk|ghp_abcdefghijklmnopqrstuvwx|user:pass|bearer-value|unsafe-script|never-in-title|x{41}/);
    expect(title).not.toContain("/usr/bin");
  });
});
