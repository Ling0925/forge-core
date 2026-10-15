import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  LocalToolRegistry,
  ToolContext,
} from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import {
  parseSessionId,
  toolDefinitionSchema,
  toolResultSchema,
} from "../../src/shared/schemas";
import type {
  AgentEvent,
  JsonValue,
  Permission,
  ToolResult,
} from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";

const outputSchema = z.record(z.unknown());
function output(result: ToolResult): Readonly<Record<string, unknown>> {
  toolResultSchema.parse(result);
  const parsed: unknown = JSON.parse(result.content);
  return outputSchema.parse(parsed);
}

describe("original local tools", () => {
  let root = "";
  let tools: LocalToolRegistry;
  let controller: AbortController;
  let events: AgentEvent[];
  let approvals = 0;
  let allow = true;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-tools-"));
    tools = await createLocalToolRegistry(root);
    controller = new AbortController();
    events = [];
    approvals = 0;
    allow = true;
  });
  afterEach(async () => {
    await tools.dispose();
    await rm(root, { recursive: true, force: true });
  });
  function context(permission: Permission = "workspace"): ToolContext {
    return {
      sessionId: parseSessionId(randomUUID()),
      toolCallId: "call",
      workspace: root,
      permission,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
      },
      approve: async (request) => {
        approvals += 1;
        expect(events.at(-1)?.type).toBe("approval_requested");
        expect(request.command).toBeDefined();
        expect(request.description).toContain("cwd");
        return allow;
      },
    };
  }
  function execute(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
    permission: Permission = "workspace",
  ): Promise<ToolResult> {
    return tools.execute(
      {
        id: "call",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
      context(permission),
    );
  }
  function node(
    code: string,
    timeout_ms = 2000,
    permission: Permission = "workspace",
  ): Promise<ToolResult> {
    return execute(
      "run_command",
      { argv: [process.execPath, "-e", code], timeout_ms },
      permission,
    );
  }

  it("publishes native strict definitions without executing shell", () => {
    expect(tools.definitions).toHaveLength(10);
    for (const definition of tools.definitions) {
      toolDefinitionSchema.parse(definition);
      expect(definition.function.parameters.additionalProperties).toBe(false);
    }
    expect(events).toEqual([]);
  });

  it("describes native editing first without weakening schemas or safety boundaries", () => {
    const get = (name: string) => {
      const tool = tools.definitions.find(item => item.function.name === name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      return tool.function;
    };
    const write = get("write_file");
    const edit = get("edit_file");
    const command = get("run_command");
    for (const tool of [write, edit]) {
      expect(tool.description).toMatch(/^Default tool/);
      expect(tool.description).toContain("when a checkpoint store is configured");
      expect(tool.description).toContain("previews");
      expect(tool.description).toContain("Workspace-relative only");
      expect(tool.description).toContain("no symlinks or sensitive files");
      expect(tool.description).toContain("Files at most 2 MiB");
      expect(tool.description).toContain("Readonly forbids mutations");
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(write.description).toContain("make_directory");
    expect(edit.description).toContain("exactly one occurrence");
    expect(edit.description).toContain("replace_all");
    expect(write.parameters).toEqual({
      type: "object", additionalProperties: false, required: ["path", "content"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        content: { type: "string", maxLength: 2097152 },
      },
    });
    expect(edit.parameters).toEqual({
      type: "object", additionalProperties: false, required: ["path", "old_text", "new_text"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        old_text: { type: "string", minLength: 1, maxLength: 2097152 },
        new_text: { type: "string", maxLength: 2097152 },
        replace_all: { type: "boolean", default: false },
      },
    });
    for (const rule of [
      "builds, tests, git and package managers", "write_file/edit_file",
      "command effects are not checkpointed", "Readonly denied",
      "per-call approval under the host policy", "NOT an OS sandbox",
      "cwd is guarded", "64 KiB", "128 KiB", "120s",
    ]) expect(command.description).toContain(rule);
    expect(command.description.length).toBeLessThan(850);
  });

  it("reads numbered pages, hits cache, and invalidates on real changes", async () => {
    await writeFile(join(root, "a.txt"), "first\nsecond\nthird");
    const first = output(
      await execute("read_file", { path: "a.txt", limit: 1 }),
    );
    expect(first).toMatchObject({
      content: "1: first",
      cache_hit: false,
      next_offset: 1,
      truncated: true,
    });
    expect(
      output(await execute("read_file", { path: "a.txt", offset: 1 })),
    ).toMatchObject({
      content: "2: second\n3: third",
      cache_hit: true,
      next_offset: null,
    });
    const written = await execute("write_file", {
      path: "a.txt",
      content: "updated",
    });
    expect(written.isError).toBe(false);
    expect(written.changes).toEqual([
      {
        path: "a.txt",
        kind: "modified",
        before: "first\nsecond\nthird",
        after: "updated",
        truncated: false,
      },
    ]);
    expect(output(await execute("read_file", { path: "a.txt" }))).toMatchObject(
      { cache_hit: false, content: "1: updated" },
    );
    await writeFile(join(root, "a.txt"), "external replacement");
    expect(output(await execute("read_file", { path: "a.txt" }))).toMatchObject(
      { cache_hit: false, content: "1: external replacement" },
    );
  });

  it("rejects ambiguous/empty edits and records true previews on explicit replace_all", async () => {
    await writeFile(join(root, "a"), "same same");
    expect(
      (
        await execute("edit_file", {
          path: "a",
          old_text: "same",
          new_text: "new",
        })
      ).isError,
    ).toBe(true);
    expect(await readFile(join(root, "a"), "utf8")).toBe("same same");
    expect(
      (await execute("edit_file", { path: "a", old_text: "", new_text: "new" }))
        .isError,
    ).toBe(true);
    const edited = await execute("edit_file", {
      path: "a",
      old_text: "same",
      new_text: "new",
      replace_all: true,
    });
    expect(edited.changes?.[0]).toMatchObject({
      before: "same same",
      after: "new new",
      kind: "modified",
    });
    expect(output(edited).replacements).toBe(2);
    expect(await readFile(join(root, "a"), "utf8")).toBe("new new");
    expect(
      (
        await execute("edit_file", {
          path: "a",
          old_text: "missing",
          new_text: "new",
        })
      ).isError,
    ).toBe(true);
  });

  it("requires explicit directory creation and refuses escape/symlink traversal", async () => {
    expect(
      (await execute("write_file", { path: "sub/file", content: "ok" }))
        .isError,
    ).toBe(true);
    expect(
      (await execute("make_directory", { path: "sub/deep" })).isError,
    ).toBe(false);
    expect(
      (await execute("make_directory", { path: "sub/deep" })).isError,
    ).toBe(false);
    expect(
      (await execute("write_file", { path: "sub/deep/file", content: "ok" }))
        .isError,
    ).toBe(false);
    await symlink(
      root,
      join(root, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const path of [
      "../escape",
      "/outside",
      "C:\\outside",
      "link/file",
      "link/../file",
    ]) {
      expect(
        (await execute("write_file", { path, content: "no" })).isError,
      ).toBe(true);
      expect((await execute("read_file", { path })).isError).toBe(true);
      expect((await execute("make_directory", { path })).isError).toBe(true);
    }
    expect(
      (
        await execute("run_command", {
          argv: [process.execPath, "-e", "process.exit(0)"],
          cwd: "link",
        })
      ).isError,
    ).toBe(true);
    expect(approvals).toBe(0);
  });

  it("blocks sensitive filenames, binary/oversize text, and private content previews", async () => {
    await mkdir(join(root, ".config"));
    for (const path of [
      ".env",
      ".env.local",
      "credentials.json",
      "private.pem",
      "private.key",
      ".config/settings",
    ]) {
      await writeFile(join(root, path), "private");
      expect((await execute("read_file", { path })).isError).toBe(true);
      expect(
        (await execute("write_file", { path, content: "replacement" })).isError,
      ).toBe(true);
    }
    await writeFile(join(root, "binary"), Buffer.from([0, 255, 1]));
    await writeFile(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    expect((await execute("read_file", { path: "binary" })).isError).toBe(true);
    expect((await execute("read_file", { path: "large" })).isError).toBe(true);
    await writeFile(
      join(root, "ordinary"),
      "-----BEGIN PRIVATE KEY-----\nfixture",
    );
    const refused = await execute("write_file", {
      path: "ordinary",
      content: "replacement",
    });
    expect(refused.isError).toBe(true);
    expect(refused.changes).toBeUndefined();
    expect(refused.content).not.toContain("fixture");
    expect(
      (
        await execute("write_file", {
          path: "new",
          content: "api_key=fixture-only-value",
        })
      ).isError,
    ).toBe(true);
  });

  it("lists and searches literally while excluding dependency/private directories", async () => {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "a"), "a.*b\naXXb");
    await writeFile(join(root, ".env.local"), "a.*b");
    await writeFile(join(root, "node_modules", "dependency"), "a.*b");
    const listing = output(await execute("list_files", { recursive: true }));
    expect(JSON.stringify(listing)).toContain("src/a");
    expect(JSON.stringify(listing)).not.toContain("node_modules");
    expect(JSON.stringify(listing)).not.toContain(".env");
    const matches = output(await execute("search_files", { query: "a.*b" }));
    expect(matches.matches).toEqual([
      {
        path: "src/a",
        line: 1,
        column: 1,
        excerpt: "a.*b",
        excerpt_truncated: false,
      },
    ]);
  });

  it("explicitly truncates huge lines and bounds real change previews", async () => {
    const text = "x".repeat(20000);
    const written = await execute("write_file", {
      path: "long",
      content: text,
    });
    expect(written.changes?.[0]?.truncated).toBe(true);
    expect(written.changes?.[0]?.after?.length).toBe(8192);
    expect(output(await execute("read_file", { path: "long" }))).toMatchObject({
      truncated: true,
      partial_line: true,
    });
  });

  it("rejects unknown tools, invalid JSON and extra fields with bounded authored errors", async () => {
    expect((await execute("unknown", {})).isError).toBe(true);
    expect(
      (await execute("read_file", { path: "a", unexpected: true })).isError,
    ).toBe(true);
    const invalid = await tools.execute(
      {
        id: "call",
        type: "function",
        function: { name: "read_file", arguments: "not json" },
      },
      context(),
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.content).not.toContain("SyntaxError");
    expect(invalid.content.length).toBeLessThan(512);
  });

  it("readonly permits reads but refuses every effect before approval", async () => {
    await writeFile(join(root, "a"), "ok");
    expect(
      (await execute("read_file", { path: "a" }, "readonly")).isError,
    ).toBe(false);
    for (const [name, args] of [
      ["write_file", { path: "a", content: "no" }],
      ["edit_file", { path: "a", old_text: "ok", new_text: "no" }],
      ["make_directory", { path: "new" }],
      ["run_command", { argv: [process.execPath, "-e", "process.exit(0)"] }],
    ] as const) {
      expect((await execute(name, args, "readonly")).isError).toBe(true);
    }
    expect(approvals).toBe(0);
    expect(await readFile(join(root, "a"), "utf8")).toBe("ok");
  });

  it("denies shell effects, and explicitly unrestricted avoids approval", async () => {
    allow = false;
    const denied = await node(
      "require('node:fs').writeFileSync('effect', 'no')",
    );
    expect(denied.isError).toBe(true);
    expect(approvals).toBe(1);
    await expect(readFile(join(root, "effect"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const automatic = await node(
      "process.stdout.write('ok'); process.stderr.write('err')",
      2000,
      "unrestricted",
    );
    expect(output(automatic)).toMatchObject({
      stdout: "ok",
      stderr: "err",
      exit_code: 0,
      timed_out: false,
    });
    expect(automatic.isError).toBe(false);
    expect(approvals).toBe(1);
  });

  it("preserves host HOME without inheriting API keys, tokens or proxies", async () => {
    const home = await mkdtemp(join(tmpdir(), "forge-command-home-"));
    const names = ["FORGE_TEST_API_KEY", "FORGE_TEST_TOKEN", "HTTPS_PROXY", "HOME"];
    const old = names.map((name) => process.env[name]);
    try {
      for (const name of names) process.env[name] = "nonsecret-fixture";
      process.env.HOME = home;
      const run = await node(
        "process.stdout.write(JSON.stringify({key:process.env.FORGE_TEST_API_KEY??null,token:process.env.FORGE_TEST_TOKEN??null,proxy:process.env.HTTPS_PROXY??null,home:process.env.HOME}))",
      );
      const stdout = output(run).stdout;
      expect(typeof stdout).toBe("string");
      if (typeof stdout !== "string") throw new Error("Expected stdout");
      const parsed: unknown = JSON.parse(stdout);
      expect(parsed).toEqual({
        key: null,
        token: null,
        proxy: null,
        home,
      });
      expect(home).not.toBe(root);
    } finally {
      for (const [index, name] of names.entries()) {
        const value = old[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it("enforces timeout/output bounds and reports exit status", async () => {
    const started = Date.now();
    const timeout = await node("setInterval(() => {}, 1000)", 150);
    expect(timeout.isError).toBe(true);
    expect(output(timeout).timed_out).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    const noisy = await node(
      "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)",
    );
    expect(noisy.isError).toBe(true);
    expect(output(noisy).truncated).toBe(true);
    expect(noisy.content.length).toBeLessThan(131072);
    const failed = await node("process.exit(7)");
    expect(failed.isError).toBe(true);
    expect(output(failed).exit_code).toBe(7);
  });

  it("cancels approval immediately even if the approval handler never settles", async () => {
    const pendingContext: ToolContext = {
      ...context(),
      approve: async () => new Promise<boolean>(() => undefined),
    };
    const run = tools.execute(
      {
        id: "call",
        type: "function",
        function: {
          name: "run_command",
          arguments: JSON.stringify({
            argv: [process.execPath, "-e", "process.exit(0)"],
          }),
        },
      },
      pendingContext,
    );
    const assertion = expect(run).rejects.toMatchObject({ code: "cancelled" });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await assertion;
  });

  it("checks cancellation after approval before spawning", async () => {
    const cancellingContext: ToolContext = {
      ...context(),
      approve: async () => {
        controller.abort();
        return true;
      },
    };
    const run = tools.execute(
      {
        id: "call",
        type: "function",
        function: {
          name: "run_command",
          arguments: JSON.stringify({
            argv: [
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync('effect','no')",
            ],
          }),
        },
      },
      cancellingContext,
    );
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    await expect(readFile(join(root, "effect"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32")(
    "cancellation kills the whole POSIX child group and waits for real close",
    async () => {
      const code =
        "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"setInterval(()=>{},1000)\"],{stdio:'inherit'});require('node:fs').writeFileSync('child-pid',String(child.pid));setInterval(()=>{},1000)";
      const run = node(code, 10000);
      const assertion = expect(run).rejects.toMatchObject({
        code: "cancelled",
      });
      let pid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          pid = Number(await readFile(join(root, "child-pid"), "utf8"));
          break;
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pid).toBeDefined();
      controller.abort();
      await assertion;
      if (pid === undefined) throw new Error("Child did not start");
      // A killed orphan can briefly be a zombie until the host reaps it. It must
      // not be running; /proc state distinguishes that from kill(pid, 0).
      let running = true;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          running = !/^State:\s+Z/m.test(status);
        } catch {
          running = false;
        }
        if (!running) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(running).toBe(false);
    },
  );

  it("disposal aborts active commands, awaits settlement, and is idempotent", async () => {
    const run = node("setInterval(() => {}, 1000)", 10000, "unrestricted");
    const assertion = expect(run).rejects.toBeInstanceOf(ForgeError);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const first = tools.dispose();
    expect(tools.dispose()).toBe(first);
    await first;
    await assertion;
    await expect(execute("list_files", {})).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});
