import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createProjectContext } from "../../src/context/project-context";
import { createMcpService } from "../../src/mcp/registry";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { openPublishedFileStore } from "../../src/store/published-files";
import { createBrowserToolRegistry } from "../../src/tools/browser";
import { withCommandTasks } from "../../src/tools/command-tasks";
import { createLocalToolRegistry } from "../../src/tools/local";
import { createLspToolRegistry } from "../../src/tools/lsp";
import { createMcpToolRegistry } from "../../src/tools/mcp";
import { createPublishedFileTool } from "../../src/tools/published-files";
import { createSkillTool } from "../../src/tools/skills";
import { createWebToolRegistry } from "../../src/tools/web";

let root: string;
let context: ToolContext;
let project: Awaited<ReturnType<typeof createProjectContext>>;
let registries: LocalToolRegistry[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-input-errors-"));
  context = { sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"), toolCallId: "input", workspace: root,
    permission: "unrestricted", signal: new AbortController().signal, approve: async () => false, onEvent() {} };
  project = await createProjectContext(root);
  registries = [
    withCommandTasks(await createLocalToolRegistry(root)),
    await createLspToolRegistry(root, [{ id: "fixture", command: process.execPath, args: [resolve("tests/tools/fixtures/lsp-server.mjs")], extensions: [".ts"] }]),
    await createBrowserToolRegistry({ allowedOrigins: ["https://example.invalid"] }),
    await createMcpToolRegistry(await createMcpService({ home: root })),
    createSkillTool(project),
    await createPublishedFileTool(root, await openPublishedFileStore(root)),
    createWebToolRegistry(),
  ];
});
afterAll(async () => {
  await Promise.all(registries.map(registry => registry.dispose()));
  await project.dispose();
  await rm(root, { recursive: true, force: true });
});
const execute = (name: string, args: object) => {
  const registry = registries.find(item => item.definitions.some(definition => definition.function.name === name));
  if (!registry) throw new Error(`Missing registry: ${name}`);
  return registry.execute({ id: "input", type: "function", function: { name, arguments: JSON.stringify(args) } }, context);
};

it.each(["command_task", "lsp", "browser_navigate", "browser_read", "browser_click", "browser_fill", "browser_screenshot", "browser_close",
  "mcp_list_tools", "mcp_call_tool", "project_context", "load_skill", "publish_file", "web_fetch"])("returns a classified input error from %s", async name => {
  const result = await execute(name, { __unexpected: "private-input-marker" });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content)).toMatchObject({ code: "invalid_input", error: expect.any(String) });
  expect(result.content).not.toContain("private-input-marker");
});

it.each(["definition", "references", "hover"])("identifies the missing LSP positions for %s", async operation => {
  const result = await execute("lsp", { operation, path: "sample.ts" });
  expect(JSON.parse(result.content)).toMatchObject({ code: "invalid_input" });
  expect(result.content).toContain("line");
  expect(result.content).toContain("character");
});

it.each(["read", "wait", "stop"])("identifies the missing command task id for %s", async action => {
  const result = await execute("command_task", { action });
  expect(JSON.parse(result.content)).toMatchObject({ code: "invalid_input", error: expect.stringContaining("id") });
});

it("classifies a malformed background flag before starting a command", async () => {
  const result = await execute("run_command", { argv: ["unused"], timeout_ms: 1, background: "true" });
  expect(JSON.parse(result.content)).toMatchObject({ code: "invalid_input", error: expect.stringContaining("background") });
  expect(JSON.parse((await execute("command_task", { action: "list" })).content).tasks).toEqual([]);
});

it.each([{}, { reason: "Close the audit browser" }])("accepts a no-argument browser call with optional context %j", async args => {
  const browser = await createBrowserToolRegistry({ allowedOrigins: [] });
  try {
    expect((await browser.execute({ id: "close", type: "function", function: { name: "browser_close", arguments: JSON.stringify(args) } }, context)).isError).toBe(false);
  } finally { await browser.dispose(); }
});

it.each(["git_status", "git_diff", "git_log", "browser_read", "browser_close"])("declares optional context without an empty object schema for %s", name => {
  const definition = registries.flatMap(item => item.definitions).find(item => item.function.name === name);
  expect(definition?.function.parameters).toMatchObject({ properties: { reason: { type: "string" } }, required: [] });
});
