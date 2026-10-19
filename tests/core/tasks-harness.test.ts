import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
const barrier = () => { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; };
it("shows and stops an owned child but external hosts only observe, without extra model calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-tasks-host-"));
  const workspace = join(dir, "workspace"); await mkdir(workspace);
  const started = barrier(); let turns = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (_m, _t, options) => {
    if (options.model === "child") { started.release(); return new Promise(() => {}); }
    if (++turns === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "spawn", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ task: "inspect", model: "child" }) } }] } };
    return { message: { role: "assistant", content: "result" } };
  } };
  const h = await createHarness({ stateDir: join(dir, "state"), providerFactory: () => provider });
  const external = await createHarness({ stateDir: join(dir, "state"), providerFactory: () => provider });
  try {
    await h.updateSettings({ settings: { baseUrl: "http://127.0.0.1:1/v1", model: "root" } });
    const root = await h.createSession({ workspace, title: "explicit" });
    const work = h.run({ sessionId: root.id, prompt: "delegate" }, () => {}, async () => false, new AbortController().signal);
    await started.promise;
    const before = turns;
    const page = await h.tasks!.listTasks(root.id);
    const child = page.tasks.find(task => task.kind === "agent")!;
    expect(child).toMatchObject({ active: true, controllable: true, historical: false });
    expect((await external.tasks!.getTask(root.id, "agent", child.id)).task).toMatchObject({ active: false, controllable: false, historical: true });
    expect(await external.tasks!.stopTask(root.id, "agent", child.id)).toBe(false);
    expect(turns).toBe(before);
    expect(await h.tasks!.stopTask(root.id, "agent", child.id)).toBe(true);
    expect((await work).status).toBe("failed"); // user stop is not failure erasure
  } finally { await h.dispose(); await external.dispose(); await rm(dir, { recursive: true, force: true }); }
});
it("retains bounded completed command inspection after the run without consuming settlement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-task-command-host-"));
  const workspace = join(dir, "workspace"); await mkdir(workspace);
  const launched = barrier(); const inspected = barrier(); let turns = 0;
  const h = await createHarness({ stateDir: join(dir, "state"), providerFactory: () => ({ listModels: async () => [], complete: async () => {
    if (++turns === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "bg", type: "function", function: { name: "run_command", arguments: JSON.stringify({ argv: [process.execPath, "--version"], timeout_ms: 2000, background: true }) } }] } };
    if (turns === 2) { launched.release(); await inspected.promise; }
    return { message: { role: "assistant", content: "checked" } };
  } }) });
  try {
    await h.updateSettings({ settings: { baseUrl: "http://127.0.0.1:1/v1", model: "root" } });
    const root = await h.createSession({ workspace, title: "explicit" });
    const work = h.run({ sessionId: root.id, prompt: "run", permission: "unrestricted" }, () => {}, async () => false, new AbortController().signal);
    await launched.promise;
    const command = (await h.tasks!.listTasks(root.id)).tasks.find(task => task.kind === "command")!;
    expect(command).toBeDefined();
    await h.tasks!.getTask(root.id, "command", command.id);
    inspected.release();
    expect((await work).status).toBe("completed"); expect(turns).toBe(3);
    const detail = await h.tasks!.getTask(root.id, "command", command.id);
    expect(detail.task).toMatchObject({ historical: true, active: false, controllable: false, exitCode: 0 });
    expect(detail.content).toContain("stdout");
    expect(await h.tasks!.stopTask(root.id, "command", command.id)).toBe(false);
  } finally { inspected.release(); await h.dispose(); await rm(dir, { recursive: true, force: true }); }
});
