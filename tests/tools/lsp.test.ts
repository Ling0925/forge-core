import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LocalToolRegistry,
  ToolContext,
} from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createLspToolRegistry } from "../../src/tools/lsp";
import { StdioLspClient } from "../../src/tools/lsp-client";
import { type LspServerConfig, LspServerPool } from "../../src/tools/lsp-pool";

const fixture = resolve("tests/tools/fixtures/lsp-server.mjs");
const roots: string[] = [];
const disposables: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(disposables.splice(0).map((x) => x.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
  return {
    id: "fixture",
    command: process.execPath,
    args: [fixture, mode],
    extensions: [".ts"],
  };
}
function context(
  root: string,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
    toolCallId: "lsp-test",
    workspace: root,
    permission: "unrestricted",
    signal: new AbortController().signal,
    approve: async () => true,
    onEvent: () => undefined,
    ...overrides,
  };
}
function call(operation: string, input: Record<string, unknown> = {}) {
  return {
    id: "lsp-test",
    type: "function" as const,
    function: {
      name: "lsp",
      arguments: JSON.stringify({
        operation,
        path: "sample.ts",
        ...(operation === "symbols" ? {} : { line: 1, character: 1 }),
        ...input,
      }),
    },
  };
}
function pool() {
  const value = new LspServerPool();
  disposables.push(value);
  return value;
}
async function registry(root: string, mode = "normal", resident = pool()) {
  const tools = await createLspToolRegistry(root, [config(mode)], {
    pool: resident,
    protectedRoots: [join(root, "private")],
    redactValues: ["secret-token"],
  });
  disposables.push(tools);
  return tools;
}

