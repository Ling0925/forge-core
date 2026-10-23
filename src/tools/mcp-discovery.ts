import { ForgeError } from "../shared/errors";
import type { McpToolInfo } from "../shared/mcp";
import { type JsonValue, jsonValueSchema } from "../shared/schemas";
import { mcpToolName } from "../mcp/names";

// ToolResult is capped at 131072 characters. A UTF-8 byte cap also fits that
// persistence boundary without slicing a tool's input or output schema.
const pageLimit = 128 * 1024;

export function mcpToolPage(server: string, tools: readonly McpToolInfo[], offset: number): JsonValue {
  if (offset > tools.length)
    throw new ForgeError("invalid_input", "MCP tool offset is past the current catalog. List from offset 0 again.");
  const entries: JsonValue[] = [];
  let next = offset;
  let bytes = Buffer.byteLength(JSON.stringify({ server, tools: [], nextOffset: 256 }));
  for (const tool of tools.slice(offset)) {
    const entry = jsonValueSchema.parse({
      tool: mcpToolName(server, tool.name), name: tool.name,
      description: tool.description, inputSchema: tool.inputSchema,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    });
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + size > pageLimit) {
      if (!entries.length)
        throw new ForgeError("invalid_input", "MCP tool metadata exceeds the 128 KiB result limit.");
      break;
    }
    entries.push(entry);
    bytes += size;
    next++;
  }
  return { server, tools: entries, ...(next < tools.length ? { nextOffset: next } : {}) };
}
