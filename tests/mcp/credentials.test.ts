import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMcpService } from "../../src/mcp/registry";
import { rpcRequestSchema } from "../../src/shared/ipc";
import { mcpRegisterDtoSchema } from "../../src/shared/mcp";

const registration = {
  id: "exa-local",
  label: "Exa local fixture",
  command: process.execPath,
  args: [],
};

it("accepts explicit private env through the public RPC contract and preserves legacy registration", () => {
  expect(mcpRegisterDtoSchema.parse(registration)).toEqual(registration);
  const input = { ...registration, transport: "stdio", env: { EXA_API_KEY: "fixture-key" } };
  const request = rpcRequestSchema.parse({ id: randomUUID(), method: "registerMcpServer", input });
  expect(request).toMatchObject({ method: "registerMcpServer", input });
});

it.each([
  { envNames: { EXA_API_KEY: "EXA_API_KEY" } },
  { env: { NODE_OPTIONS: "--require=untrusted" } },
  { env: { "BAD-NAME": "value" } },
  { env: { EXA_API_KEY: 123 } },
])("rejects unsafe or invalid public environment inputs: %j", (extra) => {
  expect(mcpRegisterDtoSchema.safeParse({ ...registration, ...extra }).success).toBe(false);
});

it("persists explicit env privately and passes it to stdio without exposing it in public output", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-mcp-credentials-"));
  let service = await createMcpService({ home });
  const secret = "exa-private-fixture-value";
  const script = `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const q = JSON.parse(line);
      if (q.id === undefined) return;
      if (q.method === 'tools/call' && q.params.name === 'fail') {
        console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-1,message:process.env.EXA_API_KEY}}));
        return;
      }
      const result = q.method === 'initialize'
        ? {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'env-fixture',version:'1'}}
        : q.method === 'tools/call'
          ? {content:[{type:'text',text:process.env.EXA_API_KEY ?? 'missing'}]}
          : {};
      console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
    });`;
  try {
    const input = mcpRegisterDtoSchema.parse({
      ...registration, args: ["-e", script.replaceAll("\n", " ")], env: { EXA_API_KEY: secret },
    });
    const record = await service.register(input);
    expect(record).toMatchObject({ enabled: false, hasPrivateEnv: true });
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(await service.health(registration.id)).toMatchObject({ connected: false });
    const path = join(home, "mcp", "servers.json");
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(await readFile(path, "utf8")).toContain(secret);
    await service.dispose();
    service = await createMcpService({ home });
    await service.setEnabled(registration.id, true);
    expect(await service.health(registration.id)).toMatchObject({ connected: true });
    const result = await service.callTool(registration.id, "report", {});
    expect(result.text).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(service.callTool(registration.id, "fail", {})).rejects.toThrow("[REDACTED]");
    expect(JSON.stringify(await service.list())).not.toContain(secret);
  } finally {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
