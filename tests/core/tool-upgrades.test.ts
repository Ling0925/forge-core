import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createLocalToolRegistry } from "../../src/tools/local";
import { withCommandTasks } from "../../src/tools/command-tasks";
import { createLspToolRegistry } from "../../src/tools/lsp";
import { createCombinedToolRegistry } from "../../src/tools/combined";
import type { ModelProvider } from "../../src/shared/contracts";

it("publishes no redundant aliases, with one background control and a conditional LSP tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-tool-surface-"));
  const local = await createLocalToolRegistry(dir);
  const tasks = withCommandTasks(local);
  const lsp = await createLspToolRegistry(dir, []);
  const combined = createCombinedToolRegistry(tasks, lsp);
  try {
    const names = combined.definitions.map(d => d.function.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter(n => n === "run_command")).toHaveLength(1);
    expect(names.filter(n => n === "command_task")).toHaveLength(1);
    for (const alias of ["grep", "glob", "read", "background_command", "task_output", "task_stop", "lsp"]) expect(names).not.toContain(alias);
    expect(names).toHaveLength(11);
    const configured = await createLspToolRegistry(dir, [{ id: "ts", command: "not-started", args: [], extensions: [".ts"] }]);
    expect(configured.definitions.map(d => d.function.name)).toEqual(["lsp"]);
    await configured.dispose();
    // Bound description growth separately from schemas: no full duplicate tool catalogs.
    const descriptions = combined.definitions.map(d => d.function.description ?? "").join("");
    expect(descriptions.length).toBeLessThan(6500);
  } finally { await combined.dispose(); await rm(dir, { recursive: true, force: true }); }
});

it("persists LSP configuration and routes an approved semantic query through the harness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-lsp-harness-"));
  const workspace = join(dir, "workspace"); await mkdir(workspace);
  await writeFile(join(workspace, "sample.ts"), "const café = 1;\n");
  let turn = 0; let approvals = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, definitions) => {
    expect(definitions.filter(d => d.function.name === "lsp")).toHaveLength(1);
    if (++turn === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "lsp-query", type: "function", function: {
      name: "lsp", arguments: JSON.stringify({ operation: "symbols", path: "sample.ts" }),
    } }] } };
    expect(messages.at(-1)?.content).toContain("café");
    return { message: { role: "assistant", content: "symbols inspected" } };
  } };
  const service = await createHarness({ stateDir: join(dir, "state"), providerFactory: () => provider });
  try {
    await service.updateSettings({ settings: { baseUrl: "http://127.0.0.1:1/v1", model: "test", lspServers: [{ id: "ts", command: process.execPath,
      args: [resolve("tests/tools/fixtures/lsp-server.mjs")], extensions: [".ts"] }] } });
    expect((await service.getSettings()).lspServers?.[0]?.id).toBe("ts");
    const session = await service.createSession({ workspace, title: "explicit" });
    const result = await service.run({ sessionId: session.id, prompt: "symbols", permission: "workspace" }, () => {}, async request => {
      expect(request.toolName).toBe("lsp"); expect(request.command?.[0]).toBe(process.execPath); approvals++; return true;
    }, new AbortController().signal);
    expect(result.status).toBe("completed"); expect(approvals).toBe(1);
  } finally { await service.dispose(); await rm(dir, { recursive: true, force: true }); }
});

it("does not silently swallow child registry cleanup failures", async () => {
  let disposed = false;
  const good = { definitions: [], execute: async () => ({ content: "", isError: false }), dispose: async () => { disposed = true; } };
  const combined = createCombinedToolRegistry(good, { ...good, dispose: async () => { throw Error("private details"); } });
  await expect(combined.dispose()).rejects.toThrow("cleanup failed");
  expect(disposed).toBe(true);
});

it("wires background commands through the production harness and reconciles before completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-background-harness-"));
  const workspace = join(dir, "workspace"); await mkdir(workspace);
  let turns = 0;
  const provider: ModelProvider = { listModels: async () => [], complete: async (messages, tools) => {
    expect(tools.filter(t => t.function.name === "run_command")).toHaveLength(1);
    expect(tools.some(t => t.function.name === "command_task")).toBe(true);
    expect(tools.some(t => t.function.name === "lsp")).toBe(false);
    if (++turns === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "bg", type: "function", function: {
      name: "run_command", arguments: JSON.stringify({ argv: [process.execPath, "--version"], background: true }),
    } }] } };
    if (turns === 2) {
      const result = messages.findLast(m => m.role === "tool");
      expect(result?.content).toContain('background');
      return { message: { role: "assistant", content: "preliminary" } };
    }
    expect(messages.at(-1)?.content).toContain("Background commands settled");
    expect(messages.at(-1)?.content).toContain("exit_code");
    return { message: { role: "assistant", content: "verified" } };
  } };
  const service = await createHarness({ stateDir: join(dir, "state"), providerFactory: () => provider });
  try {
    await service.updateSettings({ settings: { baseUrl: "http://127.0.0.1:1/v1", model: "test" } });
    const session = await service.createSession({ workspace, title: "explicit" });
    const result = await service.run({ sessionId: session.id, prompt: "run", permission: "unrestricted" }, () => {}, async () => false, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(turns).toBe(3); expect(result.messages.at(-1)?.content).toBe("verified");
  } finally { await service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
