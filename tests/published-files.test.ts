import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createWebHost } from "../src/web/server";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "../src/core/harness";
import { createWorkerController } from "../src/desktop/controller";
import { runCliWithIO, type CliIO } from "../src/cli/cli";
import { toolPresentation } from "../src/cli/render/tool-presentation";
import type { ModelProvider, ToolContext } from "../src/shared/contracts";
import { createTransportBridge } from "../src/shared/bridge";
import { collectPublishedFiles, PUBLISHED_FILE_MAX_BYTES } from "../src/shared/published-files";
import { parseSessionId, type Message, type ToolResult } from "../src/shared/schemas";
import { openPublishedFileStore } from "../src/store/published-files";
import { createPublishedFileTool } from "../src/tools/published-files";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "forge-published-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture() {
  const root = await temporary();
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  await mkdir(state, { mode: 0o700 });
  const store = await openPublishedFileStore(state);
  const tool = await createPublishedFileTool(workspace, store, { protectedRoots: [state], redactValues: ["fixture-secret-for-publication"] });
  cleanups.push(() => tool.dispose());
  const context: ToolContext = { sessionId: parseSessionId(randomUUID()), toolCallId: "publish-1", workspace, permission: "workspace", signal: new AbortController().signal, approve: async () => false, onEvent: () => {} };
  const publish = (args: object, override: Partial<ToolContext> = {}) => tool.execute({ id: "publish-1", type: "function", function: { name: "publish_file", arguments: JSON.stringify(args) } }, { ...context, ...override });
  return { root, workspace, state, store, tool, context, publish };
}

