import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { mcpToolName, parseMcpToolName } from "../../src/mcp/names";
import { StdioMcpConnection } from "../../src/mcp/protocol";
import { createMcpService } from "../../src/mcp/registry";
import type { ToolContext } from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import { parseSessionId } from "../../src/shared/schemas";
import { createMcpToolRegistry } from "../../src/tools/mcp";

const serverPath = fileURLToPath(
  new URL("../../examples/mcp/echo-server.mjs", import.meta.url),
);

let home: string;
let service: Awaited<ReturnType<typeof createMcpService>>;

const ctx = (
  permission: "readonly" | "workspace" | "unrestricted",
  approve: (description: string) => Promise<boolean> = async () => true,
): ToolContext => ({
  sessionId: parseSessionId("00000000-0000-4000-8000-000000000002"),
  toolCallId: "mcp-test",
  workspace: ".",
  permission,
  signal: new AbortController().signal,
  approve: async (request) => approve(request.description),
  onEvent: () => undefined,
});

const call = (
  registry: Awaited<ReturnType<typeof createMcpToolRegistry>>,
  name: string,
  args: unknown,
) =>
  registry.execute(
    {
      id: "call",
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    ctx("unrestricted"),
  );

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "forge-mcp-"));
  service = await createMcpService({ home });
});

afterAll(async () => {
  await service?.dispose().catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe("names", () => {
  it("round-trips namespaced tool names collision-free", () => {
    const name = mcpToolName("echo", "some_tool.v2");
    expect(name).toMatch(/^mcp__echo__some-tool.v2-/);
    expect(parseMcpToolName(name)).toEqual({
      server: "echo",
      tool: name.slice("mcp__echo__".length),
    });
    expect(parseMcpToolName("mcp__echo__a__b")).toBeUndefined();
    expect(parseMcpToolName("run_command")).toBeUndefined();
  });
  it("hashes long segments without collisions", () => {
    const long = mcpToolName("x".repeat(64), "y".repeat(200));
    expect(long.length).toBeLessThanOrEqual(64);
    const parsed = parseMcpToolName(long);
    expect(parsed?.server.startsWith("x")).toBe(true);
    expect(parsed?.tool.startsWith("y")).toBe(true);
    expect(parseMcpToolName(mcpToolName("a", "b"))).toEqual({
      server: "a",
      tool: "b",
    });
  });
});

describe("registration and storage", () => {
  it("persists a registered server and lists a sanitized catalog", async () => {
    const record = await service.register({
      id: "echo",
      label: "Echo example",
      command: process.execPath,
      args: [serverPath],
      envNames: { FORGE_MCP_VISIBLE_VALUE: "FORGE_HOST_VISIBLE" },
      env: { FORGE_MCP_PRIVATE: "private-value" },
    });
    expect(record.enabled).toBe(false);
    const listed = await service.list();
    expect(listed).toHaveLength(1);
    const stored = JSON.parse(
      await readFile(join(home, "mcp", "servers.json"), "utf8"),
    );
    expect(stored.version).toBe(1);
    const permissions = await stat(join(home, "mcp", "servers.json"));
    expect(permissions.mode & 0o077).toBe(0);
    // Sanitized records never leak private env values.
    expect(JSON.stringify(listed)).not.toContain("private-value");
  });
  it("rejects credential-looking host variable forwarding", async () => {
    await expect(
      service.register({
        id: "bad",
        label: "Bad",
        command: process.execPath,
        args: [serverPath],
        envNames: { X: "FORGE_API_KEY" },
      }),
    ).rejects.toBeInstanceOf(Error);
  });
  it("register launches no process", async () => {
    await expect(service.health("echo")).resolves.toMatchObject({
      enabled: false,
      connected: false,
    });
  });
});

describe("live stdio protocol", () => {
  let registry: Awaited<ReturnType<typeof createMcpToolRegistry>>;
  beforeAll(async () => {
    await service.setEnabled("echo", true);
    registry = await createMcpToolRegistry(service);
  });
  it("connects, negotiates and reports health", async () => {
    const health = await service.health("echo");
    expect(health.connected).toBe(true);
    expect(health.negotiatedProtocolVersion).toBe("2025-11-25");
  });
  it("lists real tools across cursor pagination with real schemas", async () => {
    const output = await call(registry, "mcp_list_tools", { server: "echo" });
    expect(output.isError).toBe(false);
    const parsed = JSON.parse(output.content);
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "echo",
      "secret_report",
    ]);
    expect(parsed.tools[0].tool).toBe("mcp__echo__echo");
    expect(parsed.tools[0].inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    });
  });
  it("calls a real tool through the full stdio round trip", async () => {
    const output = await call(registry, "mcp_call_tool", {
      toolName: "mcp__echo__echo",
      arguments: { text: "hello world" },
    });
    expect(output.isError).toBe(false);
    expect(JSON.parse(output.content).text).toBe("hello world");
  });
  it("only forwards explicitly mapped host values, never inherited secrets", async () => {
    process.env.FORGE_SECRET_MARKER = "sk-live-secret";
    try {
      const output = await call(registry, "mcp_call_tool", {
        toolName: "mcp__echo__secret_report",
      });
      const text = JSON.parse(output.content).text as string;
      expect(text).not.toContain("sk-live-secret");
      expect(text).not.toContain("FORGE_SECRET_MARKER");
      expect(text).toBe("absent");
    } finally {
      Reflect.deleteProperty(process.env, "FORGE_SECRET_MARKER");
    }
  });
  it("returns structured errors for unknown tools and servers", async () => {
    expect(
      (await call(registry, "mcp_call_tool", { toolName: "run_command" }))
        .isError,
    ).toBe(true);
    expect(
      (await call(registry, "mcp_list_tools", { server: "missing" })).isError,
    ).toBe(true);
  });
});

