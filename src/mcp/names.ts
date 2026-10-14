import { createHash } from "node:crypto";
import { MCP_NAME_LIMIT } from "./types";

// Namespaced provider tool names: mcp__<server>__<tool>. Segments never
// contain "__", so parsing is collision-free.

const segment = (value: string, max: number): string => {
  const clean = value
    .replace(/[^a-zA-Z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  if (clean === value && clean.length <= max) return clean;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${clean.slice(0, max - 9)}-${digest}`;
};

export function mcpToolName(serverId: string, toolName: string): string {
  const name = `mcp__${segment(serverId, 24)}__${segment(toolName, 30)}`;
  if (name.length > MCP_NAME_LIMIT)
    throw new Error("MCP tool name exceeds the 64 character limit.");
  return name;
}

export function parseMcpToolName(
  name: string,
): Readonly<{ server: string; tool: string }> | undefined {
  // A single unconditional group pattern avoids optional-group `undefined`.
  const match =
    /^mcp__([a-z0-9][a-z0-9-]{0,30}[a-z0-9]|[a-z0-9])__([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(
      name,
    );
  if (!match) return undefined;
  const server = match[1];
  const tool = match[2];
  if (server === undefined || tool === undefined) return undefined;
  // Segments must not contain "__" so routing stays unambiguous.
  if (server.includes("__") || tool.includes("__")) return undefined;
  if (tool.includes("-__") || tool.endsWith("-")) return undefined;
  return { server, tool };
}
