#!/usr/bin/env node
// A tiny, dependency-free MCP stdio server used by the MCP tests and docs.
//
// It speaks newline-framed JSON-RPC 2.0 (the stdio transport from
// https://modelcontextprotocol.io/specification/2025-11-25/basic/transports):
//   - initialize -> initialize + notifications/initialized
//   - tools/list -> two tools, paged one-per-page via a cursor to exercise
//     bounded pagination
//   - tools/call -> `echo` (returns the text) and `secret` (returns a value
//     from an explicitly approved environment variable, if present)
//
// Deliberately small and deterministic so end-to-end smoke tests are stable.
// Run it directly: `node examples/mcp/echo-server.mjs`.
const VISIBLE = process.env.FORGE_MCP_VISIBLE_VALUE ?? "";
let buffer = "";

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the provided text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "secret_report",
    description:
      "Report whether an approved environment value is visible (never its name).",
    inputSchema: { type: "object", properties: {} },
    readOnlyHint: true,
  },
];

const handle = (message) => {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "forge-echo-example", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "notifications/cancelled") return;
  if (message.method === "tools/list") {
    const start = Number(message.params?.cursor ?? 0);
    const page = TOOLS.slice(start, start + 1);
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: page,
        ...(start + 1 < TOOLS.length ? { nextCursor: String(start + 1) } : {}),
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "echo") {
      const text = String(message.params?.arguments?.text ?? "");
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text }], isError: false },
      });
      return;
    }
    if (name === "secret_report") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            { type: "text", text: VISIBLE.length > 0 ? "visible" : "absent" },
          ],
          isError: false,
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32602, message: "Unknown tool." },
    });
    return;
  }
  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found." },
    });
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed input lines */
    }
  }
});
process.stdin.on("end", () => process.exit(0));
