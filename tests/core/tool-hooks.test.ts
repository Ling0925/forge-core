import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createToolHookService,
  toToolHookOutcome,
} from "../../src/core/tool-hooks";
import {
  type BeforeToolHookEvent,
  TOOL_HOOK_MAX_OUTPUT_BYTES,
  type ToolHookEntry,
  toolHookDiagnosticSchema,
  toolHooksConfigSchema,
} from "../../src/shared/tool-hooks";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-tool-hooks-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const session = {
  sessionId: "session-fixture",
  workspace: root,
  permission: "workspace",
} as const;

const beforeEvent = (
  name = "run_command",
  args = '{"argv":["git","status"]}',
): BeforeToolHookEvent => ({
  session,
  tool: { name, callId: "call-1", arguments: args },
});

const outcome = (content: string, isError = false) =>
  toToolHookOutcome({ content, isError, changes: [] });

const hook = (
  id: string,
  code: string,
  overrides: Partial<ToolHookEntry> = {},
): ToolHookEntry => ({
  id,
  command: process.execPath,
  args: ["-e", code],
  timeoutMs: 2000,
  maxOutputBytes: 8192,
  ...overrides,
});

const config = (partial: Record<string, readonly ToolHookEntry[]> = {}) =>
  toolHooksConfigSchema.parse({
    beforeTool: [],
    afterTool: [],
    toolError: [],
    runEnd: [],
    ...partial,
  });

it("does nothing and spawns nothing when the host configures no hooks", async () => {
  const marker = join(root, "spawned");
  const service = createToolHookService(config());
  expect(service.configured).toBe(false);
  expect(service.hookCount).toBe(0);
  const result = await service.beforeTool(beforeEvent());
  expect(result).toEqual({ allowed: true, diagnostics: [] });
  expect(
    await service.afterTool({
      session,
      tool: beforeEvent().tool,
      outcome: outcome("ok"),
    }),
  ).toEqual([]);
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await service.dispose();
});

it("allows when a before hook prints an explicit allow decision", async () => {
  const seen = join(root, "stdin.json");
  const service = createToolHookService(
    config({
      beforeTool: [
        hook(
          "allow",
          `const fs=require('node:fs');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{fs.writeFileSync(${JSON.stringify(seen)},s);process.stdout.write(JSON.stringify({decision:'allow'}));});`,
        ),
      ],
    }),
  );
  const result = await service.beforeTool(beforeEvent());
  expect(result.allowed).toBe(true);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({
    hook: "beforeTool",
    id: "allow",
    status: "ok",
  });
  const payload = JSON.parse(await readFile(seen, "utf8"));
  expect(payload.hook).toBe("beforeTool");
  expect(payload.version).toBe(1);
  expect(Object.keys(payload).sort()).toEqual([
    "hook",
    "session",
    "tool",
    "version",
  ]);
  expect(payload.session).toEqual(session);
  expect(payload.tool).toMatchObject({
    name: "run_command",
    callId: "call-1",
    arguments: '{"argv":["git","status"]}',
    argumentsTruncated: false,
  });
  await service.dispose();
});

it("stops a before gate at the first denial without running later hooks", async () => {
  const log = join(root, "gate.log");
  const service = createToolHookService(
    config({
      beforeTool: [
        hook(
          "deny-first",
          `require('node:fs').appendFileSync(${JSON.stringify(log)},'first\\n');process.stdout.write('{"decision":"deny","reason":"no"}')`,
        ),
        hook(
          "never",
          `require('node:fs').appendFileSync(${JSON.stringify(log)},'second\\n');process.stdout.write('{"decision":"allow"}')`,
        ),
      ],
    }),
  );
  const result = await service.beforeTool(beforeEvent());
  expect(result.allowed).toBe(false);
  expect(result.diagnostics).toHaveLength(1);
  expect(await readFile(log, "utf8")).toBe("first\n");
  await service.dispose();
});

