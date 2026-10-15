import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { StdioLspClient } from "../../src/tools/lsp-client";
import { createLspToolRegistry, type LspServerConfig } from "../../src/tools/lsp";

const fixture = resolve("tests/tools/fixtures/lsp-server.mjs");
const roots: string[] = [];
const disposables: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(disposables.splice(0).map((x) => x.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "forge-lsp-"));
  roots.push(root);
  await writeFile(join(root, "sample.ts"), "const café = 1;\n");
  await writeFile(join(root, ".env.ts"), "hidden");
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private", "hidden.ts"), "hidden");
  await symlink(join(root, "sample.ts"), join(root, "linked.ts"));
  return root;
}
function config(mode = "normal"): LspServerConfig {
  return { id: "fixture", command: process.execPath, args: [fixture, mode], extensions: [".ts"] };
}
function context(root: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
    toolCallId: "lsp-test", workspace: root, permission: "unrestricted",
    signal: new AbortController().signal, approve: async () => true, onEvent: () => undefined,
    ...overrides };
}
function call(operation: string, input: Record<string, unknown> = {}) {
  return { id: "lsp-test", type: "function" as const,
    function: { name: "lsp", arguments: JSON.stringify({ operation, path: "sample.ts", ...(operation === "symbols" ? {} : { line: 1, character: 1 }), ...input }) } };
}
async function registry(root: string, mode = "normal") {
  const tools = await createLspToolRegistry(root, [config(mode)], {
    protectedRoots: [join(root, "private")], redactValues: ["secret-token"],
  });
  disposables.push(tools);
  return tools;
}

