import { expect, it, vi } from "vitest";
import { z } from "zod";
import { mcpToolName } from "../../src/mcp/names";
import type { ToolContext } from "../../src/shared/contracts";
import type {
  McpServerRecord,
  McpService,
  McpToolInfo,
} from "../../src/shared/mcp";
import { parseSessionId, toolResultSchema } from "../../src/shared/schemas";
import { createMcpToolRegistry } from "../../src/tools/mcp";

const server: McpServerRecord = {
  id: "fixture",
  label: "Fixture",
  command: "private-command",
  args: ["private-argument"],
  enabled: true,
  requestTimeoutMs: 1000,
  envNameCount: 0,
  hasPrivateEnv: true,
  transport: "stdio",
  headerCount: 0,
  hasPrivateHeaders: false,
};
const tool: McpToolInfo = {
  name: "read_item",
  title: "Read item",
  description: "Reads one item",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  outputSchema: { type: "object", properties: { value: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const context: ToolContext = {
  sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
  toolCallId: "discovery",
  workspace: ".",
  permission: "unrestricted",
  signal: new AbortController().signal,
  onEvent: () => undefined,
  approve: async () => false,
};

function fixture() {
  const list = vi.fn(async (): Promise<readonly McpServerRecord[]> => [server]);
  const listTools = vi.fn(async (): Promise<readonly McpToolInfo[]> => [tool]);
  const callTool = vi.fn<McpService["callTool"]>(async () => ({
    text: "ok",
    isError: false,
    truncated: false,
  }));
  const service: McpService = {
    list,
    listTools,
    callTool,
    register: async () => server,
    setEnabled: async () => server,
    remove: async () => undefined,
    revoke: async () => undefined,
    dispose: async () => undefined,
    health: async () => ({
      id: server.id,
      enabled: true,
      connected: false,
      negotiatedProtocolVersion: undefined,
      lastError: undefined,
    }),
  };
  return { service, list, listTools, callTool };
}

function execute(
  registry: Awaited<ReturnType<typeof createMcpToolRegistry>>,
  name: string,
  args: object,
  ctx = context,
) {
  return registry.execute(
    {
      id: "discovery",
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    ctx,
  );
}

it("lists current server metadata without connection or approval, including readonly mode", async () => {
  const f = fixture();
  const registry = await createMcpToolRegistry(f.service);
  const approve = vi.fn(async () => false);
  expect(registry.definitions.map((entry) => entry.function.name)).toContain(
    "mcp_list_servers",
  );
  const output = await execute(
    registry,
    "mcp_list_servers",
    {},
    { ...context, permission: "readonly", approve },
  );
  expect(output.isError).toBe(false);
  expect(JSON.parse(output.content)).toEqual({
    servers: [
      { id: "fixture", label: "Fixture", enabled: true, transport: "stdio" },
    ],
  });
  expect(f.listTools).not.toHaveBeenCalled();
  expect(f.callTool).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
  expect(output.content).not.toContain("private");
});

it("sees registrations and enable changes made after the registry was created", async () => {
  const f = fixture();
  f.list.mockResolvedValue([]);
  const registry = await createMcpToolRegistry(f.service);
  f.list.mockResolvedValue([{ ...server, enabled: false }]);
  const disabled = await execute(registry, "mcp_list_tools", {
    server: "fixture",
  });
  expect(disabled.isError).toBe(true);
  expect(f.listTools).not.toHaveBeenCalled();
  f.list.mockResolvedValue([server]);
  expect(
    (await execute(registry, "mcp_list_tools", { server: "fixture" })).isError,
  ).toBe(false);
  expect(
    (
      await execute(registry, "mcp_call_tool", {
        toolName: mcpToolName(server.id, tool.name),
      })
    ).isError,
  ).toBe(false);
  f.list.mockResolvedValue([]);
  expect(
    (
      await execute(registry, "mcp_call_tool", {
        toolName: mcpToolName(server.id, tool.name),
      })
    ).isError,
  ).toBe(true);
  expect(f.callTool).toHaveBeenCalledTimes(1);
});

it("preserves tool schemas, titles and annotations and routes the original tool name", async () => {
  const f = fixture();
  const registry = await createMcpToolRegistry(f.service);
  const listed = await execute(registry, "mcp_list_tools", {
    server: "fixture",
  });
  expect(JSON.parse(listed.content)).toEqual({
    server: "fixture",
    tools: [{ ...tool, tool: mcpToolName(server.id, tool.name) }],
  });
  const output = await execute(registry, "mcp_call_tool", {
    toolName: mcpToolName(server.id, tool.name),
    arguments_json: '{"id":"42"}',
  });
  expect(output.isError).toBe(false);
  expect(f.callTool).toHaveBeenCalledWith(
    "fixture",
    "read_item",
    { id: "42" },
    expect.objectContaining({ signal: context.signal }),
  );
});

it("does not execute against a changed endpoint after workspace approval", async () => {
  const f = fixture();
  const registry = await createMcpToolRegistry(f.service);
  const output = await execute(
    registry,
    "mcp_call_tool",
    { toolName: "mcp__fixture__echo" },
    {
      ...context,
      permission: "workspace",
      approve: async () => {
        f.list.mockResolvedValue([{ ...server, command: "different-command" }]);
        return true;
      },
    },
  );
  expect(output.isError).toBe(true);
  expect(f.callTool).not.toHaveBeenCalled();
});

it("retains rich results in the model envelope and marks any omitted content", async () => {
  const f = fixture();
  const registry = await createMcpToolRegistry(f.service);
  const content = [
    {
      type: "resource_link",
      name: "Report",
      uri: "https://example.test/report",
    },
  ] as const;
  f.callTool.mockResolvedValue({
    text: "Report",
    content,
    structuredContent: { count: 2 },
    isError: false,
    truncated: false,
  });
  const output = await execute(registry, "mcp_call_tool", {
    toolName: "mcp__fixture__echo",
  });
  expect(JSON.parse(output.content)).toMatchObject({
    content,
    structuredContent: { count: 2 },
    truncated: false,
  });
  f.callTool.mockResolvedValue({
    text: "Report",
    content,
    structuredContent: { text: "x".repeat(70_000) },
    isError: false,
    truncated: false,
  });
  const large = await execute(registry, "mcp_call_tool", {
    toolName: "mcp__fixture__echo",
  });
  expect(Buffer.byteLength(large.content)).toBeLessThanOrEqual(64 * 1024);
  expect(JSON.parse(large.content)).toMatchObject({
    truncated: true,
    isError: true,
  });
});

it("rejects malformed and pre-cancelled server discovery without effects", async () => {
  const f = fixture();
  const registry = await createMcpToolRegistry(f.service);
  const invalid = await execute(registry, "mcp_list_servers", {
    unexpected: true,
  });
  expect(JSON.parse(invalid.content)).toMatchObject({ code: "invalid_input" });
  const cancelled = await execute(
    registry,
    "mcp_list_servers",
    {},
    { ...context, signal: AbortSignal.abort() },
  );
  expect(JSON.parse(cancelled.content)).toMatchObject({ code: "cancelled" });
  expect(f.listTools).not.toHaveBeenCalled();
  expect(f.callTool).not.toHaveBeenCalled();
});

it("pages complete schemas within the tool-result persistence limit", async () => {
  const f = fixture();
  const tools = Array.from({ length: 20 }, (_, index) => ({
    ...tool,
    name: `tool${index}`,
    description: "界".repeat(3000),
  }));
  f.listTools.mockResolvedValue(tools);
  const registry = await createMcpToolRegistry(f.service);
  const first = await execute(registry, "mcp_list_tools", {
    server: "fixture",
  });
  expect(first.isError).toBe(false);
  expect(toolResultSchema.safeParse(first).success).toBe(true);
  expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(128 * 1024);
  const pageSchema = z.object({
    tools: z.array(z.object({ name: z.string(), description: z.string() })),
    nextOffset: z.number().optional(),
  });
  const page = pageSchema.parse(JSON.parse(first.content));
  expect(page.nextOffset).toBeGreaterThan(0);
  const second = await execute(registry, "mcp_list_tools", {
    server: "fixture",
    offset: page.nextOffset,
  });
  const tail = pageSchema.parse(JSON.parse(second.content));
  expect(tail.nextOffset).toBeUndefined();
  expect([...page.tools, ...tail.tools].map((entry) => entry.name)).toEqual(
    tools.map((entry) => entry.name),
  );
  expect(
    [...page.tools, ...tail.tools].every(
      (entry) => entry.description === tools[0]?.description,
    ),
  ).toBe(true);
});
