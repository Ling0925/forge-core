import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StdioMcpConnection } from "../../src/mcp/protocol";
import { createMcpService } from "../../src/mcp/registry";

const init = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "fixture", version: "1" },
};
const script = (response: string) =>
  `const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line', line=>{const q=JSON.parse(line);if(q.id!==undefined){${response}}});`;
for (const [name, payload] of Object.entries({
  nullError: "error:null",
  missing: "",
  both: 'result:{},error:{code:1,message:"bad"}',
  wrongId: "result:{}",
  unsupported: `result:${JSON.stringify({ ...init, protocolVersion: "2099-unsupported" })}`,
  capability: `result:${JSON.stringify({ ...init, capabilities: { tools: { listChanged: 42 } } })}`,
})) {
  it(`settles and closes ${name}`, async () => {
    const c = new StdioMcpConnection({
      command: process.execPath,
      args: [
        "-e",
        script(
          `console.log(JSON.stringify({jsonrpc:'2.0',id:${name === "wrongId" ? "String(q.id)" : "q.id"},${payload}}))`,
        ),
      ],
      env: {},
      requestTimeoutMs: 500,
    });
    try {
      await expect(c.connect()).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(c.isClosed).toBe(true);
    } finally {
      await c.close();
    }
  });
}
it("pre-abort never spawns or writes; discovery and init abort close the connection", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-abort-"));
  const marker = join(home, "spawned");
  const c = new StdioMcpConnection({
    command: process.execPath,
    args: [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');setInterval(()=>{},1000)`,
    ],
    env: {},
    requestTimeoutMs: 1000,
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await expect(c.connect(controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(
      c.request("initialize", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await c.close();
    await rm(home, { recursive: true, force: true });
  }
  for (const stage of ["initialize", "tools/list"]) {
    const conn = new StdioMcpConnection({
      command: process.execPath,
      args: [
        "-e",
        script(
          `if(q.method!==${JSON.stringify(stage)})console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:${JSON.stringify(init)}}));`,
        ),
      ],
      env: {},
      requestTimeoutMs: 2000,
    });
    const abort = new AbortController();
    try {
      if (stage === "tools/list") await conn.connect();
      const pending =
        stage === "initialize"
          ? conn.connect(abort.signal)
          : conn.listTools(abort.signal);
      setTimeout(() => abort.abort(), 50);
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      expect(conn.isClosed).toBe(true);
    } finally {
      await conn.close();
    }
  }
});
it("redacts private, mapped and runtime values in discovery, results and errors; revokes removal", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-redact-"));
  const service = await createMcpService({ home });
  const other = await createMcpService({ home });
  process.env.MCP_FIXTURE_VALUE = "mapped-fake";
  const secrets = ["private-fake", "mapped-fake", "runtime-fake"];
  const code = script(
    `const text=[process.env.PRIVATE,process.env.MAPPED,'runtime-fake'].join(' ');let result=${JSON.stringify(init)};if(q.method==='tools/list')result={tools:[{name:'echo',description:text,inputSchema:{type:'object',description:text}}]};if(q.method==='tools/call'){if(q.params.name==='error'){console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-1,message:text}}));return;}result={content:[{type:'text',text}]};}console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));`,
  );
  try {
    await service.register({
      id: "test",
      label: "test",
      command: process.execPath,
      args: ["-e", code],
      enabled: true,
      env: { PRIVATE: secrets[0] },
      envNames: { MAPPED: "MCP_FIXTURE_VALUE" },
    });
    const opts = { redactValues: ["runtime-fake"] };
    const tools = JSON.stringify(await service.listTools("test", opts));
    const result = await service.callTool("test", "echo", {}, opts);
    let errorText = "";
    try {
      await service.callTool("test", "error", {}, opts);
    } catch (error) {
      errorText = String(error);
    }
    for (const secret of secrets) {
      expect(tools).not.toContain(secret);
      expect(result.text).not.toContain(secret);
      expect(errorText).not.toContain(secret);
    }
    expect(errorText).toContain("[REDACTED]");
    await other.remove("test");
    await expect(service.listTools("test")).rejects.toMatchObject({
      code: "tool",
    });
    expect((await service.health("test")).connected).toBe(false);
  } finally {
    Reflect.deleteProperty(process.env, "MCP_FIXTURE_VALUE");
    await service.dispose();
    await other.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
