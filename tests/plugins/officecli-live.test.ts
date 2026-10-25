import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import { collectPublishedFiles } from "../../src/shared/published-files";
import type { ToolDefinition } from "../../src/shared/schemas";

// Opt-in: no automatic download/installation and no real model or credentials.
const executablePath = process.env.FORGE_OFFICECLI_EXECUTABLE;
it.skipIf(!executablePath)("creates, edits, validates and delivers real Word/Excel/PPT HTML through the harness", async () => {
  const temp = fileURLToPath(new URL("../../../../.forge/tmp/officecli/live-tests/", import.meta.url));
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "case-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const commands: { name: string; args: object }[] = [];
  const run = (...args: string[]) => commands.push({ name: "officecli_run", args: { args } });
  for (const extension of ["docx", "xlsx", "pptx"]) {
    const path = `sample.${extension}`;
    run("create", path);
    if (extension === "docx") run("add", path, "/body", "--type", "paragraph", "--prop", "text=Forge OfficeCLI live preview");
    if (extension === "xlsx") {
      run("add", path, "/", "--type", "sheet", "--prop", "name=Preview");
      run("set", path, "/Preview/A1", "--prop", "value=Forge OfficeCLI live preview");
    }
    if (extension === "pptx") run("add", path, "/", "--type", "slide", "--prop", "title=Forge OfficeCLI live preview");
    run("view", path, "text");
    run("validate", path);
    commands.push({ name: "officecli_preview", args: { path } }, { name: "publish_file", args: { path } });
  }
  let turn = 0;
  let tools: readonly ToolDefinition[] = [];
  const service = await createHarness({ stateDir: join(root, "state"), providerFactory: () => ({
    listModels: async () => ["office-fixture"],
    complete: async (_messages, definitions) => {
      tools = definitions;
      const next = commands[turn++];
      return next ? { message: { role: "assistant", content: null, tool_calls: [{ id: `office-${turn}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }
        : { message: { role: "assistant", content: "Office documents and immutable HTML previews delivered." } };
    },
  }) });
  try {
    await service.updateSettings({ settings: { model: "office-fixture", baseUrl: "http://fixture.invalid" } });
    await service.configurePlugin!({ pluginId: "officecli", config: { executablePath: executablePath!, timeoutMs: 60000 }, enabled: true });
    expect((await service.checkPlugin!("officecli")).status).toBe("ready");
    const session = await service.createSession({ workspace, title: "OfficeCLI integration" });
    const outcome = await service.run({ sessionId: session.id, permission: "unrestricted", prompt: "Create test documents with HTML preview and downloads." }, () => {}, async () => false, new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(tools.some(tool => tool.function.name === "officecli_preview")).toBe(true);
    const snapshot = await service.getSession(session.id);
    const results = snapshot.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content ?? "{}"));
    expect(results).toHaveLength(commands.length);
    for (const result of results) expect(result.isError, JSON.stringify(result)).toBe(false);
    const files = collectPublishedFiles(snapshot.messages);
    expect(files).toHaveLength(6);
    for (const extension of ["docx", "xlsx", "pptx"]) {
      const file = files.find(item => item.name === `sample.${extension}.preview.html`)!;
      expect(file.previewKind).toBe("html");
      const response = await service.getPublishedFile!(session.id, file.id);
      const html = Buffer.from(response.base64, "base64").toString("utf8");
      expect(html).toContain("Forge OfficeCLI live preview");
      expect(html).toMatch(/<html/i);
      expect(files.some(item => item.name === `sample.${extension}`)).toBe(true);
    }
    const other = await service.createSession({ workspace, title: "Other session" });
    await expect(service.getPublishedFile!(other.id, files[0]!.id)).rejects.toThrow();
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