describe("published file tool and immutable storage", () => {
  it("publishes metadata only and retains exact bytes after original mutation/deletion and reopen", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "report.md"), "# Original\n");
    const result = await f.publish({ path: "report.md", displayName: "报告.md", description: "分析结论" });
    expect(result.isError).toBe(false);
    const file = result.files![0]!;
    expect(file).toMatchObject({ name: "报告.md", size: 11, mimeType: "text/plain", previewKind: "text", description: "分析结论" });
    expect(result.content).not.toContain("# Original");
    expect(result.content).not.toContain(f.workspace);
    await writeFile(join(f.workspace, "report.md"), "changed");
    await rm(join(f.workspace, "report.md"));
    const response = await (await openPublishedFileStore(f.state)).get(file.id);
    expect(Buffer.from(response.base64, "base64").toString()).toBe("# Original\n");
    expect(response.file).toEqual(file);
    expect(toolPresentation("publish_file", result).detail).toContain("forge files save");
  });

  it("accepts binary files but only previews signature-checked raster images and UTF-8 text", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "archive.zip"), Buffer.from([0, 255, 1, 2]));
    expect((await f.publish({ path: "archive.zip" })).files?.[0]).toMatchObject({ previewKind: "none", size: 4 });
    await writeFile(join(f.workspace, "fake.png"), "<script>bad()</script>");
    expect((await f.publish({ path: "fake.png" })).files?.[0]).toMatchObject({ previewKind: "none", mimeType: "application/octet-stream" });
    await writeFile(join(f.workspace, "image.svg"), "<svg onload='bad()'/>");
    expect((await f.publish({ path: "image.svg" })).files?.[0]?.previewKind).toBe("none");
    await writeFile(join(f.workspace, "page.html"), "<h1>hello</h1>");
    expect((await f.publish({ path: "page.html" })).files?.[0]?.previewKind).toBe("html");
    await writeFile(join(f.workspace, "text.md"), Buffer.from([255, 254]));
    expect((await f.publish({ path: "text.md" })).files?.[0]?.previewKind).toBe("none");
  });

  it("rejects traversal, absolute, sensitive, symlink, hardlink and protected state paths", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "normal.txt"), "normal");
    await writeFile(join(f.root, "outside.txt"), "outside");
    await symlink(join(f.root, "outside.txt"), join(f.workspace, "linked.txt"));
    await link(join(f.workspace, "normal.txt"), join(f.workspace, "hard.txt"));
    await mkdir(join(f.workspace, ".ssh"));
    await writeFile(join(f.workspace, ".ssh", "id_rsa"), "fake");
    for (const path of ["../outside.txt", join(f.root, "outside.txt"), ".ssh/id_rsa", ".env", "linked.txt", "hard.txt", "normal.txt"])
      expect((await f.publish({ path })).isError, path).toBe(true);
    const nested = join(f.workspace, "private-state");
    await mkdir(nested, { mode: 0o700 });
    await writeFile(join(nested, "record.txt"), "private");
    const guarded = await createPublishedFileTool(f.workspace, f.store, { protectedRoots: [nested] });
    cleanups.push(() => guarded.dispose());
    expect((await guarded.execute({ id: "blocked", type: "function", function: { name: "publish_file", arguments: '{"path":"private-state/record.txt"}' } }, f.context)).isError).toBe(true);
  });

  it("refuses known secrets, private keys, invalid names, oversize, readonly and cancellation", async () => {
    const f = await fixture();
    await writeFile(join(f.workspace, "report.txt"), "fixture-secret-for-publication");
    expect((await f.publish({ path: "report.txt" })).isError).toBe(true);
    await writeFile(join(f.workspace, "report.txt"), "-----BEGIN RSA PRIVATE KEY-----\nfixture");
    expect((await f.publish({ path: "report.txt" })).isError).toBe(true);
    await writeFile(join(f.workspace, "report.txt"), "safe");
    expect((await f.publish({ path: "report.txt", displayName: "../escape.txt" })).isError).toBe(true);
    expect((await f.publish({ path: "report.txt" }, { permission: "readonly" })).isError).toBe(true);
    expect((await f.publish({ path: "report.txt" }, { workspace: f.root })).isError).toBe(true);
    await expect(f.publish({ path: "report.txt" }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "cancelled" });
    await writeFile(join(f.workspace, "huge.zip"), Buffer.alloc(PUBLISHED_FILE_MAX_BYTES + 1));
    expect((await f.publish({ path: "huge.zip" })).isError).toBe(true);
  });

  it("enforces a durable session quota and detects tampered stored bytes", async () => {
    const f = await fixture();
    const details = { name: "data.zip", mimeType: "application/zip", previewKind: "none" as const };
    const data = Buffer.alloc(PUBLISHED_FILE_MAX_BYTES);
    let id = "";
    for (let i = 0; i < 8; i++) id = (await f.store.put(f.context.sessionId, data, details, f.context.signal)).id;
    await expect((await openPublishedFileStore(f.state)).put(f.context.sessionId, Buffer.from("x"), details, f.context.signal)).rejects.toMatchObject({ code: "tool" });
    const path = join(f.state, "published-files", `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, base64: "dGFtcGVyZWQ=" }), { mode: 0o600 });
    await expect(f.store.get(id)).rejects.toMatchObject({ code: "storage" });
    await chmod(path, 0o644);
    await expect(f.store.get(id)).rejects.toMatchObject({ code: "storage" });
  });
});

it("wires real runtime publication, authenticated RPC, forks, reopen and CLI save without overwrite", async () => {
  const root = await temporary();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "report.md"), "# delivered\n");
  const stateDir = join(root, "state");
  let turns = 0;
  const provider: ModelProvider = {
    listModels: async () => ["fixture"],
    complete: async (_messages, tools) => {
      expect(tools.some(tool => tool.function.name === "publish_file")).toBe(true);
      return { message: ++turns === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "delivery", type: "function", function: { name: "publish_file", arguments: '{"path":"report.md"}' } }] } : { role: "assistant", content: "Delivered." } };
    },
  };
  const service = await createHarness({ stateDir, providerFactory: () => provider });
  cleanups.push(() => service.dispose());
  await service.updateSettings({ settings: { baseUrl: "https://fixture.invalid/v1", model: "fixture", maxTurns: 3 } });
  const session = await service.createSession({ workspace, title: "Publication test" });
  const finished = await service.run({ sessionId: session.id, prompt: "Generate report", permission: "workspace" }, () => {}, async () => false, new AbortController().signal);
  expect(finished.status).toBe("completed");
  const file = collectPublishedFiles(finished.messages)[0]!;
  expect(file.name).toBe("report.md");
  const stranger = await service.createSession({ workspace });
  await expect(service.getPublishedFile!(stranger.id, file.id)).rejects.toMatchObject({ code: "not_found" });
  const fork = await service.forkSession(session.id);
  expect((await service.getPublishedFile!(fork.id, file.id)).file).toEqual(file);
  const earlyFork = await service.forkSession(session.id, 0);
  await expect(service.getPublishedFile!(earlyFork.id, file.id)).rejects.toMatchObject({ code: "not_found" });
  const sent: unknown[] = [];
  const controller = createWorkerController(service, message => sent.push(message));
  const bridge = createTransportBridge({ onEvent: () => {}, request: async request => {
    await controller.handle(request);
    return (sent.at(-1) as { response: unknown }).response;
  } });
  expect((await bridge.getPublishedFile(session.id, file.id)).file).toEqual(file);
  await expect(bridge.getPublishedFile(stranger.id, file.id)).rejects.toThrow("does not contain");
  const otherWorkspace = join(root, "other-workspace");
  await mkdir(otherWorkspace);
  const other = await service.createSession({ workspace: otherWorkspace });
  const web = await createWebHost({ service, workspace, host: "127.0.0.1", port: 5173 });
  web.server.on("request", (req, res) => { void web.handle(req, res, () => res.end()); });
  await new Promise<void>(done => web.server.listen(0, "127.0.0.1", done));
  const address = web.server.address() as { port: number };
  const headers = { Host: "127.0.0.1:5173", Origin: web.origin, "Content-Type": "application/json" };
  const post = (path: string, input: object, extra: Record<string, string> = {}) => new Promise<{ status: number; data: any }>((done, reject) => {
    const req = httpRequest(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { ...headers, ...extra } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
  try {
    const rpc = { id: randomUUID(), method: "getPublishedFile", sessionId: session.id, fileId: file.id };
    expect((await post("/api/rpc", rpc)).status).toBe(410);
    const login = await post("/api/connect", {});
    const auth = { "X-Forge-Client": login.data.clientId };
    const downloaded = await post("/api/rpc", rpc, auth);
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(downloaded.data.result.base64, "base64").toString()).toBe("# delivered\n");
    expect((await post("/api/rpc", { ...rpc, id: randomUUID(), sessionId: other.id }, auth)).status).toBe(403);
    expect((await post("/api/rpc", { ...rpc, id: randomUUID() }, { ...auth, Origin: "http://evil.invalid" })).status).toBe(403);
  } finally { await web.close(); }
  await rm(join(workspace, "report.md"));
  await service.dispose();
  const reopened = await createHarness({ stateDir });
  cleanups.push(() => reopened.dispose());
  expect(Buffer.from((await reopened.getPublishedFile!(session.id, file.id)).base64, "base64").toString()).toBe("# delivered\n");
  let output = "";
  const io: CliIO = { isTTY: false, stdout: text => { output += text; }, stderr: text => { output += text; }, readStdin: async () => "", question: async () => "", onInterrupt: () => () => {} };
  expect(await runCliWithIO(["files", "list", session.id, "--json"], reopened, io)).toBe(0);
  expect(output).toContain(file.id);
  const destination = join(root, "saved.md");
  expect(await runCliWithIO(["files", "save", session.id, file.id, "--output", destination], reopened, io)).toBe(0);
  expect(await readFile(destination, "utf8")).toBe("# delivered\n");
  expect(await runCliWithIO(["files", "save", session.id, file.id, "--output", destination], reopened, io)).toBe(1);
});

it("never collects failed or non-publisher tool payloads as attachments", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "a.txt"), "a");
  const result = await f.publish({ path: "a.txt" });
  const messages = (name: string, value: ToolResult): Message[] => [
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: JSON.stringify(value) },
  ];
  expect(collectPublishedFiles(messages("run_command", result))).toEqual([]);
  expect(collectPublishedFiles(messages("publish_file", { ...result, isError: true }))).toEqual([]);
  expect(collectPublishedFiles(messages("publish_file", result))).toEqual(result.files);
});
