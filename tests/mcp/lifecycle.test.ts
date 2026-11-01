import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import {
  chmod,
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createMcpService } from "../../src/mcp/registry";
import { JsonRpcConnection } from "../../src/mcp/rpc";
import type { ModelProvider } from "../../src/shared/contracts";
import { mcpServerConfigSchema } from "../../src/shared/mcp";
import { toolResultSchema } from "../../src/shared/schemas";
import * as io from "../../src/store/io";
import { fileLock } from "../../src/store/lock";
import * as locks from "../../src/store/lock";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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

it("rejects connections waiting on the catalog lock when the service is disposed", async () => {
  const service = await createMcpService({ home: stateDir });
  const unlock = await fileLock(join(stateDir, "mcp/servers.lock"));
  const work = service.listTools("echo").then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await service.dispose();
    await unlock();
    expect(await work).toMatchObject({ code: "cancelled" });
    await expect(service.listTools("echo")).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(children()).toHaveLength(0);
  } finally {
    await unlock();
    await service.dispose();
  }
});

it("reuses live calls and discovery without catalog reads or file locks", async () => {
  const service = await createMcpService({ home: stateDir });
  const uncached = await createMcpService({ home: stateDir });
  try {
    const tools = await service.listTools("echo");
    const result = await service.callTool("echo", "echo", { text: "cached" });
    const read = vi.spyOn(io, "readJson");
    const lock = vi.spyOn(locks, "fileLock");
    const unlock = await fileLock(join(stateDir, "mcp/servers.lock"));
    lock.mockClear();
    try {
      expect(await service.listTools("echo")).toEqual(tools);
      expect(
        await service.callTool("echo", "echo", { text: "cached" }),
      ).toEqual(result);
      expect(read).not.toHaveBeenCalled();
      expect(lock).not.toHaveBeenCalled();
    } finally {
      await unlock();
    }
    expect(await uncached.listTools("echo")).toEqual(tools);
    expect(await uncached.callTool("echo", "echo", { text: "cached" })).toEqual(
      result,
    );
  } finally {
    await service.dispose();
    await uncached.dispose();
  }
});