it("denies with a generic authored reason and never echoes hook-supplied text", async () => {
  const calls = join(root, "calls");
  const secret = "sk-live-super-secret";
  const service = createToolHookService(
    config({
      beforeTool: [
        hook(
          "deny",
          `require('node:fs').appendFileSync(${JSON.stringify(calls)},'x');process.stdout.write(JSON.stringify({decision:'deny',reason:${JSON.stringify(`Blocked ${secret}\nPlease use read-only tools.`)}}));`,
          { tools: ["run_command"] },
        ),
      ],
    }),
    { redactValues: [secret] },
  );
  const event = beforeEvent("run_command", `{"token":"${secret}"}`);
  const original = JSON.stringify(event);
  const result = await service.beforeTool(event);
  expect(result.allowed).toBe(false);
  expect(result.denialReason).toBe(
    "The beforeTool hook denied this tool call.",
  );
  expect(result.diagnostics[0]).toMatchObject({
    status: "denied",
    reason: "The beforeTool hook denied this tool call.",
  });
  // Neither the raw hook reason nor the secret is exposed publicly.
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("Please use read-only");
  // The service never rewrites the caller's event or arguments.
  expect(JSON.stringify(event)).toBe(original);
  // Exactly one execution: a deny is not retried and does not replay.
  expect(await readFile(calls, "utf8")).toBe("x");
  await service.dispose();
});

it("fails closed when a before hook is not JSON, exits nonzero or times out", async () => {
  for (const [name, entry, expected] of [
    ["garbage", hook("garbage", "process.stdout.write('not json')"), "failed"],
    ["nonzero", hook("nonzero", "process.exit(3)"), "failed"],
    [
      "timeout",
      hook("timeout", "setInterval(()=>{},1000)", { timeoutMs: 150 }),
      "timed_out",
    ],
  ] as const) {
    const service = createToolHookService(config({ beforeTool: [entry] }));
    const result = await service.beforeTool(beforeEvent());
    expect(result.allowed, name).toBe(false);
    expect(result.diagnostics[0]?.status).toBe(expected);
    expect(result.diagnostics[0]?.reason).toBeTruthy();
    await service.dispose();
  }
});

it("reports a nonzero after hook without replacing the original tool outcome", async () => {
  const service = createToolHookService(
    config({
      afterTool: [hook("after", "process.exit(4)")],
    }),
  );
  const result = outcome("tool succeeded");
  const diagnostics = await service.afterTool({
    session,
    tool: beforeEvent().tool,
    outcome: result,
  });
  expect(result).toEqual({
    isError: false,
    contentBytes: 14,
    contentPreview: "tool succeeded",
    truncated: false,
    changeCount: 0,
  });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    hook: "afterTool",
    status: "failed",
    exitCode: 4,
  });
  await service.dispose();
});

it("bounds stdout/stderr and reports truncation without exposing child output", async () => {
  const service = createToolHookService(
    config({
      afterTool: [
        hook(
          "noisy",
          `process.stdout.write('x'.repeat(50000));process.stderr.write('y'.repeat(50000));`,
          { maxOutputBytes: 512 },
        ),
      ],
    }),
  );
  const diagnostics = await service.afterTool({
    session,
    tool: beforeEvent().tool,
    outcome: outcome("ok"),
  });
  expect(diagnostics[0]?.outputTruncated).toBe(true);
  expect(diagnostics[0]?.stdoutBytes).toBe(50000);
  expect(diagnostics[0]?.stderrBytes).toBe(50000);
  // No raw child output is ever returned in diagnostics.
  expect(JSON.stringify(diagnostics)).not.toContain("xxxx");
  expect(JSON.stringify(diagnostics)).not.toContain("yyyy");
  expect(TOOL_HOOK_MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(512);
  await service.dispose();
});

it("cancels an in-flight hook and terminates the owned process", async () => {
  const pidFile = join(root, "pid");
  const service = createToolHookService(
    config({
      afterTool: [
        hook(
          "hang",
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
          { timeoutMs: 5000 },
        ),
      ],
    }),
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const diagnostics = await service.afterTool(
    { session, tool: beforeEvent().tool, outcome: outcome("ok") },
    { signal: controller.signal },
  );
  expect(diagnostics[0]?.status).toBe("cancelled");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
  await service.dispose();
});

it("never spawns for a pre-aborted signal and marks readonly mode as visibly skipped", async () => {
  const marker = join(root, "spawned");
  const entry = hook(
    "mark",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`,
  );
  const controller = new AbortController();
  controller.abort();
  const aborting = createToolHookService(config({ beforeTool: [entry] }));
  const aborted = await aborting.beforeTool(beforeEvent(), {
    signal: controller.signal,
  });
  expect(aborted.allowed).toBe(false);
  expect(aborted.diagnostics[0]?.status).toBe("cancelled");
  await aborting.dispose();

  const readonly = createToolHookService(config({ beforeTool: [entry] }), {
    readonlyMode: true,
  });
  const skipped = await readonly.beforeTool(beforeEvent());
  // A readonly skip is not a denial: the ordinary readonly tool may proceed.
  expect(skipped.allowed).toBe(true);
  expect(skipped.denialReason).toBeUndefined();
  expect(skipped.diagnostics[0]).toMatchObject({ status: "skipped" });
  expect(skipped.diagnostics[0]?.reason).toContain("readonly");
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await readonly.dispose();
});

it("skips executable hooks when the per-call session permission is readonly", async () => {
  const marker = join(root, "spawned");
  const entry = hook(
    "mark",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`,
  );
  // Service constructed while permission was not readonly; the per-call
  // permission must still win and spawn nothing.
  const service = createToolHookService(config({ beforeTool: [entry] }));
  const result = await service.beforeTool({
    session: { ...session, permission: "readonly" },
    tool: beforeEvent().tool,
  });
  expect(result.allowed).toBe(true);
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]).toMatchObject({ status: "skipped" });
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });

  // A later call with a different permission actually runs the hook.
  const normal = await service.beforeTool(beforeEvent());
  expect(normal.allowed).toBe(true);
  expect(normal.diagnostics[0]).toMatchObject({ status: "ok" });
  expect(await readFile(marker, "utf8")).toBe("yes");
  await service.dispose();
});

