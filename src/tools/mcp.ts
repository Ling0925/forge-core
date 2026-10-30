import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedText } from "../mcp/bounds";
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
import type { McpServerRecord } from "../shared/mcp";
import type {
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../shared/schemas";
import { jsonValueSchema } from "../shared/schemas";
import { defineTool } from "../shared/tool-definition";
import { invalidToolInput, recoverToolInputError } from "../shared/tool-input";
import { mcpToolPage } from "./mcp-discovery";

// Discriminated unions require the underlying object (before readonly and
// before any `.transform/.refine` wrapping), so build the shapes explicitly.
const serverId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
  .refine((value) => !value.includes("__"));

const serversArgs = z.object({ tool: z.literal("mcp_list_servers") }).strict();
const listArgs = z
  .object({
    tool: z.literal("mcp_list_tools"),
    server: serverId,
    offset: z.number().int().min(0).max(MCP_MAX_TOOLS_PER_SERVER).optional(),
  })
  .strict()
  .readonly();
const callArgs = z
  .object({
    tool: z.literal("mcp_call_tool"),
    toolName: z.string().min(1).max(64),
    arguments: z.record(z.unknown()).optional(),
    arguments_json: z
      .string()
      .max(MCP_CALL_ARGUMENT_LIMIT)
      .optional()
      .describe(
        "JSON object encoded as a string, matching the selected MCP tool's input schema.",
      ),
  })
  .strict()
  .readonly();
const args = z.discriminatedUnion("tool", [
  serversArgs,
  listArgs.unwrap(),
  callArgs.unwrap(),
]);

const description =
  "MCP tools over user-registered stdio, Streamable HTTP and SSE servers. " +
  "readonly permission denies connecting and calling; workspace requires a fresh per-call " +
  "approval showing the registered server command or URL; unrestricted runs " +
  "automatically against explicitly registered and enabled servers only. " +
  "Server environments are minimal and never inherit credentials.";

const toolDescriptions: Readonly<Record<z.infer<typeof args>["tool"], string>> =
  {
    mcp_list_servers:
      "List currently registered MCP server IDs, labels, transports and enabled state. Start here to discover available servers. Does not connect or start any process; available in readonly mode.",
    mcp_list_tools: `${description} Lists an enabled server's current tools with real input/output schemas, titles and annotations (bounded discovery, lazy connect). Use mcp_list_servers to find server IDs. When nextOffset is returned, call again with that offset for the remaining tools. Annotations are untrusted hints, not permissions.`,
    mcp_call_tool: `${description} Calls an MCP tool by its discovered namespaced name (mcp__<server>__<tool>). Discover tools in the current run before reusing aliases from history. Encode its input object as arguments_json using the schema returned by mcp_list_tools. Omit for an empty object. At most 64 KiB including the call envelope; returns bounded sanitized text, content blocks and structured results when available.`,
  };
const definitions: readonly ToolDefinition[] = args.options.map((schema) => {
  const { tool, ...fields } = schema.shape;
  const name = tool.value;
  return defineTool(
    name,
    toolDescriptions[name],
    z.object(fields).strict(),
    name === "mcp_call_tool" ? ["arguments"] : [],
  );
});

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
  const clean = (text: string): string => {
    let output = text;
    for (const secret of options.redactValues ?? [])
      if (secret) output = output.split(secret).join("[REDACTED]");
    return output;
  };

  async function authorize(
    ctx: ToolContext,
    call: ToolCall,
    target: Readonly<{ server: McpServerRecord; description: string }>,
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
      description: clean(target.description),
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
    const current = (await service.list()).find(
      (entry) => entry.id === target.server.id,
    );
    if (JSON.stringify(current) !== JSON.stringify(target.server))
      throw new ForgeError(
        "tool",
        "MCP server configuration changed during approval. Discover it again before calling.",
      );
  }

  const registry: LocalToolRegistry = {
    definitions,
    async execute(call, ctx) {
      try {
        if (ctx.signal.aborted)
          throw new ForgeError("cancelled", "Tool execution cancelled.");
        if (
          Buffer.byteLength(call.function.arguments, "utf8") >
          MCP_CALL_ARGUMENT_LIMIT
        )
          return invalidToolInput("Tool call arguments exceed 64 KiB.");
        const object = z
          .record(z.unknown())
          .parse(JSON.parse(call.function.arguments));
        if ("tool" in object)
          return invalidToolInput(
            "tool is not an accepted argument; use the declared parameters.",
          );
        const parsed = args.parse({ ...object, tool: call.function.name });
        const catalog = await service.list();
        const servers = new Map(catalog.map((entry) => [entry.id, entry]));
        for (const [alias, route] of routes)
          if (!servers.has(route.server)) routes.delete(alias);
        if (parsed.tool === "mcp_list_servers") {
          return result({
            servers: catalog.map((server) => ({
              id: server.id,
              label: clean(server.label),
              enabled: server.enabled,
              transport: server.transport ?? "stdio",
            })),
          });
        }
        if (parsed.tool === "mcp_list_tools") {
          const server = servers.get(parsed.server);
          if (!server) return result({ error: "unknown server" }, true);
          if (!server.enabled)
            return result({ error: "server is disabled" }, true);
          await authorize(ctx, call, {
            server,
            description: `List tools of MCP server "${server.id}" (${server.url ?? `${server.command} ${server.args.join(" ")}`}).`,
          });
          const tools = await service.listTools(parsed.server, {
            signal: ctx.signal,
            redactValues: options.redactValues ?? [],
          });
          const payload = mcpToolPage(server.id, tools, parsed.offset ?? 0);
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

        if (
          parsed.arguments !== undefined &&
          parsed.arguments_json !== undefined
        )
          return invalidToolInput(
            "Supply arguments_json only; do not combine it with legacy arguments.",
          );
        let inputArguments = parsed.arguments ?? {};
        if (parsed.arguments_json !== undefined) {
          try {
            inputArguments = z
              .object({ arguments_json: z.record(z.unknown()) })
              .parse({
                arguments_json: JSON.parse(parsed.arguments_json),
              }).arguments_json;
          } catch (error) {
            if (error instanceof SyntaxError)
              return invalidToolInput(
                "arguments_json must contain valid JSON encoding an object.",
              );
            throw error;
          }
        }
        const route =
          routes.get(parsed.toolName) ?? parseMcpToolName(parsed.toolName);
        if (!route) return result({ error: "unknown tool name" }, true);
        const server = servers.get(route.server);
        if (!server) return result({ error: "unknown server" }, true);
        if (!server.enabled)
          return result({ error: "server is disabled" }, true);
        const encoded = JSON.stringify(inputArguments);
        if (Buffer.byteLength(encoded, "utf8") > MCP_CALL_ARGUMENT_LIMIT)
          return invalidToolInput("MCP input arguments exceed 64 KiB.");
        await authorize(ctx, call, {
          server,
          description: `Call MCP tool "${route.tool}" on server "${server.id}" (${server.url ?? `${server.command} ${server.args.join(" ")}`}).`,
        });
        const outcome = await service.callTool(
          route.server,
          route.tool,
          inputArguments,
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
          payload = {
            ...boundedText(outcome.text, limit),
            truncated: true,
            isError: true,
          };
        }
        return result(jsonValueSchema.parse(payload), payload.isError);
      } catch (error) {
        const invalid = recoverToolInputError(error);
        if (invalid) return { ...invalid, content: clean(invalid.content) };
        if (error instanceof ForgeError)
          return result(
            { code: error.code, error: clean(error.message) },
            true,
          );
        return result({ error: "MCP call failed." }, true);
      }
    },
    async dispose() {
      await service.dispose();
    },
  };
  return registry;
}
