import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import { openSessionStore } from "../../src/store/sessions";
import { openToolHooksStore } from "../../src/store/tool-hooks";
import { defaultPublicSettings, type Permission } from "../../src/shared/schemas";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(mode: "allow" | "deny" | "observer-failure", permission: Permission = "workspace") {
  const root = await mkdtemp("/tmp/forge-hook-runtime-"); roots.push(root);
  const log = join(root, "hooks.log");
  const script = join(root, "hook.cjs");
  await writeFile(script, `const fs=require('node:fs');const e=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({hook:e.hook,cwd:process.cwd()})+'\\n');if(e.hook==='beforeTool')console.log(JSON.stringify({decision:${JSON.stringify(mode === "deny" ? "deny" : "allow")}}));if(e.hook==='afterTool'&&${JSON.stringify(mode)}==='observer-failure')process.exitCode=1;`);
  const hooksStore = await openToolHooksStore(join(root, "home"));
  await hooksStore.set(Object.fromEntries(["beforeTool", "afterTool", "toolError", "runEnd"].map((hook, i) => [hook, [{ id: `hook-${i}`, command: process.execPath, args: [script] }]])));
  const store = await openSessionStore(join(root, "home"));
  const session = await store.create({ workspace: root, title: "test", model: "fixture" });
  let toolCalls = 0; let requested = false;
  const result = await createAgentRuntime({ store, settings: defaultPublicSettings, toolHooks: await hooksStore.get(),
    tools: { definitions: [], dispose: async () => {}, execute: async () => { toolCalls += 1; return { content: "tool result", isError: false }; } },
    provider: { listModels: async () => [], complete: async () => {
      if (requested) return { message: { role: "assistant", content: "done" } };
      requested = true;
      return { message: { role: "assistant", content: "", tool_calls: [{ id: "read", type: "function", function: { name: "read_file", arguments: "{}" } }] } };
    } },
  }).run({ sessionId: session.id, prompt: "work", permission }, () => {}, async () => { throw new Error("No extra approval expected"); }, new AbortController().signal);
  return { root, log, result, toolCalls };
}

describe("configured hook lifecycle in a real run", () => {
  it("runs before, after and runEnd once in the session workspace", async () => {
    const f = await fixture("allow");
    const lines = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toEqual(["beforeTool", "afterTool", "runEnd"].map(hook => ({ hook, cwd: f.root })));
    expect(f.toolCalls).toBe(1);
    expect(f.result.status).toBe("completed");
  });
  it("denies before execution and invokes toolError instead of after", async () => {
    const f = await fixture("deny");
    expect(f.toolCalls).toBe(0);
    expect((await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line).hook)).toEqual(["beforeTool", "toolError", "runEnd"]);
    expect(f.result.messages.find(message => message.role === "tool")?.content).toContain('"isError":true');
  });
  it("retains a successful tool result while reporting observer failure", async () => {
    const f = await fixture("observer-failure");
    expect(f.toolCalls).toBe(1);
    expect(f.result.status).toBe("failed");
    expect(f.result.messages.find(message => message.role === "tool")?.content).toContain('"isError":false');
    expect(f.result.events.some(event => event.type === "tool_hook" && event.diagnostic.hook === "afterTool" && event.diagnostic.status === "failed")).toBe(true);
  });
  it("skips configured subprocesses in readonly mode without denying the read", async () => {
    const f = await fixture("allow", "readonly");
    expect(f.result.status).toBe("completed");
    expect(f.toolCalls).toBe(1);
    await expect(readFile(f.log)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.result.events.filter(event => event.type === "tool_hook").map(event => event.diagnostic.status)).toEqual(["skipped", "skipped", "skipped"]);
  });
});