describe("LSP semantic tools", () => {
  it("is opt-in, exposes one concise tool and flattens/paginates real UTF-8 symbols", async () => {
    const root = await workspace();
    const empty = await createLspToolRegistry(root, [], { pool: pool() });
    disposables.push(empty);
    expect(empty.definitions).toEqual([]);
    const tools = await registry(root);
    expect(tools.definitions.map((d) => d.function.name)).toEqual(["lsp"]);
    const first = await tools.execute(
      call("symbols", { limit: 1 }),
      context(root),
    );
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.content)).toMatchObject({
      operation: "symbols",
      path: "sample.ts",
      nextOffset: 1,
      truncated: true,
      items: [
        {
          name: "café",
          kind: 13,
          path: "sample.ts",
          range: {
            start: { line: 1, character: 1 },
            end: { line: 1, character: 6 },
          },
        },
      ],
    });
    const next = await tools.execute(
      call("symbols", { offset: 1 }),
      context(root),
    );
    expect(JSON.parse(next.content).items[0].name).toBe("nested");
  });

  it("queries definition/LocationLink and filters references outside workspace, sensitive, protected and symlink targets", async () => {
    const root = await workspace();
    const tools = await registry(root);
    for (const operation of ["definition", "references"]) {
      const result = await tools.execute(call(operation), context(root));
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content).items).toEqual([
        {
          path: "sample.ts",
          range: {
            start: { line: 1, character: 1 },
            end: { line: 1, character: 6 },
          },
        },
      ]);
      expect(result.content).not.toContain(root);
      expect(result.content).not.toContain("file:");
    }
  });

  it("sanitizes hover text, URI links and configured secrets", async () => {
    const root = await workspace();
    const result = await (await registry(root)).execute(
      call("hover"),
      context(root),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("café");
    expect(result.content).toContain("[REDACTED]");
    expect(result.content).not.toMatch(/secret-token|file:|https:/);
  });

  it("fresh workspace approval is mandatory and readonly/denial never starts a server", async () => {
    const root = await workspace();
    const starts = vi.spyOn(StdioLspClient.prototype, "start");
    const tools = await registry(root);
    await tools.execute(
      call("symbols"),
      context(root, { permission: "readonly" }),
    );
    await tools.execute(
      call("symbols"),
      context(root, { permission: "workspace", approve: async () => false }),
    );
    expect(starts).not.toHaveBeenCalled();
    const approve = vi.fn(async () => true);
    const onEvent = vi.fn();
    const ctx = context(root, { permission: "workspace", approve, onEvent });
    await tools.execute(call("symbols"), ctx);
    await tools.execute(call("hover"), ctx);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "approval_requested",
      request: { toolName: "lsp" },
    });
    const readonly = await tools.execute(
      call("symbols"),
      context(root, { permission: "readonly", approve }),
    );
    expect(readonly.isError).toBe(true);
    expect(readonly.content).toContain("readonly");
    expect(approve).toHaveBeenCalledTimes(2);
    const denied = await tools.execute(
      call("symbols"),
      context(root, { permission: "workspace", approve: async () => false }),
    );
    expect(denied.content).toContain("denied");
    expect(starts).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe inputs, sensitive content, missing position and ambiguous extension routing", async () => {
    const root = await workspace();
    const tools = await registry(root);
    for (const input of [
      { path: "../outside.ts" },
      { path: ".env.ts" },
      { path: "linked.ts" },
      { path: "private/hidden.ts" },
      { path: "/etc/passwd" },
      { line: 90 },
      { character: 90 },
    ]) {
      expect(
        (await tools.execute(call("hover", input), context(root))).isError,
      ).toBe(true);
    }
    await writeFile(join(root, "sample.ts"), "const hidden = 'secret-token';");
    expect(
      (await tools.execute(call("symbols"), context(root))).content,
    ).toContain("sensitive");
    expect(
      (await tools.execute(call("hover", { line: undefined }), context(root)))
        .isError,
    ).toBe(true);
    await expect(
      createLspToolRegistry(root, [config(), { ...config(), id: "other" }], {
        pool: pool(),
      }),
    ).rejects.toThrow("unique");
    await expect(
      createLspToolRegistry(root, [{ ...config(), args: ["secret-token"] }], {
        pool: pool(),
        redactValues: ["secret-token"],
      }),
    ).rejects.toThrow("Sensitive");
  });

  it("rejects every server-initiated request and supplies a minimal environment with host HOME", async () => {
    vi.stubEnv("LSP_TEST_TOKEN", "not-forwarded");
    const root = await workspace();
    const result = await (await registry(root, "requests")).execute(
      call("hover"),
      context(root),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("denied=true;token=absent;home=true");
  });

  it.each(["oversize", "header", "malformed"])(
    "bounds protocol %s and joins the server",
    async (mode) => {
      const root = await workspace();
      const result = await (await registry(root, mode)).execute(
        call("symbols"),
        context(root),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/length|header|JSON/);
    },
  );

  it("flags field truncation and consumes individually oversize JSON-escaped items without pagination loops", async () => {
    const root = await workspace();
    const tools = await registry(root, "long");
    const symbols = JSON.parse(
      (await tools.execute(call("symbols"), context(root))).content,
    );
    expect(symbols.truncated).toBe(true);
    expect(symbols.items[0].name.length).toBe(512);
    const hover = JSON.parse(
      (await tools.execute(call("hover"), context(root))).content,
    );
    expect(hover.truncated).toBe(true);
    expect(hover.nextOffset).toBeNull();
    expect(hover.items).toEqual([]);
  });

  it("rejects negotiated non-UTF-16 encoding", async () => {
    const root = await workspace();
    expect(
      (
        await (
          await registry(root, "encoding")
        ).execute(call("hover"), context(root))
      ).content,
    ).toContain("UTF-16");
  });

  it("disposal interrupts approval adapters that ignore their signal", async () => {
    const root = await workspace();
    const tools = await registry(root);
    const pending = tools.execute(
      call("symbols"),
      context(root, {
        permission: "workspace",
        approve: () => new Promise<boolean>(() => undefined),
      }),
    );
    await Promise.resolve();
    await tools.dispose();
    expect((await pending).content).toContain("cancelled");
  });

  it("rejects binary, non-UTF-8 and over-2-MiB documents before launch", async () => {
    const root = await workspace();
    const tools = await registry(root);
    for (const bytes of [
      Buffer.from([0]),
      Buffer.from([255]),
      Buffer.alloc(2 * 1024 * 1024 + 1, 97),
    ]) {
      await writeFile(join(root, "sample.ts"), bytes);
      expect(
        (await tools.execute(call("symbols"), context(root))).isError,
      ).toBe(true);
    }
  });

  it("timeouts close/join the client and dispose is idempotent", async () => {
    const root = await workspace();
    const client = new StdioLspClient({
      command: process.execPath,
      args: [fixture, "hang"],
      cwd: root,
      timeoutMs: 100,
    });
    disposables.push(client);
    client.start();
    await expect(
      client.invoke(new AbortController().signal, (request) =>
        request("initialize", {}),
      ),
    ).rejects.toThrow("timed out");
    await client.dispose();
    await client.dispose();
  });

  it("cancellation and registry disposal leave the resident server alive", async () => {
    const root = await workspace();
    const resident = pool();
    const tools = await registry(root, "query-hang", resident);
    const controller = new AbortController();
    const pending = tools.execute(
      call("hover"),
      context(root, { signal: controller.signal }),
    );
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      try {
        pid = Number(await readFile(join(root, "server.pid"), "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    expect((await pending).content).toContain("cancelled");
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect((await tools.execute(call("symbols"), context(root))).isError).toBe(
      false,
    );
    const another = tools.execute(call("hover"), context(root));
    await vi.waitFor(async () => {
      expect(
        (await messages(root)).filter((m) => m.method === "textDocument/hover"),
      ).toHaveLength(2);
    });
    await tools.dispose();
    expect((await another).content).toContain("cancelled");
    await tools.dispose();
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(
      (await tools.execute(call("symbols"), context(root))).content,
    ).toContain("disposed");
    const next = await registry(root, "query-hang", resident);
    expect((await next.execute(call("symbols"), context(root))).isError).toBe(
      false,
    );
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(1);
    await resident.dispose();
    await resident.dispose();
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

async function messages(root: string): Promise<
  {
    method: string;
    id?: number;
    pid?: number;
    params?: {
      id?: number;
      textDocument?: { uri: string; version?: number; text?: string };
      contentChanges?: { text: string }[];
    };
  }[]
> {
  return (await readFile(join(root, "server.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function holdDocument(root: string, tools: LocalToolRegistry) {
  const controller = new AbortController();
  const pending = tools.execute(
    call("definition"),
    context(root, { signal: controller.signal }),
  );
  await vi.waitFor(async () => {
    expect(
      (await messages(root)).filter(
        (m) => m.method === "textDocument/definition",
      ),
    ).toHaveLength(1);
  });
  return { controller, pending };
}

describe("resident LSP servers", () => {
  it("reuses one initialized process across registries and preserves uncached results", async () => {
    const root = await workspace();
    const resident = pool();
    const first = await registry(root, "normal", resident);
    const result = await first.execute(call("symbols"), context(root));
    await first.dispose();
    const next = await registry(root, "normal", resident);
    expect(await next.execute(call("symbols"), context(root))).toEqual(result);
    const recorded = await messages(root);
    for (const method of ["spawn", "initialize", "initialized"])
      expect(recorded.filter((m) => m.method === method)).toHaveLength(1);
    expect(
      recorded.filter((m) => m.method === "textDocument/didOpen"),
    ).toHaveLength(2);
    expect(
      recorded.filter((m) => m.method === "textDocument/didChange"),
    ).toHaveLength(0);
    const fresh = await registry(root);
    expect(await fresh.execute(call("symbols"), context(root))).toEqual(result);
  });

  it("closes documents after their calls and reopens changed files at version one", async () => {
    const root = await workspace();
    const tools = await registry(root, "sync");
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    const query = () => tools.execute(call("hover"), context(root));
    await query();
    await query();
    await writeFile(join(root, "sample.ts"), "const café = 2;\n");
    const changed = await query();
    expect(changed.content).toContain("const café = 2;");
    const notifications = notify.mock.calls.filter(([method]) =>
      method.startsWith("textDocument/"),
    );
    expect(notifications.map(([method]) => method)).toEqual([
      "textDocument/didOpen",
      "textDocument/didClose",
      "textDocument/didOpen",
      "textDocument/didClose",
      "textDocument/didOpen",
      "textDocument/didClose",
    ]);
    expect(
      notifications
        .filter(([method]) => method === "textDocument/didOpen")
        .map(([, params]) => params.textDocument),
    ).toEqual([
      expect.objectContaining({ version: 1, text: "const café = 1;\n" }),
      expect.objectContaining({ version: 1, text: "const café = 1;\n" }),
      expect.objectContaining({ version: 1, text: "const café = 2;\n" }),
    ]);
  });

  it("queries an import from disk after its previously opened dependency changes", async () => {
    const root = await workspace();
    await writeFile(join(root, "sample.ts"), "export const value = 1;\n");
    await writeFile(
      join(root, "other.ts"),
      'import { value } from "./sample.ts";\n',
    );
    const tools = await registry(root, "imports");
    expect(
      (await tools.execute(call("hover"), context(root))).content,
    ).toContain("value = 1");
    await writeFile(join(root, "sample.ts"), "export const value = 2;\n");
    const other = call("hover", { path: "other.ts" });
    const result = await tools.execute(other, context(root));
    expect(result.content).toContain("value = 2");
    const fresh = await registry(root, "imports");
    expect(await fresh.execute(other, context(root))).toEqual(result);
  });

  it("keeps one document open until both concurrent calls settle", async () => {
    const root = await workspace();
    const tools = await registry(root, "sync-hang");
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    const { controller, pending } = await holdDocument(root, tools);
    expect((await tools.execute(call("hover"), context(root))).isError).toBe(
      false,
    );
    expect(
      notify.mock.calls.filter(([method]) => method === "textDocument/didOpen"),
    ).toHaveLength(1);
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didChange",
      ),
    ).toHaveLength(0);
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didClose",
      ),
    ).toHaveLength(0);
    controller.abort();
    expect((await pending).content).toContain("LSP invocation cancelled.");
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didClose",
      ),
    ).toHaveLength(1);
    expect((await tools.execute(call("hover"), context(root))).isError).toBe(
      false,
    );
    expect(
      notify.mock.calls.filter(([method]) => method === "textDocument/didOpen"),
    ).toHaveLength(2);
  });

  it("closes a document when the server rejects its query", async () => {
    const root = await workspace();
    const tools = await registry(root, "query-reject");
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    for (let i = 0; i < 2; i++)
      expect(
        (await tools.execute(call("hover"), context(root))).content,
      ).toContain("LSP server rejected the query.");
    expect(
      notify.mock.calls.filter(([method]) => method === "textDocument/didOpen"),
    ).toHaveLength(2);
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didClose",
      ),
    ).toHaveLength(2);
  });

  it("tracks open document uses independently by URI", async () => {
    const root = await workspace();
    const tools = await registry(root, "sync-hang");
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    const { controller, pending } = await holdDocument(root, tools);
    const first = await tools.execute(call("hover"), context(root));
    await writeFile(join(root, "other.ts"), "const other = 1;\n");
    const other = call("hover", { path: "other.ts" });
    expect((await tools.execute(other, context(root))).content).toContain(
      "const other = 1;",
    );
    expect(await tools.execute(call("hover"), context(root))).toEqual(first);
    await writeFile(join(root, "other.ts"), "const other = 2;\n");
    expect((await tools.execute(other, context(root))).content).toContain(
      "const other = 2;",
    );
    expect(await tools.execute(call("hover"), context(root))).toEqual(first);
    const recorded = await messages(root);
    expect(
      recorded
        .filter((m) => m.method === "textDocument/didOpen")
        .map((m) => m.params?.textDocument?.version),
    ).toEqual([1, 1, 1]);
    const changes = recorded.filter(
      (m) => m.method === "textDocument/didChange",
    );
    expect(changes).toHaveLength(0);
    const closed = () =>
      notify.mock.calls
        .filter(([method]) => method === "textDocument/didClose")
        .map(([, params]) => params.textDocument);
    expect(closed()).toEqual([
      { uri: expect.stringContaining("other.ts") },
      { uri: expect.stringContaining("other.ts") },
    ]);
    controller.abort();
    await pending;
    expect(closed()).toHaveLength(3);
    expect(closed().at(-1)).toEqual({
      uri: expect.stringContaining("sample.ts"),
    });
  });

  it("invalidates on a stamp change even with identical text, and on text change with an identical stamp", async () => {
    const root = await workspace();
    const tools = await registry(root, "sync-hang");
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    const path = join(root, "sample.ts");
    await utimes(path, 1, 1);
    const { controller, pending } = await holdDocument(root, tools);
    await tools.execute(call("hover"), context(root));
    await utimes(path, 2, 2);
    await tools.execute(call("hover"), context(root));
    const before = await stat(path);
    await writeFile(path, "const café = 2;\n");
    await utimes(path, before.atime, before.mtime);
    expect(await stat(path)).toMatchObject({
      size: before.size,
      mtimeMs: before.mtimeMs,
      ino: before.ino,
    });
    await tools.execute(call("hover"), context(root));
    const changes = (await messages(root)).filter(
      (m) => m.method === "textDocument/didChange",
    );
    expect(changes.map((m) => m.params?.textDocument?.version)).toEqual([2, 3]);
    expect(changes[1]?.params?.contentChanges).toEqual([
      { text: "const café = 2;\n" },
    ]);
    const replacement = join(root, "replacement.ts");
    await writeFile(replacement, "const café = 2;\n");
    await utimes(replacement, before.atime, before.mtime);
    await rename(replacement, path);
    expect((await stat(path)).ino).not.toBe(before.ino);
    await tools.execute(call("hover"), context(root));
    expect(
      (await messages(root))
        .filter((m) => m.method === "textDocument/didChange")
        .map((m) => m.params?.textDocument?.version),
    ).toEqual([2, 3, 4]);
    controller.abort();
    await pending;
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didClose",
      ),
    ).toHaveLength(1);
  });

  it("multiplexes concurrent queries with out-of-order replies and one initialization", async () => {
    const root = await workspace();
    const tools = await registry(root, "concurrent");
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    const results = await Promise.all([
      tools.execute(call("hover"), context(root)),
      tools.execute(call("hover"), context(root)),
    ]);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(
      results.map((result) => JSON.parse(result.content).items[0].text).sort(),
    ).toEqual(["first", "second"]);
    const recorded = await messages(root);
    expect(recorded.filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(
      recorded.filter((m) => m.method === "textDocument/didOpen"),
    ).toHaveLength(1);
    expect(
      new Set(
        recorded
          .filter((m) => m.method === "textDocument/hover")
          .map((m) => m.id),
      ).size,
    ).toBe(2);
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didClose",
      ),
    ).toHaveLength(1);
  });

  it("does not charge other concurrent replies against a call's message budget", async () => {
    const root = await workspace();
    const resident = pool();
    const absolute = join(root, "sample.ts");
    const document = {
      absolute,
      text: await readFile(absolute, "utf8"),
      stamp: await stat(absolute),
      languageId: "typescript",
    };
    const responses = await Promise.all(
      Array.from({ length: 260 }, () =>
        resident.request(
          root,
          config("concurrent"),
          document,
          "textDocument/hover",
          {},
          new AbortController().signal,
        ),
      ),
    );
    expect(responses).toHaveLength(260);
    expect(
      new Set(responses.map((response) => JSON.stringify(response))),
    ).toEqual(
      new Set([
        JSON.stringify({ contents: "first" }),
        JSON.stringify({ contents: "second" }),
      ]),
    );
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(1);
  });

  it("cancels an initialization waiter without cancelling shared initialization", async () => {
    const root = await workspace();
    const tools = await registry(root, "initialize-wait");
    const controller = new AbortController();
    const pending = tools.execute(
      call("hover"),
      context(root, { signal: controller.signal }),
    );
    await vi.waitFor(async () => {
      expect(
        (await messages(root)).some((m) => m.method === "initialize"),
      ).toBe(true);
    });
    const next = tools.execute(call("symbols"), context(root));
    controller.abort();
    expect((await pending).content).toContain("LSP invocation cancelled.");
    await writeFile(join(root, "initialize.ready"), "");
    expect((await next).isError).toBe(false);
    expect((await tools.execute(call("hover"), context(root))).isError).toBe(
      false,
    );
    const recorded = await messages(root);
    expect(recorded.filter((m) => m.method === "spawn")).toHaveLength(1);
    expect(recorded.filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(
      recorded.filter((m) => m.method === "textDocument/hover"),
    ).toHaveLength(1);
  });

  it("keeps existing traffic and message budgets per invocation", async () => {
    const root = await workspace();
    const tools = await registry(root, "notifications");
    for (let i = 0; i < 3; i++)
      expect((await tools.execute(call("hover"), context(root))).isError).toBe(
        false,
      );
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(1);
  });

  it("clears invocation timers while idle", async () => {
    const root = await workspace();
    const tools = await registry(root);
    await tools.execute(call("hover"), context(root));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect((await tools.execute(call("hover"), context(root))).isError).toBe(
        false,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes a pool with an active query and prevents new starts", async () => {
    const root = await workspace();
    const resident = pool();
    const tools = await registry(root, "query-hang", resident);
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    const pending = tools.execute(call("hover"), context(root));
    await vi.waitFor(async () => {
      expect(
        (await messages(root)).some((m) => m.method === "textDocument/hover"),
      ).toBe(true);
    });
    const pid = (await messages(root))[0]?.pid;
    await resident.dispose();
    expect((await pending).content).toContain("disposed");
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didClose",
      ),
    ).toHaveLength(0);
    expect(() => process.kill(Number(pid), 0)).toThrow();
    expect(
      (await tools.execute(call("symbols"), context(root))).content,
    ).toContain("disposed");
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(1);
  });

  it("replaces a client after protocol failure without retrying the failed call", async () => {
    const root = await workspace();
    const tools = await registry(root, "query-malformed");
    const notify = vi.spyOn(StdioLspClient.prototype, "notify");
    expect(
      (await tools.execute(call("hover"), context(root))).content,
    ).toContain("LSP message is not valid UTF-8 JSON.");
    expect(
      notify.mock.calls.filter(
        ([method]) => method === "textDocument/didClose",
      ),
    ).toHaveLength(0);
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(1);
    expect((await tools.execute(call("hover"), context(root))).isError).toBe(
      false,
    );
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(2);
  });

  it("replaces a crashed server only on the next call", async () => {
    const root = await workspace();
    const tools = await registry(root, "crash");
    expect(
      (await tools.execute(call("hover"), context(root))).content,
    ).toContain("LSP server exited.");
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(1);
    expect((await tools.execute(call("hover"), context(root))).isError).toBe(
      false,
    );
    const starts = (await messages(root)).filter((m) => m.method === "spawn");
    expect(starts).toHaveLength(2);
    expect(starts[0]?.pid).not.toBe(starts[1]?.pid);
  });

  it("evicts a server that exits while idle", async () => {
    const root = await workspace();
    const tools = await registry(root);
    await tools.execute(call("hover"), context(root));
    const pid = (await messages(root))[0]?.pid;
    const dispose = vi.spyOn(StdioLspClient.prototype, "dispose");
    process.kill(Number(pid), "SIGKILL");
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
    expect((await tools.execute(call("hover"), context(root))).isError).toBe(
      false,
    );
    expect(
      (await messages(root)).filter((m) => m.method === "spawn"),
    ).toHaveLength(2);
  });

  it("removes absent configs only in their workspace", async () => {
    const root = await workspace();
    const other = await workspace();
    const resident = pool();
    const first = await registry(root, "normal", resident);
    const second = await registry(other, "normal", resident);
    await first.execute(call("symbols"), context(root));
    await second.execute(call("symbols"), context(other));
    const pid = (await messages(root))[0]?.pid;
    const otherPid = (await messages(other))[0]?.pid;
    expect(pid).toBeTypeOf("number");
    expect(otherPid).toBeTypeOf("number");
    const empty = await createLspToolRegistry(root, [], { pool: resident });
    disposables.push(empty);
    expect(() => process.kill(Number(pid), 0)).toThrow();
    expect(() => process.kill(Number(otherPid), 0)).not.toThrow();
    expect(
      (await second.execute(call("symbols"), context(other))).isError,
    ).toBe(false);
  });

  it.each([
    { id: "renamed" },
    { command: join(process.execPath, "changed") },
    { args: [fixture, "sync"] },
    { extensions: [".tsx"] },
  ])(
    "invalidates changed server identity %j without launching its replacement",
    async (change) => {
      const root = await workspace();
      const resident = pool();
      const tools = await registry(root, "normal", resident);
      await tools.execute(call("symbols"), context(root));
      const pid = (await messages(root))[0]?.pid;
      const next = await createLspToolRegistry(
        root,
        [{ ...config(), ...change }],
        { pool: resident },
      );
      disposables.push(next);
      expect(() => process.kill(Number(pid), 0)).toThrow();
      expect(
        (await messages(root)).filter((m) => m.method === "spawn"),
      ).toHaveLength(1);
    },
  );

  it("revalidates content and approval before any traffic on a resident server", async () => {
    const root = await workspace();
    const tools = await registry(root);
    const approve = vi.fn(async () => true);
    const ctx = context(root, { permission: "workspace", approve });
    await tools.execute(call("symbols"), ctx);
    await tools.execute(call("hover"), ctx);
    expect(approve).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      expect(
        (await messages(root)).filter(
          (m) => m.method === "textDocument/didClose",
        ),
      ).toHaveLength(2);
    });
    const before = await messages(root);
    await tools.execute(
      call("hover"),
      context(root, { permission: "readonly" }),
    );
    await tools.execute(
      call("hover"),
      context(root, { permission: "workspace", approve: async () => false }),
    );
    await writeFile(join(root, "sample.ts"), "const hidden = 'secret-token';");
    expect((await tools.execute(call("symbols"), ctx)).content).toContain(
      "sensitive",
    );
    expect(approve).toHaveBeenCalledTimes(3);
    expect(await messages(root)).toEqual(before);
  });
});