describe("LSP semantic tools", () => {
  it("is opt-in, exposes one concise tool and flattens/paginates real UTF-8 symbols", async () => {
    const root = await workspace();
    const empty = await createLspToolRegistry(root, []);
    disposables.push(empty);
    expect(empty.definitions).toEqual([]);
    const tools = await registry(root);
    expect(tools.definitions.map((d) => d.function.name)).toEqual(["lsp"]);
    const first = await tools.execute(call("symbols", { limit: 1 }), context(root));
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.content)).toMatchObject({ operation: "symbols", path: "sample.ts", nextOffset: 1, truncated: true,
      items: [{ name: "café", kind: 13, path: "sample.ts", range: { start: { line: 1, character: 1 }, end: { line: 1, character: 6 } } }] });
    const next = await tools.execute(call("symbols", { offset: 1 }), context(root));
    expect(JSON.parse(next.content).items[0].name).toBe("nested");
  });

  it("queries definition/LocationLink and filters references outside workspace, sensitive, protected and symlink targets", async () => {
    const root = await workspace();
    const tools = await registry(root);
    for (const operation of ["definition", "references"]) {
      const result = await tools.execute(call(operation), context(root));
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content).items).toEqual([{ path: "sample.ts", range: {
        start: { line: 1, character: 1 }, end: { line: 1, character: 6 },
      } }]);
      expect(result.content).not.toContain(root);
      expect(result.content).not.toContain("file:");
    }
  });

  it("sanitizes hover text, URI links and configured secrets", async () => {
    const root = await workspace();
    const result = await (await registry(root)).execute(call("hover"), context(root));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("café");
    expect(result.content).toContain("[REDACTED]");
    expect(result.content).not.toMatch(/secret-token|file:|https:/);
  });

  it("fresh workspace approval is mandatory and readonly/denial never starts a server", async () => {
    const root = await workspace();
    const tools = await registry(root);
    const approve = vi.fn(async () => true);
    const onEvent = vi.fn();
    const ctx = context(root, { permission: "workspace", approve, onEvent });
    await tools.execute(call("symbols"), ctx);
    await tools.execute(call("hover"), ctx);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ type: "approval_requested", request: { toolName: "lsp" } });
    const readonly = await tools.execute(call("symbols"), context(root, { permission: "readonly", approve }));
    expect(readonly.isError).toBe(true);
    expect(readonly.content).toContain("readonly");
    expect(approve).toHaveBeenCalledTimes(2);
    const denied = await tools.execute(call("symbols"), context(root, { permission: "workspace", approve: async () => false }));
    expect(denied.content).toContain("denied");
  });

  it("rejects unsafe inputs, sensitive content, missing position and ambiguous extension routing", async () => {
    const root = await workspace();
    const tools = await registry(root);
    for (const input of [ { path: "../outside.ts" }, { path: ".env.ts" }, { path: "linked.ts" },
      { path: "private/hidden.ts" }, { path: "/etc/passwd" }, { line: 90 }, { character: 90 } ]) {
      expect((await tools.execute(call("hover", input), context(root))).isError).toBe(true);
    }
    await writeFile(join(root, "sample.ts"), "const hidden = 'secret-token';");
    expect((await tools.execute(call("symbols"), context(root))).content).toContain("sensitive");
    expect((await tools.execute(call("hover", { line: undefined }), context(root))).isError).toBe(true);
    await expect(createLspToolRegistry(root, [config(), { ...config(), id: "other" }])).rejects.toThrow("unique");
    await expect(createLspToolRegistry(root, [{ ...config(), args: ["secret-token"] }], { redactValues: ["secret-token"] })).rejects.toThrow("Sensitive");
  });

  it("rejects every server-initiated request and supplies a minimal environment with host HOME", async () => {
    vi.stubEnv("LSP_TEST_TOKEN", "not-forwarded");
    const root = await workspace();
    const result = await (await registry(root, "requests")).execute(call("hover"), context(root));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("denied=true;token=absent;home=true");
  });

  it.each(["oversize", "header", "malformed"])("bounds protocol %s and joins the server", async (mode) => {
    const root = await workspace();
    const result = await (await registry(root, mode)).execute(call("symbols"), context(root));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/length|header|JSON/);
  });

  it("flags field truncation and consumes individually oversize JSON-escaped items without pagination loops", async () => {
    const root = await workspace();
    const tools = await registry(root, "long");
    const symbols = JSON.parse((await tools.execute(call("symbols"), context(root))).content);
    expect(symbols.truncated).toBe(true);
    expect(symbols.items[0].name.length).toBe(512);
    const hover = JSON.parse((await tools.execute(call("hover"), context(root))).content);
    expect(hover.truncated).toBe(true);
    expect(hover.nextOffset).toBeNull();
    expect(hover.items).toEqual([]);
  });

  it("rejects negotiated non-UTF-16 encoding", async () => {
    const root = await workspace();
    expect((await (await registry(root, "encoding")).execute(call("hover"), context(root))).content).toContain("UTF-16");
  });

  it("disposal interrupts approval adapters that ignore their signal", async () => {
    const root = await workspace();
    const tools = await registry(root);
    const pending = tools.execute(call("symbols"), context(root, {
      permission: "workspace", approve: () => new Promise<boolean>(() => undefined),
    }));
    await Promise.resolve();
    await tools.dispose();
    expect((await pending).content).toContain("cancelled");
  });

  it("rejects binary, non-UTF-8 and over-2-MiB documents before launch", async () => {
    const root = await workspace();
    const tools = await registry(root);
    for (const bytes of [Buffer.from([0]), Buffer.from([255]), Buffer.alloc(2 * 1024 * 1024 + 1, 97)]) {
      await writeFile(join(root, "sample.ts"), bytes);
      expect((await tools.execute(call("symbols"), context(root))).isError).toBe(true);
    }
  });

  it("timeouts close/join the client and dispose is idempotent", async () => {
    const root = await workspace();
    const client = new StdioLspClient({ command: process.execPath, args: [fixture, "hang"], cwd: root,
      signal: new AbortController().signal, timeoutMs: 100 });
    disposables.push(client);
    client.start();
    await expect(client.request("initialize", {})).rejects.toThrow("timed out");
    await client.dispose();
    await client.dispose();
  });

  it("cancellation and registry disposal terminate an active query before returning", async () => {
    const root = await workspace();
    const tools = await registry(root, "query-hang");
    const controller = new AbortController();
    const pending = tools.execute(call("hover"), context(root, { signal: controller.signal }));
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = Number(await readFile(join(root, "server.pid"), "utf8")); }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect((await pending).content).toContain("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
    await tools.dispose();
    await tools.dispose();
    expect((await tools.execute(call("symbols"), context(root))).content).toContain("disposed");
  });
});