it("runs hooks with the event workspace as cwd", async () => {
  const childDir = join(root, "child-worktree");
  await mkdir(childDir, { recursive: true });
  const seen = join(root, "cwd.txt");
  const service = createToolHookService(
    config({
      afterTool: [
        hook(
          "cwd",
          `require('node:fs').writeFileSync(${JSON.stringify(seen)},process.cwd())`,
        ),
      ],
    }),
  );
  await service.afterTool({
    session: { ...session, workspace: childDir },
    tool: beforeEvent().tool,
    outcome: outcome("ok"),
  });
  expect(await readFile(seen, "utf8")).toBe(await realpath(childDir));
  await service.dispose();
});

it("reports a bounded spawn failure for a missing executable", async () => {
  const service = createToolHookService(
    config({
      beforeTool: [
        hook("missing", "", {
          command: join(root, "does-not-exist", "hook-binary"),
        }),
      ],
    }),
  );
  const result = await service.beforeTool(beforeEvent());
  expect(result.allowed).toBe(false);
  expect(result.diagnostics[0]).toMatchObject({
    status: "failed",
    reason: "Hook process could not be started.",
  });
  await service.dispose();
});

it("joins a spawned descendant before reporting the hook settled", async () => {
  const pidFile = join(root, "descendant.pid");
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "process.exit(0);",
  ].join(" ");
  const service = createToolHookService(
    config({ afterTool: [hook("tree", script)] }),
  );
  const diagnostics = await service.afterTool({
    session,
    tool: beforeEvent().tool,
    outcome: outcome("ok"),
  });
  expect(diagnostics[0]?.status).toBe("ok");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  let alive = true;
  for (let attempt = 0; attempt < 80 && alive; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
    }
  }
  // The invocation must not have reported success before the tree was joined.
  expect(alive).toBe(false);
  await service.dispose();
});