describe("permission model", () => {
  let registry: Awaited<ReturnType<typeof createMcpToolRegistry>>;
  beforeAll(async () => {
    registry = await createMcpToolRegistry(service);
  });
  it("denies both tools in readonly mode", async () => {
    const readonly = ctx("readonly");
    const execute = (name: string, args: unknown) =>
      registry.execute(
        {
          id: "call",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
        readonly,
      );
    const listed = await execute("mcp_list_tools", { server: "echo" });
    expect(listed.isError).toBe(true);
    const called = await execute("mcp_call_tool", {
      toolName: "mcp__echo__echo",
    });
    expect(called.isError).toBe(true);
  });
  it("requires a fresh per-call approval in workspace mode", async () => {
    const approvals: string[] = [];
    const approveCtx = (allow: boolean) =>
      ctx("workspace", async (description) => {
        approvals.push(description);
        return allow;
      });
    const execute = (context: ToolContext, name: string, args: unknown) =>
      registry.execute(
        {
          id: "call",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
        context,
      );
    const denied = await execute(approveCtx(false), "mcp_call_tool", {
      toolName: "mcp__echo__echo",
      arguments: { text: "nope" },
    });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content).error).toContain("denied");
    const allowed = await execute(approveCtx(true), "mcp_call_tool", {
      toolName: "mcp__echo__echo",
      arguments: { text: "yes" },
    });
    expect(allowed.isError).toBe(false);
    expect(JSON.parse(allowed.content).text).toBe("yes");
    // Each call requested its own approval, showing the registered command
    // (never environment values).
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toContain("Call MCP tool");
    expect(approvals[0]).toContain(process.execPath);
  });
  it("redacts known secrets from tool results", async () => {
    const secret = "super-secret-value-1234";
    const redacting = await createMcpToolRegistry(service, {
      redactValues: [secret],
    });
    const output = await call(redacting, "mcp_call_tool", {
      toolName: "mcp__echo__echo",
      arguments: { text: `prefix ${secret} suffix` },
    });
    expect(output.content).not.toContain(secret);
    expect(output.content).toContain("[REDACTED]");
  });
});

describe("connection failure handling", () => {
  it("reports spawn failures as structured errors", async () => {
    const connection = new StdioMcpConnection({
      command: "/nonexistent/forge-mcp-fixture",
      args: [],
      env: {},
      requestTimeoutMs: 2000,
    });
    await expect(connection.connect()).rejects.toBeInstanceOf(ForgeError);
    await connection.close();
  });
});

// Two independent `McpService` values model the root run and a child run, each
// with its own connection pool but sharing the authoritative private catalog
// under FORGE_HOME. A disable, removal or definition change performed through
// one must be observed by the other before it launches or uses a server.
describe("catalog coordination across services", () => {
  let sharedHome: string;
  let first: Awaited<ReturnType<typeof createMcpService>>;
  let second: Awaited<ReturnType<typeof createMcpService>>;

  const descriptor = {
    id: "echo",
    label: "Echo",
    command: process.execPath,
    args: [serverPath],
  } as const;

  beforeEach(async () => {
    sharedHome = await mkdtemp(join(tmpdir(), "forge-mcp-shared-"));
    first = await createMcpService({ home: sharedHome });
    second = await createMcpService({ home: sharedHome });
  });

  afterEach(async () => {
    await first?.dispose().catch(() => undefined);
    await second?.dispose().catch(() => undefined);
    await rm(sharedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  it("observes a registration made by the other service", async () => {
    await first.register(descriptor);
    const listed = await second.list();
    expect(listed.map((entry) => entry.id)).toEqual(["echo"]);
  });

  it("rejects a duplicate id registered by the other service", async () => {
    await first.register(descriptor);
    await expect(second.register(descriptor)).rejects.toThrow(/already exists/);
  });
});
