import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedText, checkDiscovery } from "../mcp/bounds";
import { mcpToolName, parseMcpToolName } from "../mcp/names";
import type { McpService } from "../mcp/registry";
import {
  MCP_CALL_ARGUMENT_LIMIT,
  MCP_MAX_SERVERS,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_RESULT_LIMIT,
} from "../mcp/types";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type {
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../shared/schemas";
import { jsonValueSchema } from "../shared/schemas";

// Discriminated unions require the underlying object (before readonly and
// before any `.transform/.refine` wrapping), so build the shapes explicitly.
const serverId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
  .refine((value) => !value.includes("__"));

const listArgs = z
  .object({ tool: z.literal("mcp_list_tools"), server: serverId })
  .strict()
  .readonly();
const callArgs = z
  .object({
    tool: z.literal("mcp_call_tool"),
    toolName: z.string().min(1).max(64),
    arguments: z.record(z.unknown()).default({}),
  })
  .strict()
  .readonly();
const args = z.discriminatedUnion("tool", [
  listArgs.unwrap(),
  callArgs.unwrap(),
]);

const description =
  "MCP (Model Context Protocol) tools over user-registered stdio servers. " +
  "readonly permission denies both tools; workspace requires a fresh per-call " +
  "approval showing the registered server command; unrestricted runs " +
  "automatically against explicitly registered and enabled servers only. " +
  "Server environments are minimal and never inherit credentials.";

const definitions: readonly ToolDefinition[] = Object.freeze([
  {
    type: "function",
    function: {
      name: "mcp_list_tools",
      description: `${description} Lists a registered server's tools with their real input schemas (bounded discovery, lazy connect).`,
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", minLength: 1, maxLength: 32 },
        },
        required: ["server"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_call_tool",
      description: `${description} Calls an MCP tool by its namespaced name (mcp__<server>__<tool>) with a JSON object of at most 64 KiB; returns bounded sanitized text content.`,
      parameters: {
        type: "object",
        properties: {
          toolName: { type: "string", minLength: 1, maxLength: 64 },
          arguments: { type: "object", default: {} },
        },
        required: ["toolName"],
        additionalProperties: false,
      },
    },
  },
]);

const result = (value: JsonValue, isError = false): ToolResult => ({
  content: JSON.stringify(value) ?? "null",
  isError,
});

export interface McpToolOptions {
  readonly redactValues?: readonly string[];
}

export async function createMcpToolRegistry(
  service: McpService,
  options: McpToolOptions = {},
): Promise<LocalToolRegistry> {
  const routes = new Map<string, { server: string; tool: string }>();
  const catalog = await service.list();
  const servers = new Map(catalog.map((entry) => [entry.id, entry]));
  const clean = (text: string): string => {
    let output = text;
    for (const secret of options.redactValues ?? [])
      if (secret) output = output.split(secret).join("[REDACTED]");
    return output;
  };

  async function authorize(
    ctx: ToolContext,
    call: ToolCall,
    description: string,
  ): Promise<void> {
    if (ctx.signal.aborted)
      throw new ForgeError("cancelled", "Tool execution cancelled.");
    if (ctx.permission === "readonly")
      throw new ForgeError(
        "tool",
        "MCP tools are not available in readonly mode.",
      );
    if (ctx.permission === "unrestricted") return;
    // workspace: fresh per-call approval.
    const request = {
      id: randomUUID(),
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      toolName: call.function.name,
      description: clean(description),
    };
    ctx.onEvent({
      type: "approval_requested",
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      request,
    });
    const ok = await ctx.approve(request, ctx.signal);
    if (ctx.signal.aborted)
      throw new ForgeError("cancelled", "Tool execution cancelled.");
    if (!ok) throw new ForgeError("tool", "MCP tool call was denied.");
  }

  const registry: LocalToolRegistry = {
    definitions,
    async execute(call, ctx) {
      try {
        if (
          Buffer.byteLength(call.function.arguments, "utf8") >
          MCP_CALL_ARGUMENT_LIMIT
        )
          return result({ error: "invalid" }, true);
        const input = JSON.parse(call.function.arguments) as unknown;
        if (typeof input !== "object" || input === null || Array.isArray(input))
          return result({ error: "invalid" }, true);
        const object = input as Record<string, unknown>;
        if ("tool" in object) return result({ error: "invalid" }, true);
        const parsed = args.parse({ ...object, tool: call.function.name });
        if (parsed.tool === "mcp_list_tools") {
          const server = servers.get(parsed.server);
          if (!server) return result({ error: "unknown server" }, true);
          await authorize(
            ctx,
            call,
            `List tools of MCP server "${server.id}" (${server.command} ${server.args.join(" ")}).`,
          );
          const tools = await service.listTools(parsed.server, {
            signal: ctx.signal,
            redactValues: options.redactValues ?? [],
          });
          const payload = jsonValueSchema.parse({
            server: server.id,
            tools: tools.map((tool) => ({
              tool: mcpToolName(server.id, tool.name),
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          });
          checkDiscovery(payload);
          const nextRoutes = new Map(
            [...routes].filter(([, route]) => route.server !== server.id),
          );
          for (const tool of tools) {
            const name = mcpToolName(server.id, tool.name);
            const previous = nextRoutes.get(name);
            if (
              previous &&
              (previous.server !== server.id || previous.tool !== tool.name)
            )
              throw new ForgeError("tool", "MCP tool name collision.");
            nextRoutes.set(name, { server: server.id, tool: tool.name });
          }
          if (nextRoutes.size > MCP_MAX_SERVERS * MCP_MAX_TOOLS_PER_SERVER)
            throw new ForgeError("tool", "MCP alias limit exceeded.");
          routes.clear();
          for (const [name, route] of nextRoutes) routes.set(name, route);
          return result(payload);
        }

        const route =
          routes.get(parsed.toolName) ?? parseMcpToolName(parsed.toolName);
        if (!route) return result({ error: "unknown tool name" }, true);
        const server = servers.get(route.server);
        if (!server) return result({ error: "unknown server" }, true);
        if (!server.enabled)
          return result({ error: "server is disabled" }, true);
        const encoded = JSON.stringify(parsed.arguments);
        if (Buffer.byteLength(encoded, "utf8") > MCP_CALL_ARGUMENT_LIMIT)
          return result({ error: "arguments exceed 64 KiB" }, true);
        await authorize(
          ctx,
          call,
          `Call MCP tool "${route.tool}" on server "${server.id}" (${server.command} ${server.args.join(" ")}).`,
        );
        const outcome = await service.callTool(
          route.server,
          route.tool,
          parsed.arguments,
          {
            signal: ctx.signal,
            redactValues: options.redactValues ?? [],
          },
        );
        // The native JSON envelope also fits the byte budget, including JSON
        // escaping. Never slice serialized JSON or omit the truncation signal.
        let payload = { ...outcome };
        let limit = MCP_RESULT_LIMIT;
        while (
          Buffer.byteLength(JSON.stringify(payload), "utf8") > MCP_RESULT_LIMIT
        ) {
          const excess =
            Buffer.byteLength(JSON.stringify(payload), "utf8") -
            MCP_RESULT_LIMIT;
          limit = Math.max(128, limit - Math.max(excess, 64));
          payload = { ...boundedText(outcome.text, limit), isError: true };
        }
        return result(payload, payload.isError);
      } catch (error) {
        if (error instanceof ForgeError)
          return result({ error: clean(error.message) }, true);
        if (error instanceof z.ZodError)
          return result({ error: "invalid" }, true);
        return result({ error: "MCP call failed." }, true);
      }
    },
    async dispose() {
      await service.dispose();
    },
  };
  return registry;
}