it("exports a Zod diagnostic schema matching the public diagnostic type", async () => {
  const service = createToolHookService(
    config({
      afterTool: [
        hook("schema", "process.stdout.write('ignored')", {
          maxOutputBytes: 256,
        }),
      ],
    }),
  );
  const diagnostics = await service.afterTool({
    session,
    tool: beforeEvent().tool,
    outcome: outcome("ok"),
  });
  for (const diagnostic of diagnostics) {
    expect(toolHookDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
  }
  expect(
    toolHookDiagnosticSchema.safeParse({
      hook: "afterTool",
      id: "x",
      status: "ok",
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
      credential: "leak",
    }).success,
  ).toBe(false);
  await service.dispose();
});

it("filters by tool name and runs matching hooks sequentially in configuration order", async () => {
  const log = join(root, "order.log");
  const write = (id: string) =>
    hook(
      id,
      `require('node:fs').appendFileSync(${JSON.stringify(log)},'${id}\\n')`,
    );
  const service = createToolHookService(
    config({
      beforeTool: [write("first"), write("second")],
      afterTool: [write("third")],
    }),
  );
  const result = await service.beforeTool(beforeEvent("read_file"));
  expect(result.allowed).toBe(true);
  expect(result.diagnostics.map((item) => item.id)).toEqual([
    "first",
    "second",
  ]);
  await service.afterTool({
    session,
    tool: beforeEvent("read_file").tool,
    outcome: outcome("ok"),
  });
  expect(await readFile(log, "utf8")).toBe("first\nsecond\nthird\n");

  const filtered = createToolHookService(
    config({
      beforeTool: [
        hook("only-write", `process.stdout.write('{"decision":"deny"}')`, {
          tools: ["write_file"],
        }),
      ],
    }),
  );
  const unmatched = await filtered.beforeTool(beforeEvent("read_file"));
  expect(unmatched.allowed).toBe(true);
  expect(unmatched.diagnostics).toEqual([]);
  const matched = await filtered.beforeTool(beforeEvent("write_file"));
  expect(matched.allowed).toBe(false);
  await filtered.dispose();
  await service.dispose();
});

it("does not forward provider credentials or arbitrary host variables", async () => {
  const envFile = join(root, "env.json");
  process.env.FORGE_HOOK_TEST_SECRET = "super-secret-value";
  try {
    const service = createToolHookService(
      config({
        afterTool: [
          hook(
            "env",
            `require('node:fs').writeFileSync(${JSON.stringify(envFile)},JSON.stringify(Object.keys(process.env)))`,
          ),
        ],
      }),
    );
    await service.afterTool({
      session,
      tool: beforeEvent().tool,
      outcome: outcome("ok"),
    });
    const keys: string[] = JSON.parse(await readFile(envFile, "utf8"));
    expect(keys).not.toContain("FORGE_HOOK_TEST_SECRET");
    expect(
      keys.filter((key) => /API_KEY|SECRET|TOKEN|PASSWORD/i.test(key)),
    ).toEqual([]);
    expect(
      keys.every((key) =>
        ["PATH", "TMPDIR", "SYSTEMROOT", "PWD", "SHLVL", "_"].includes(key),
      ),
    ).toBe(true);
    await service.dispose();
  } finally {
    process.env.FORGE_HOOK_TEST_SECRET = undefined;
  }
});

it("keeps runEnd outcome separate from goal validation", async () => {
  const seen = join(root, "run.json");
  const service = createToolHookService(
    config({
      runEnd: [
        hook(
          "run-end",
          `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(seen)},s))`,
        ),
      ],
    }),
  );
  const diagnostics = await service.runEnd({
    session,
    run: { status: "completed", toolCalls: 3, steps: 2 },
  });
  expect(diagnostics[0]).toMatchObject({ hook: "runEnd", status: "ok" });
  const payload = JSON.parse(await readFile(seen, "utf8"));
  expect(payload.run).toEqual({ status: "completed", toolCalls: 3, steps: 2 });
  expect(payload).not.toHaveProperty("validated");
  expect(payload).not.toHaveProperty("goal");
  await service.dispose();
});

it("rejects malformed or ambiguous host configuration before spawning anything", () => {
  expect(createToolHookService({}).configured).toBe(false);
  expect(() =>
    createToolHookService({
      beforeTool: [{ id: "a", command: "" }],
      afterTool: [],
      toolError: [],
      runEnd: [],
    }),
  ).toThrow(/invalid/i);
  expect(() =>
    createToolHookService({
      beforeTool: [hook("dup", "")],
      afterTool: [hook("dup", "")],
      toolError: [],
      runEnd: [],
    }),
  ).toThrow(/invalid/i);
  expect(() =>
    createToolHookService({
      beforeTool: [],
      afterTool: [],
      toolError: [],
      runEnd: [hook("re", "", { tools: ["read_file"] })],
    }),
  ).toThrow(/invalid/i);
  expect(() =>
    createToolHookService({
      beforeTool: [hook("big", "", { timeoutMs: 60_000 })],
      afterTool: [],
      toolError: [],
      runEnd: [],
    }),
  ).toThrow(/invalid/i);
});

it("bounds the argument and outcome preview text placed on stdin", async () => {
  const seen = join(root, "bounded.json");
  const service = createToolHookService(
    config({
      afterTool: [
        hook(
          "bounded",
          `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(seen)},s))`,
        ),
      ],
    }),
  );
  await service.afterTool({
    session,
    tool: {
      name: "read_file",
      callId: "call-2",
      arguments: "a".repeat(100_000),
    },
    outcome: outcome("b".repeat(100_000)),
  });
  const payload = JSON.parse(await readFile(seen, "utf8"));
  expect(payload.tool.argumentsTruncated).toBe(true);
  expect(payload.tool.arguments.length).toBeLessThan(20_000);
  expect(payload.outcome.previewTruncated).toBe(true);
  expect(payload.outcome.contentPreview.length).toBeLessThan(5_000);
  expect(payload.outcome.contentBytes).toBe(100_000);
  await service.dispose();
});
