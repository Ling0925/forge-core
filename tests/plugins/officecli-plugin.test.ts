import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginHost } from "../../src/plugins/host";
import type { OfficeCliResult } from "../../src/plugins/builtin/officecli/backend";
import type { OfficeCliPreview } from "../../src/plugins/officecli";
import type { ToolContext } from "../../src/shared/contracts";
import { officecliPluginConfigSchema } from "../../src/shared/plugins";
import { collectPublishedFiles, type PublishedFile } from "../../src/shared/published-files";
import { approvalRequestSchema, parseSessionId, type Permission } from "../../src/shared/schemas";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const temp = fileURLToPath(new URL("../../../../.forge/tmp/officecli/plugin-tests/", import.meta.url));
const html = "<!doctype html><html><body><h1>Office preview</h1></body></html>";
const result = (stdout = html): OfficeCliResult => ({ stdout, stderr: "", exitCode: 0, truncated: false });
const call = (name: string, args: object) => ({ id: randomUUID(), type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

async function fixture() {
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "case-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "work");
  const home = join(workspace, "state");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(workspace, "report.docx"), "document fixture");
  const execute = vi.fn(async (_args: readonly string[]): Promise<OfficeCliResult> => result());
  const dispose = vi.fn(async () => {});
  const factory = vi.fn(async () => ({ execute, dispose }));
  const publish = vi.fn(async (_session: ToolContext["sessionId"], preview: OfficeCliPreview): Promise<PublishedFile> => ({
    id: randomUUID(), name: preview.name, description: preview.description, mimeType: "text/html", previewKind: "html",
    size: Buffer.byteLength(preview.html), sha256: createHash("sha256").update(preview.html).digest("hex"), createdAt: new Date().toISOString(),
  }));
  const host = await createPluginHost(home, { officecliFactory: factory, publishOfficePreview: publish });
  cleanup.push(() => host.dispose());
  const ctx: ToolContext = { sessionId: parseSessionId(randomUUID()), workspace, toolCallId: "office-call", permission: "unrestricted",
    signal: new AbortController().signal, approve: vi.fn(async () => true), onEvent: vi.fn() };
  const enable = async () => {
    await host.configure({ pluginId: "officecli", enabled: true });
    return host.createTools(workspace, ["test-private-secret"]);
  };
  return { root, home, workspace, host, ctx, factory, execute, dispose, publish, enable };
}

describe("OfficeCLI registration and publication", () => {
  it("defaults to disabled, validates config and stays lazy until execution", async () => {
    const f = await fixture();
    expect((await f.host.list()).find(item => item.manifest.id === "officecli")).toMatchObject({ enabled: false, config: { executablePath: "officecli", timeoutMs: 120000 } });
    expect((await f.host.createTools(f.workspace)).registry.definitions).toHaveLength(0);
    const tools = await f.enable();
    expect(tools.registry.definitions.map(item => item.function.name)).toEqual(["officecli_run", "officecli_preview"]);
    expect(tools.instructions).toContain("not an OS sandbox");
    expect(f.factory).not.toHaveBeenCalled();
    for (const config of [{ timeoutMs: 0 }, { timeoutMs: 300001 }, { executablePath: "x\nother" }, { cwd: "/" }])
      expect(officecliPluginConfigSchema.safeParse(config).success).toBe(false);
  });

  it("checks startup separately and cleans up without exposing arbitrary stdout", async () => {
    const f = await fixture();
    f.execute.mockResolvedValueOnce(result("1.0.158 private diagnostic detail"));
    expect(await f.host.health("officecli")).toMatchObject({ status: "ready" });
    expect(f.execute).toHaveBeenCalledWith(["--version"], expect.anything());
    expect(f.dispose).toHaveBeenCalledTimes(1);
    f.execute.mockResolvedValueOnce({ ...result("private"), exitCode: 1 });
    const health = await f.host.health("officecli");
    expect(health.status).toBe("unavailable");
    expect(health.message).not.toContain("private");
  });

  it.each(["docx", "xlsx", "pptx"])("publishes a %s HTML snapshot and keeps markup out of context", async extension => {
    const f = await fixture();
    await writeFile(join(f.workspace, `sample.${extension}`), "fixture");
    const { registry } = await f.enable();
    const request = call("officecli_preview", { path: `sample.${extension}`, start: 1, end: 2 });
    const output = await registry.execute(request, f.ctx);
    expect(output.isError).toBe(false);
    expect(f.execute).toHaveBeenCalledWith(["view", join(f.workspace, `sample.${extension}`), "html", "--start", "1", "--end", "2"], expect.objectContaining({ timeoutMs: 120000, maxOutputBytes: 8 * 1024 * 1024 }));
    expect(f.publish).toHaveBeenCalledWith(f.ctx.sessionId, expect.objectContaining({ html }), expect.any(AbortSignal));
    expect(output.content).not.toContain("<html");
    expect(output.files?.[0]).toMatchObject({ name: `sample.${extension}.preview.html`, previewKind: "html" });
    expect(collectPublishedFiles([{ role: "assistant", content: null, tool_calls: [request] }, { role: "tool", tool_call_id: request.id, content: JSON.stringify(output) }])).toEqual(output.files);
    const forged = { ...request, function: { ...request.function, name: "officecli_run" } };
    expect(collectPublishedFiles([{ role: "assistant", content: null, tool_calls: [forged] }, { role: "tool", tool_call_id: request.id, content: JSON.stringify(output) }])).toEqual([]);
  });

  it("redacts and bounds command output without retrying a failed mutation", async () => {
    const f = await fixture();
    const { registry } = await f.enable();
    f.execute.mockResolvedValueOnce({ ...result("test-private-secret " + "x".repeat(30000)), stderr: "failed", exitCode: 2 });
    const output = await registry.execute(call("officecli_run", { args: ["set", "report.docx", "/body/p[1]", "--prop", "text=hello world; literal"], timeout_ms: 10000 }), f.ctx);
    expect(output.isError).toBe(true);
    expect(output.content).not.toContain("test-private-secret");
    expect(JSON.parse(output.content)).toMatchObject({ truncated: true, exitCode: 2 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([
    { ...result(), truncated: true }, result("not html"), result("<html>partial"), result("<html>test-private-secret</html>"),
    { ...result('{"success":false}'), exitCode: 0 }, { ...result(), exitCode: 1 },
  ])("never publishes invalid, sensitive, failed or truncated HTML", async output => {
    const f = await fixture();
    const { registry } = await f.enable();
    f.execute.mockResolvedValueOnce(output);
    expect((await registry.execute(call("officecli_preview", { path: "report.docx" }), f.ctx)).isError).toBe(true);
    expect(f.publish).not.toHaveBeenCalled();
  });
});

describe("OfficeCLI permissions, paths and ownership", () => {
  it("denies readonly and declined approval before creating a process", async () => {
    const f = await fixture();
    const { registry } = await f.enable();
    const request = call("officecli_run", { args: ["view", "report.docx", "outline"] });
    expect((await registry.execute(request, { ...f.ctx, permission: "readonly" })).isError).toBe(true);
    expect((await registry.execute(request, { ...f.ctx, permission: "workspace", approve: async () => false })).isError).toBe(true);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("requires per-call approval, rechecks permission and rejects cross-session use", async () => {
    const f = await fixture();
    const { registry } = await f.enable();
    const request = call("officecli_preview", { path: "report.docx" });
    const ctx = { ...f.ctx, permission: "workspace" as const };
    await registry.execute(request, ctx);
    await registry.execute(request, ctx);
    expect(ctx.approve).toHaveBeenCalledTimes(2);
    expect((await registry.execute(request, { ...ctx, sessionId: parseSessionId(randomUUID()) })).isError).toBe(true);
    let permission: Permission = "workspace";
    const changed = { ...ctx, get permission() { return permission; }, approve: async () => { permission = "readonly"; return true; } };
    expect((await registry.execute(request, changed)).isError).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps long argv approvals valid and shows the configured executable", async () => {
    const f = await fixture();
    const { registry } = await f.enable();
    const ctx = { ...f.ctx, permission: "workspace" as const, approve: async (request: unknown) => {
      const parsed = approvalRequestSchema.parse(request);
      expect(parsed.command?.[0]).toBe("officecli");
      expect(parsed.command?.at(-1)).toHaveLength(8100);
      return true;
    } };
    expect((await registry.execute(call("officecli_run", { args: ["set", "report.docx", "/body/p[1]", "--prop", "x".repeat(8100)] }), ctx)).isError).toBe(false);
  });

  it("honors configuration revocation during approval without starting the backend", async () => {
    const f = await fixture();
    const { registry } = await f.enable();
    await expect(registry.execute(call("officecli_preview", { path: "report.docx" }), {
      ...f.ctx, permission: "workspace", approve: async () => { await f.host.configure({ pluginId: "officecli", enabled: false }); return true; },
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("rejects traversal, sensitive/protected roots, symlinks, hardlinks and long-lived commands", async () => {
    const f = await fixture();
    await symlink(join(f.workspace, "report.docx"), join(f.workspace, "alias.docx"));
    await link(join(f.workspace, "report.docx"), join(f.workspace, "hard.docx"));
    await writeFile(join(f.home, "state.docx"), "protected");
    const { registry } = await f.enable();
    for (const path of ["../outside.docx", "/tmp/a.docx", "state/state.docx", ".env.docx", "alias.docx", "hard.docx", "not-office.txt"])
      expect((await registry.execute(call("officecli_preview", { path }), f.ctx)).isError).toBe(true);
    for (const args of [["watch", "report.docx"], ["open", "report.docx"], ["install"], ["mcp"], ["view", "report.docx", "html", "--browser"], ["create", "new.docx", "--out=../bad.docx"]])
      expect((await registry.execute(call("officecli_run", { args }), f.ctx)).isError).toBe(true);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("rechecks the document path after approval and supports guarded new files/help", async () => {
    const f = await fixture();
    const { registry } = await f.enable();
    const swapped = { ...f.ctx, permission: "workspace" as const, approve: async () => {
      await rm(join(f.workspace, "report.docx"));
      await symlink("/missing/outside.docx", join(f.workspace, "report.docx"));
      return true;
    } };
    expect((await registry.execute(call("officecli_preview", { path: "report.docx" }), swapped)).isError).toBe(true);
    expect(f.factory).not.toHaveBeenCalled();
    expect((await registry.execute(call("officecli_run", { args: ["create", "new file.docx"] }), f.ctx)).isError).toBe(false);
    expect(f.execute).toHaveBeenLastCalledWith(["create", join(f.workspace, "new file.docx")], expect.anything());
    await registry.execute(call("officecli_run", { args: ["help", "docx", "add"] }), f.ctx);
    expect(f.execute).toHaveBeenLastCalledWith(["help", "docx", "add"], expect.anything());
  });
});
