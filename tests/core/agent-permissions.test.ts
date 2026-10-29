import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import { agentProfileSchema, agentProfileTemplates, type AgentProfile } from "../../src/shared/agent-profiles";
import type { ModelProvider } from "../../src/shared/contracts";
import { defaultPublicSettings, type Permission, type ToolCall, type ToolResult } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { createLocalToolRegistry } from "../../src/tools/local";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const call = (id: string, name: string, args: unknown): ToolCall => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const calls = (...tools: ToolCall[]) => ({ message: { role: "assistant" as const, content: null, tool_calls: tools } });
const done = () => ({ message: { role: "assistant" as const, content: "done" } });
const template = (id: string, patch: Partial<AgentProfile> = {}) => agentProfileSchema.parse({
  ...agentProfileTemplates.find(item => item.id === id), revision: 1, ...patch,
});

async function fixture(options: {
  profile?: AgentProfile;
  permission?: Permission;
  mode?: "plan" | "build";
  downgradeAfterFirstCommand?: boolean;
} = {}) {
  const base = fileURLToPath(new URL("../../../../.forge/tmp/agent-permissions/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = await openSessionStore(join(directory, "state"));
  const root = await store.create({ workspace, title: "permission fixture", model: "fixture" });
  const tools = await createLocalToolRegistry(workspace);
  cleanups.push(() => tools.dispose());
  let permission: Permission = options.permission ?? "unrestricted";
  let parentTurns = 0;
  let childTurns = 0;
  const attempts: { name: string; permission: Permission; result: ToolResult }[] = [];
  const approve = vi.fn(async () => true);
  const provider: ModelProvider = { listModels: async () => [], complete: async (_messages, _tools, input) => {
    if (input.sessionId !== root.id) {
      if (++childTurns !== 1) return done();
      return calls(
        call("command-1", "run_command", { argv: [process.execPath, "-e", "process.stdout.write('first')"], timeout_ms: 5000 }),
        call("command-2", "run_command", { argv: [process.execPath, "-e", "process.stdout.write('second')"], timeout_ms: 5000 }),
        call("write", "write_file", { path: "result.txt", content: "child completed" }),
      );
    }
    if (++parentTurns === 1) return calls(call("spawn", "spawn_agent", {
      task: "Run two fixture commands and write a result", ...(options.profile ? { profileId: options.profile.id } : {}),
    }));
    if (parentTurns === 2) return calls(call("wait", "wait_agents", {}));
    return done();
  } };
  const runtime = createAgentRuntime({
    store, provider, tools, settings: { ...defaultPublicSettings, agentProfiles: options.profile ? [options.profile] : [] },
    childToolFactory: async () => {
      const childTools = await createLocalToolRegistry(workspace);
      return { ...childTools, execute: async (tool, context) => {
        const currentPermission = context.permission;
        const result = await childTools.execute(tool, context);
        attempts.push({ name: tool.function.name, permission: currentPermission, result });
        if (tool.id === "command-1" && options.downgradeAfterFirstCommand) permission = "readonly";
        return result;
      } };
    },
  });
  const parent = await runtime.run({ sessionId: root.id, prompt: "delegate", permission,
    ...(options.mode ? { mode: options.mode } : {}) }, () => {}, approve, AbortSignal.timeout(10000), {
    getPermission: () => permission, drainSteering: () => [],
  });
  const summary = (await store.list()).find(item => item.parentSessionId === root.id)!;
  const child = await store.get(summary.id);
  const results = child.events.flatMap(event => event.type === "tool_finished" ? [event.result] : []);
  return { parent, child, results, approve, attempts, workspace };
}

it.each(["frontend", "backend", "unprofiled"])("%s inherits unrestricted without a user approval for every command", async id => {
  const f = await fixture(id === "unprofiled" ? {} : { profile: template(id) });
  expect(f.parent.status).toBe("completed");
  expect(f.child.status).toBe("completed");
  expect(f.child.permissionCeiling).toBe("unrestricted");
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.parent.events.some(event => event.type === "approval_requested")).toBe(false);
  expect(f.child.events.some(event => event.type === "approval_requested")).toBe(false);
  expect(f.attempts.map(item => item.permission)).toEqual(["unrestricted", "unrestricted", "unrestricted"]);
  expect(f.results.every(result => !result.isError)).toBe(true);
  expect(f.results.slice(0, 2).map(result => JSON.parse(result.content).stdout)).toEqual(["first", "second"]);
  expect(await readFile(join(f.workspace, "result.txt"), "utf8")).toBe("child completed");
});

it("does not bypass a workspace parent; required approvals retain parent/child attribution", async () => {
  const f = await fixture({ profile: template("backend"), permission: "workspace" });
  expect(f.child.permissionCeiling).toBe("workspace");
  expect(f.approve).toHaveBeenCalledTimes(2);
  const requests = f.parent.events.flatMap(event => event.type === "approval_requested" ? [event.request] : []);
  expect(requests).toHaveLength(2);
  expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({
    sessionId: f.parent.id, childSessionId: f.child.id, toolName: "run_command",
  })]));
  expect(f.results.every(result => !result.isError)).toBe(true);
});

it.each(["readonly", "plan"] as const)("never elevates a %s parent through an inherited role", async mode => {
  const f = await fixture({ profile: template("backend"),
    ...(mode === "plan" ? { permission: "unrestricted", mode } as const : { permission: mode }),
  });
  expect(f.child.permissionCeiling).toBe("readonly");
  expect(f.attempts).toEqual([]);
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.results).toHaveLength(3);
  expect(f.results.every(result => result.isError)).toBe(true);
  await expect(readFile(join(f.workspace, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves an explicitly saved workspace cap even with an unrestricted parent", async () => {
  const f = await fixture({ profile: template("backend", { permission: "workspace" }) });
  expect(f.child.permissionCeiling).toBe("workspace");
  expect(f.approve).toHaveBeenCalledTimes(2);
  expect(f.attempts.map(item => item.permission)).toEqual(["workspace", "workspace", "workspace"]);
});

it.each(["explorer", "reviewer"])("keeps the %s role readonly and denies forged mutations without approval", async id => {
  const f = await fixture({ profile: template(id) });
  expect(f.child.permissionCeiling).toBe("readonly");
  expect(f.attempts).toEqual([]);
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.results).toHaveLength(3);
  expect(f.results.every(result => result.isError)).toBe(true);
});

it("immediately tightens subsequent child tools when the active parent revokes permission", async () => {
  const f = await fixture({ profile: template("backend"), downgradeAfterFirstCommand: true });
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.attempts).toHaveLength(1);
  expect(f.attempts[0]).toMatchObject({ permission: "unrestricted", result: { isError: false } });
  expect(f.results.map(result => result.isError)).toEqual([false, true, true]);
  await expect(readFile(join(f.workspace, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});
