import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { MCP_TRUNCATION_MARKER } from "../../src/mcp/bounds";
import { StdioMcpConnection } from "../../src/mcp/protocol";
import { createMcpService } from "../../src/mcp/registry";
import { MCP_RESULT_LIMIT } from "../../src/mcp/types";
import { parseSessionId } from "../../src/shared/schemas";
import { createMcpToolRegistry } from "../../src/tools/mcp";

const init = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "fixture", version: "1" },
};
const server = (body: string) =>
  `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result=${JSON.stringify(init)};${body};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`;
async function running(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "",
    );
  } catch {
    return false;
  }
}

it.skipIf(process.platform !== "linux")(
  "awaited cleanup survives immediate independent controller exit and kills TERM-ignoring descendant",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-controller-"));
    const marker = join(home, "descendant.json");
    let pid: number | undefined;
    try {
      const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
      const fixture = join(home, "server.cjs");
      await writeFile(
        fixture,
        `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});${server("")}`,
      );
      const bundled = await build({
        stdin: {
          contents: `import {StdioMcpConnection} from ${JSON.stringify(resolve("src/mcp/protocol.ts"))}; import {access} from 'node:fs/promises'; const c=new StdioMcpConnection({command:process.execPath,args:[${JSON.stringify(fixture)}],env:{},requestTimeoutMs:1000}); await c.connect(); for(let i=0;i<200;i++){try{await access(${JSON.stringify(marker)});break;}catch{await new Promise(r=>setTimeout(r,10));}} await c.close();`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
      });
      const controller = join(home, "controller.mjs");
      await writeFile(controller, bundled.outputFiles[0]?.text ?? "");
      const child = spawn(process.execPath, [controller], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const code = await new Promise<number | null>((done, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("controller timeout"));
        }, 8000);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timeout);
          done(code);
        });
      });
      pid = JSON.parse(await readFile(marker, "utf8")).pid as number;
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(await running(pid)).toBe(false);
      await new Promise((r) => setTimeout(r, 2300));
      expect(await running(pid)).toBe(false);
    } finally {
      if (pid && (await running(pid))) process.kill(pid, "SIGKILL");
      else if (!pid) {
        try {
          const data = JSON.parse(await readFile(marker, "utf8"));
          process.kill(data.pid, "SIGKILL");
        } catch {
          /* absent */
        }
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  12000,
);

it("caps actual non-ASCII stdio output after redaction with exact bytes and honest truncation", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-bytes-"));
  const service = await createMcpService({ home });
  try {
    await service.register({
      id: "bytes",
      label: "bytes",
      command: process.execPath,
      args: [
        "-e",
        server(
          "if(q.method==='tools/call')result={content:[{type:'text',text:'界'.repeat(70000)}]}",
        ),
      ],
      enabled: true,
    });
    const output = await service.callTool("bytes", "echo", {});
    const markerBytes = Buffer.byteLength(MCP_TRUNCATION_MARKER);
    expect(Buffer.byteLength(output.text)).toBe(
      Math.floor((MCP_RESULT_LIMIT - markerBytes) / 3) * 3 + markerBytes,
    );
    expect(output.text.endsWith(MCP_TRUNCATION_MARKER)).toBe(true);
    expect(output.text).not.toContain("\ufffd");
    expect(output.truncated).toBe(true);
    expect(output.isError).toBe(true);
    const registry = await createMcpToolRegistry(service);
    const native = await registry.execute(
      {
        id: "bytes",
        type: "function",
        function: {
          name: "mcp_call_tool",
          arguments: JSON.stringify({ toolName: "mcp__bytes__echo" }),
        },
      },
      {
        sessionId: parseSessionId("00000000-0000-4000-8000-000000000002"),
        toolCallId: "bytes",
        workspace: home,
        permission: "unrestricted",
        signal: new AbortController().signal,
        approve: async () => true,
        onEvent: () => undefined,
      },
    );
    expect(Buffer.byteLength(native.content)).toBeLessThanOrEqual(
      MCP_RESULT_LIMIT,
    );
    expect(JSON.parse(native.content)).toMatchObject({
      truncated: true,
      isError: true,
    });
    expect(native.isError).toBe(true);
    const redacted = await service.callTool(
      "bytes",
      "echo",
      {},
      { redactValues: ["界".repeat(70000)] },
    );
    expect(redacted).toEqual({
      text: "[REDACTED]",
      truncated: false,
      isError: false,
    });
  } finally {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

it("rejects aggregate non-ASCII paginated catalog instead of advertising a partial schema", async () => {
  const c = new StdioMcpConnection({
    command: process.execPath,
    args: [
      "-e",
      server(
        "if(q.method==='tools/list'){const page=Number(q.params.cursor||0);result={tools:[{name:'tool'+page,inputSchema:{type:'object',description:'界'.repeat(50000)}}],nextCursor:String(page+1)}}",
      ),
    ],
    env: {},
    requestTimeoutMs: 1000,
  });
  try {
    await c.connect();
    await expect(c.listTools()).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("aggregate input budget"),
    });
  } finally {
    await c.close();
  }
});