it.each([
  "in-place",
  "replacement",
  "missing",
  "invalid",
  "permissions",
  "symlink",
] as const)(
  "invalidates the cached catalog on %s changes and matches an uncached reader",
  async (change) => {
    const service = await createMcpService({ home: stateDir });
    const uncached = await createMcpService({ home: stateDir });
    const path = join(stateDir, "mcp/servers.json");
    try {
      await service.listTools("echo");
      const before = await stat(path);
      const original = await readFile(path, "utf8");
      const updated = original.replace('"Echo"', '"echo"');
      if (change === "replacement") {
        await writeFile(`${path}.next`, updated, { mode: 0o600 });
        await utimes(`${path}.next`, before.atime, before.mtime);
        await rename(`${path}.next`, path);
      } else if (change === "in-place") {
        await writeFile(path, updated);
        await utimes(path, before.atime, before.mtime);
      } else if (change === "missing") await rm(path);
      else if (change === "permissions") await chmod(path, 0o644);
      else if (change === "symlink") {
        await rename(path, `${path}.original`);
        await symlink(`${path}.original`, path);
      } else await writeFile(path, "invalid");
      const read = vi.spyOn(io, "readJson");
      const actual = await Promise.allSettled([service.list()]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(actual).toEqual(await Promise.allSettled([uncached.list()]));
      if (change !== "in-place" && change !== "replacement") {
        await expect(service.listTools("echo")).rejects.toMatchObject({
          code: change === "missing" ? "tool" : "storage",
        });
      } else {
        expect(actual).toMatchObject([
          { status: "fulfilled", value: [{ label: "echo" }] },
        ]);
        read.mockClear();
        await service.listTools("echo");
        expect(read).not.toHaveBeenCalled();
      }
    } finally {
      await service.dispose();
      await uncached.dispose();
    }
  },
);

it("invalidates cached absence and local catalog mutations", async () => {
  const home = join(directory, "empty");
  const service = await createMcpService({ home });
  const other = await createMcpService({ home });
  try {
    expect(await service.list()).toEqual([]);
    await other.register({
      id: "echo",
      label: "Echo",
      command: process.execPath,
      args: [serverPath],
      enabled: true,
    });
    expect(await service.list()).toEqual(await other.list());
    await service.setEnabled("echo", false);
    expect(await service.list()).toEqual(await other.list());
    await service.remove("echo");
    expect(await service.list()).toEqual([]);
  } finally {
    await service.dispose();
    await other.dispose();
  }
});

it("keeps a cache hit coherent when a mutation finishes during its stamp check", async () => {
  const service = await createMcpService({ home: stateDir });
  const other = await createMcpService({ home: stateDir });
  const inspecting = deferred();
  const finish = deferred();
  try {
    const before = await service.list();
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementationOnce(async (path) => {
      const info = await lstat(path);
      inspecting.resolve();
      await finish.promise;
      return info;
    });
    const reading = service.list();
    await inspecting.promise;
    await service.setEnabled("echo", false);
    finish.resolve();
    expect(await reading).toEqual(before);
    expect(await service.list()).toEqual(await other.list());
  } finally {
    finish.resolve();
    await service.dispose();
    await other.dispose();
  }
});

it("releases the catalog lock before closing a replaced connection", async () => {
  const service = await createMcpService({ home: stateDir });
  const close = JsonRpcConnection.prototype.close;
  try {
    await service.listTools("echo");
    const path = join(stateDir, "mcp/servers.json");
    const catalog = JSON.parse(await readFile(path, "utf8"));
    catalog.servers[0].env = { FORGE_MCP_VISIBLE_VALUE: "fixture" };
    await io.atomicJson(path, catalog, 1 << 20);
    const lockFree = vi.fn();
    vi.spyOn(JsonRpcConnection.prototype, "close").mockImplementation(
      async function (this: JsonRpcConnection) {
        const unlock = await fileLock(join(stateDir, "mcp/servers.lock"));
        await unlock();
        lockFree();
        await close.call(this);
      },
    );
    expect(await service.callTool("echo", "secret_report", {})).toMatchObject({
      text: "visible",
    });
    expect(lockFree).toHaveBeenCalledOnce();
  } finally {
    vi.mocked(JsonRpcConnection.prototype.close).mockRestore();
    await service.dispose();
  }
});

it("shares one MCP process across workspaces in the same harness", async () => {
  const otherWorkspace = join(directory, "other-workspace");
  await mkdir(otherWorkspace);
  const first = await session();
  const second = await harness.createSession({ workspace: otherWorkspace });
  expect((await run(first.id)).status).toBe("completed");
  expect((await run(second.id)).status).toBe("completed");
  expect(children()).toHaveLength(1);
});

it("does not spawn after disposal races an authoritative catalog read", async () => {
  const service = await createMcpService({ home: stateDir });
  const reading = deferred();
  const finish = deferred();
  const read = io.readJson;
  vi.spyOn(io, "readJson").mockImplementation(async (...args) => {
    const value = await read(...args);
    if (args[0] === join(stateDir, "mcp/servers.json")) {
      reading.resolve();
      await finish.promise;
    }
    return value;
  });
  const work = service.listTools("echo").then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await reading.promise;
    await service.dispose();
    finish.resolve();
    expect(await work).toMatchObject({ code: "cancelled" });
    expect(children()).toHaveLength(0);
  } finally {
    finish.resolve();
    await work;
    await service.dispose();
  }
});

it("joins in-flight MCP management calls during harness disposal", async () => {
  const reading = deferred();
  const finish = deferred();
  const read = io.readJson;
  vi.spyOn(io, "readJson").mockImplementation(async (...args) => {
    const value = await read(...args);
    if (args[0] === join(stateDir, "mcp/servers.json")) {
      reading.resolve();
      await finish.promise;
    }
    return value;
  });
  const work = harness.listMcpServers();
  await reading.promise;
  let closed = false;
  const closing = harness.dispose().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
  } finally {
    finish.resolve();
    await work;
    await closing;
  }
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
