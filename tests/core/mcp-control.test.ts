import { mkdir, mkdtemp, rm, watch, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
for (const action of ["disable", "remove", "cancel"] as const)
  it(`settles in-flight stdio MCP request on ${action} after actual approval`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-mcp-control-"));
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const marker = join(dir, "entered");
    const fixture = join(dir, "fixture.mjs");
    await writeFile(
      fixture,
      `import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';const lines=createInterface({input:process.stdin});lines.on('line',line=>{const q=JSON.parse(line);if(!q.id)return;let result;if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(q.method==='tools/list')result={tools:[{name:'block',description:'block',inputSchema:{type:'object'}}]};else if(q.method==='tools/call'){writeFileSync(process.argv[2],'entered');return;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`,
    );
    const watcherAbort = new AbortController();
    const events = watch(dir, { signal: watcherAbort.signal });
    const entered = (async () => {
      for await (const event of events)
        if (event.filename === "entered") return;
    })();
    let turns = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async () => ({
        message:
          ++turns === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "discover",
                    type: "function",
                    function: {
                      name: "mcp_list_tools",
                      arguments: JSON.stringify({ server: "fixture" }),
                    },
                  },
                ],
              }
            : turns === 2
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "blocked",
                      type: "function",
                      function: {
                        name: "mcp_call_tool",
                        arguments: JSON.stringify({
                          toolName: "mcp__fixture__block",
                          arguments: {},
                        }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "failed work reported" },
      }),
    };
    const h = await createHarness({
      stateDir: join(dir, "state"),
      providerFactory: () => provider,
    });
    try {
      await h.updateSettings({
        settings: { baseUrl: "http://localhost:1234/v1", model: "root" },
      });
      await h.registerMcpServer({
        id: "fixture",
        label: "Fixture",
        command: process.execPath,
        args: [fixture, marker],
        enabled: true,
        requestTimeoutMs: 60000,
      });
      const session = await h.createSession({ workspace, title: "MCP control fixture" });
      const approvals: string[] = [];
      const work = h.run(
        {
          sessionId: session.id,
          prompt: "call fixture",
          permission: "workspace",
        },
        () => {},
        async (request) => {
          approvals.push(request.description);
          expect(request.sessionId).toBe(session.id);
          return true;
        },
        new AbortController().signal,
      );
      await Promise.race([
        entered,
        work.then(() => {
          throw Error("Run settled before blocked fixture request");
        }),
      ]);
      expect(approvals).toHaveLength(2);
      expect(approvals.join(" ")).toContain(process.execPath);
      if (action === "disable") await h.setMcpEnabled("fixture", false);
      else if (action === "remove") await h.removeMcpServer("fixture");
      else expect(await h.cancelSession(session.id)).toBe(true);
      const result = await work;
      expect(result.status).toBe(
        action === "cancel" ? "cancelled" : "completed",
      );
      const toolResult = result.messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "blocked",
      );
      expect(toolResult?.content).toBeTruthy();
      if (action !== "cancel")
        expect(JSON.parse(toolResult?.content ?? "{}")).toMatchObject({
          isError: true,
        });
    } finally {
      watcherAbort.abort();
      await h.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
