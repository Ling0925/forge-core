import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
import { toolResultSchema } from "../../src/shared/schemas";

function request(name: string, args: Readonly<Record<string, string>>) {
  return { role: "assistant", content: null, tool_calls: [
    { id: name, type: "function", function: { name, arguments: JSON.stringify(args) } },
  ] } as const;
}

it("discovers an operator-registered server and executes its advertised tool through a real Core run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-mcp-run-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  let turn = 0;
  const provider: ModelProvider = {
    listModels: async () => ["fixture"],
    complete: async (messages, definitions) => {
      expect(definitions.map(tool => tool.function.name)).toContain("mcp_list_servers");
      if (turn++ === 0) return { message: request("mcp_list_servers", {}) };
      const latest = messages.findLast(message => message.role === "tool");
      if (!latest || latest.role !== "tool") throw new Error("Missing tool result");
      const result = toolResultSchema.parse(JSON.parse(latest.content));
      expect(result.isError).toBe(false);
      const payload: unknown = JSON.parse(result.content);
      switch (latest.tool_call_id) {
        case "mcp_list_servers": {
          const catalog = z.object({ servers: z.array(z.object({ id: z.string(), enabled: z.boolean() })) }).parse(payload);
          const server = catalog.servers.find(entry => entry.enabled);
          if (!server) throw new Error("No enabled server discovered");
          return { message: request("mcp_list_tools", { server: server.id }) };
        }
        case "mcp_list_tools": {
          const catalog = z.object({ tools: z.array(z.object({ name: z.string(), tool: z.string() })) }).parse(payload);
          const echo = catalog.tools.find(entry => entry.name === "echo");
          if (!echo) throw new Error("Echo tool not discovered");
          return { message: request("mcp_call_tool", { toolName: echo.tool, arguments_json: '{"text":"Core MCP round trip"}' }) };
        }
        case "mcp_call_tool":
          expect(payload).toEqual({ text: "Core MCP round trip", isError: false, truncated: false });
          return { message: { role: "assistant", content: "Completed" } };
        default: throw new Error("Unexpected tool result");
      }
    },
  };
  const harness = await createHarness({ stateDir: join(directory, "state"), providerFactory: () => provider });
  try {
    await harness.updateSettings({ settings: { baseUrl: "http://127.0.0.1:1/v1", model: "fixture" } });
    await harness.registerMcpServer({
      id: "echo", label: "Echo", command: process.execPath,
      args: [fileURLToPath(new URL("../../examples/mcp/echo-server.mjs", import.meta.url))], enabled: true,
    });
    const session = await harness.createSession({ workspace });
    const approvals: string[] = [];
    const result = await harness.run({ sessionId: session.id, prompt: "Use an available MCP tool", permission: "workspace" },
      () => undefined, async approval => { approvals.push(approval.toolName); return true; }, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["mcp_list_tools", "mcp_call_tool"]);
    expect(result.messages.filter(message => message.role === "tool")).toHaveLength(3);
  } finally {
    await harness.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
