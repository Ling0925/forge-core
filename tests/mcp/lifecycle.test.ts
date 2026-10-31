import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createMcpService } from "../../src/mcp/registry";
import { JsonRpcConnection } from "../../src/mcp/rpc";
import type { ModelProvider } from "../../src/shared/contracts";
import { mcpServerConfigSchema } from "../../src/shared/mcp";
import { toolResultSchema } from "../../src/shared/schemas";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const serverPath = fileURLToPath(
  new URL("../../examples/mcp/echo-server.mjs", import.meta.url),
);
let directory: string;
let workspace: string;
let stateDir: string;
let harness: Awaited<ReturnType<typeof createHarness>>;
const approve = vi.fn(async () => true);

const request = (name: string, args: object) =>
  ({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: name,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  }) as const;

const provider: ModelProvider = {
  listModels: async () => ["fixture"],
  complete: async (messages) => {
    const current = messages.slice(
      messages.findLastIndex((message) => message.role === "user"),
    );
    const latest = current.findLast((message) => message.role === "tool");
    if (!latest || latest.role !== "tool")
      return { message: request("mcp_list_tools", { server: "echo" }) };
    const output = toolResultSchema.parse(JSON.parse(latest.content));
    expect(output.isError).toBe(false);
    if (latest.tool_call_id === "mcp_list_tools")
      return {
        message: request("mcp_call_tool", {
          toolName: "mcp__echo__echo",
          arguments_json: '{"text":"shared connection"}',
        }),
      };
    expect(JSON.parse(output.content)).toEqual({
      text: "shared connection",
      isError: false,
      truncated: false,
    });
    return { message: { role: "assistant", content: "Completed" } };
  },
};

const children = () =>
  vi.mocked(spawn).mock.results.flatMap((result, index) => {
    const args = vi.mocked(spawn).mock.calls[index];
    return args?.[0] === process.execPath &&
      args[1]?.includes(serverPath) &&
      result.type === "return"
      ? [result.value]
      : [];
  });

const session = () =>
  harness.createSession({ workspace, title: "MCP lifecycle" });
const run = (
  sessionId: Awaited<ReturnType<typeof session>>["id"],
  signal = new AbortController().signal,
) =>
  harness.run(
    { sessionId, prompt: "Use the echo tool", permission: "workspace" },
    () => undefined,
    approve,
    signal,
  );

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-mcp-lifecycle-"));
  workspace = join(directory, "workspace");
  stateDir = join(directory, "state");
  await mkdir(workspace);
  harness = await createHarness({ stateDir, providerFactory: () => provider });
  await harness.updateSettings({
    settings: { baseUrl: "http://127.0.0.1:1/v1", model: "fixture" },
  });
  await harness.registerMcpServer({
    id: "echo",
    label: "Echo",
    command: process.execPath,
    args: [serverPath],
    enabled: true,
  });
});

afterEach(async () => {
  await harness.dispose();
  await rm(directory, { recursive: true, force: true });
});

it("reuses one process across management and consecutive turns, then closes on harness disposal", async () => {
  const s = await session();
  expect(await harness.getMcpHealth("echo")).toMatchObject({ connected: true });
  expect((await run(s.id)).status).toBe("completed");
  expect((await run(s.id)).status).toBe("completed");
  expect(approve).toHaveBeenCalledTimes(4);
  expect(children()).toHaveLength(1);
  const child = children()[0];
  assert(child);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  const uncached = await createMcpService({ home: stateDir });
  try {
    expect(
      await uncached.callTool("echo", "echo", { text: "shared connection" }),
    ).toEqual({
      text: "shared connection",
      isError: false,
      truncated: false,
    });
  } finally {
    await uncached.dispose();
  }
  await harness.dispose();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it("reconnects once for a changed stored definition even with concurrent turns", async () => {
  await harness.getMcpHealth("echo");
  const child = children()[0];
  assert(child);
  const path = join(stateDir, "mcp", "servers.json");
  const catalog = JSON.parse(await readFile(path, "utf8"));
  const config = mcpServerConfigSchema.parse(catalog.servers[0]);
  await writeFile(
    path,
    JSON.stringify({
      ...catalog,
      servers: [{ ...config, env: { MCP_FIXTURE_VALUE: "updated" } }],
    }),
  );
  const first = await session();
  const second = await session();
  const results = await Promise.all([run(first.id), run(second.id)]);
  expect(results.map((result) => result.status)).toEqual([
    "completed",
    "completed",
  ]);
  expect(children()).toHaveLength(2);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it.each(["disable", "remove"] as const)(
  "%s closes the live connection before returning",
  async (action) => {
    const s = await session();
    await run(s.id);
    const child = children()[0];
    assert(child);
    if (action === "disable") await harness.setMcpEnabled("echo", false);
    else await harness.removeMcpServer("echo");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(await harness.getMcpHealth("echo")).toMatchObject({
      connected: false,
    });
    expect(children()).toHaveLength(1);
  },
);

it("reconnects once after a dead connection for concurrent next turns", async () => {
  await harness.getMcpHealth("echo");
  const child = children()[0];
  assert(child);
  await new Promise<void>((resolve) => {
    child.once("close", resolve);
    child.kill();
  });
  const first = await session();
  const second = await session();
  expect(
    (await Promise.all([run(first.id), run(second.id)])).map(
      (result) => result.status,
    ),
  ).toEqual(["completed", "completed"]);
  expect(children()).toHaveLength(2);
});

it("aborting one turn leaves the other turn and the shared process alive", async () => {
  await harness.getMcpHealth("echo");
  const child = children()[0];
  assert(child?.stdout);
  const first = await session();
  const second = await session();
  const requests = vi.spyOn(JsonRpcConnection.prototype, "request");
  const controller = new AbortController();
  child.stdout.pause();
  const cancelled = run(first.id, controller.signal);
  await vi.waitFor(() =>
    expect(
      requests.mock.calls.filter(([method]) => method === "tools/list"),
    ).toHaveLength(1),
  );
  const continuing = run(second.id);
  await vi.waitFor(() =>
    expect(
      requests.mock.calls.filter(([method]) => method === "tools/list"),
    ).toHaveLength(2),
  );
  controller.abort();
  expect((await cancelled).status).toBe("cancelled");
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  child.stdout.resume();
  expect((await continuing).status).toBe("completed");
  expect((await run(second.id)).status).toBe("completed");
  expect(children()).toHaveLength(1);
});

it("keeps shared initialization alive when the first turn aborts", async () => {
  const first = await session();
  const second = await session();
  const request = JsonRpcConnection.prototype.request;
  vi.spyOn(JsonRpcConnection.prototype, "request").mockImplementation(function (
    this: JsonRpcConnection,
    method,
    params,
    options,
  ) {
    if (method === "initialize") {
      const child = children()[0];
      assert(child?.stdout);
      child.stdout.pause();
    }
    return request.call(this, method, params, options);
  });
  const connects = vi.spyOn(JsonRpcConnection.prototype, "connect");
  const controller = new AbortController();
  const cancelled = run(first.id, controller.signal);
  await vi.waitFor(() => expect(connects).toHaveBeenCalledTimes(1));
  const continuing = run(second.id);
  await vi.waitFor(() => expect(connects).toHaveBeenCalledTimes(2));
  controller.abort();
  expect((await cancelled).status).toBe("cancelled");
  const child = children()[0];
  assert(child?.stdout);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  child.stdout.resume();
  expect((await continuing).status).toBe("completed");
  expect(children()).toHaveLength(1);
});
