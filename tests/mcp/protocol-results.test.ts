import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { toolOutcome } from "../../src/mcp/content";
import { StdioMcpConnection } from "../../src/mcp/protocol";
import { createMcpService } from "../../src/mcp/registry";
import { type Json, JsonRpcConnection } from "../../src/mcp/rpc";
import {
  MCP_MAX_MESSAGE_BYTES,
  mcpContentSchema,
  mcpToolInfoSchema,
} from "../../src/shared/mcp";

class Fixture extends JsonRpcConnection {
  readonly sent: Json[] = [];
  handler: (message: Json) => void = () => undefined;
  constructor() {
    super(20);
  }
  protected async start(): Promise<void> {}
  protected terminate(): void {}
  protected send(message: Json): void {
    this.sent.push(message);
    this.handler(message);
  }
  receiveMessage(message: Json): void {
    this.receive(message);
  }
  reply(message: Json, result: Json): void {
    this.receiveMessage({ jsonrpc: "2.0", id: message.id, result });
  }
}

it.each(["text", "content", "type", "resource", "image"])(
  "preserves protocol structure when the private value is %s",
  (secret) => {
    expect(
      toolOutcome({ content: [{ type: "text", text: "safe" }] }, [secret]),
    ).toEqual({ text: "safe", isError: false, truncated: false });
    const annotations = { [secret]: { value: secret } };
    const outcome = toolOutcome(
      {
        content: [
          { type: "text", text: secret, annotations },
          {
            type: "image",
            data: "AA==",
            mimeType: `image/${secret}`,
            annotations,
          },
          {
            type: "resource_link",
            uri: `file:///${secret}`,
            name: secret,
            title: secret,
            description: secret,
            mimeType: secret,
            annotations,
          },
          {
            type: "resource",
            resource: {
              uri: `file:///${secret}`,
              text: secret,
              mimeType: secret,
              annotations,
            },
            annotations,
          },
        ],
        structuredContent: { [secret]: [secret] },
      },
      [secret],
    );
    expect(outcome.truncated).toBe(false);
    expect(outcome.content?.map((item) => item.type)).toEqual([
      "text",
      "image",
      "resource_link",
      "resource",
    ]);
    expect(outcome.content?.[0]).toMatchObject({
      text: "[REDACTED]",
      annotations: { "[REDACTED]": { value: "[REDACTED]" } },
    });
    expect(outcome.content?.[1]).toMatchObject({
      data: "AA==",
      mimeType: `image/${secret}`.split(secret).join("[REDACTED]"),
    });
    expect(outcome.content?.[2]).toMatchObject({
      uri: "file:///[REDACTED]",
      name: "[REDACTED]",
      title: "[REDACTED]",
      description: "[REDACTED]",
      mimeType: "[REDACTED]",
    });
    expect(outcome.content?.[3]).toMatchObject({
      resource: {
        uri: "file:///[REDACTED]",
        text: "[REDACTED]",
        mimeType: "[REDACTED]",
        annotations: { "[REDACTED]": { value: "[REDACTED]" } },
      },
    });
    expect(outcome.structuredContent).toEqual({ "[REDACTED]": ["[REDACTED]"] });
  },
);

it("retains mixed typed content, structured data and recursively redacts private values", () => {
  const output = toolOutcome(
    {
      content: [
        { type: "text", text: "hello secret" },
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "audio", data: "AQ==", mimeType: "audio/wav" },
        {
          type: "resource_link",
          uri: "file:///secret",
          name: "guide",
          annotations: { nested: { value: "secret" } },
        },
        {
          type: "resource",
          annotations: { audience: ["user"] },
          resource: {
            uri: "file:///guide",
            text: "secret guide",
            annotations: { nested: { value: "secret" } },
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///binary",
            blob: "Ag==",
            annotations: { priority: 0.5 },
          },
        },
      ],
      structuredContent: { nested: [{ secret: "secret" }] },
      isError: true,
    },
    ["secret"],
  );
  expect(output.content).toHaveLength(6);
  expect(output.content?.[4]).toMatchObject({
    annotations: { audience: ["user"] },
    resource: { annotations: { nested: { value: "[REDACTED]" } } },
  });
  expect(output.content?.[5]).toMatchObject({
    resource: { annotations: { priority: 0.5 } },
  });
  expect(output.structuredContent).toEqual({
    nested: [{ "[REDACTED]": "[REDACTED]" }],
  });
  expect(JSON.stringify(output)).not.toContain("secret");
  expect(output.text).toContain("guide");
  expect(output.isError).toBe(true);
  expect(output.truncated).toBe(false);
});

it("validates near-frame-limit base64 without overflowing and omits it whole", () => {
  const length = Math.floor((MCP_MAX_MESSAGE_BYTES - 256) / 4) * 4;
  for (const data of ["A".repeat(length), `${"A".repeat(length - 2)}==`]) {
    const item = { type: "image", data, mimeType: "image/png" };
    expect(
      Buffer.byteLength(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [item] } }),
      ),
    ).toBeLessThan(MCP_MAX_MESSAGE_BYTES);
    expect(mcpContentSchema.safeParse(item).success).toBe(true);
    const outcome = toolOutcome({ content: [item] }, []);
    expect(outcome.content).toEqual([]);
    expect(outcome.truncated).toBe(true);
  }
  expect(
    mcpContentSchema.safeParse({
      type: "image",
      data: `${"A".repeat(length - 1)}!`,
      mimeType: "image/png",
    }).success,
  ).toBe(false);
});

it("omits oversized or secret-bearing binary whole, and bounds escaped rich envelopes", () => {
  for (const content of [
    [
      {
        type: "image",
        data: Buffer.alloc(70000).toString("base64"),
        mimeType: "image/png",
      },
    ],
    [
      {
        type: "audio",
        data: Buffer.from("secret").toString("base64"),
        mimeType: "audio/wav",
      },
    ],
    [{ type: "text", text: "\u0000".repeat(70000) }],
  ]) {
    const output = toolOutcome(
      { content, structuredContent: { x: "\u0000".repeat(70000) } },
      ["secret"],
    );
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(
      48 * 1024,
    );
    expect(output.truncated).toBe(true);
    expect(output.isError).toBe(true);
    expect(output.content).toEqual([]);
    expect(output.text).toMatch(/omitted|truncated/);
  }
});

it("rejects malformed media and preserves normal text outcome", () => {
  expect(() =>
    toolOutcome(
      { content: [{ type: "image", data: "!!!", mimeType: "image/png" }] },
      [],
    ),
  ).toThrow();
  expect(
    toolOutcome({ content: [{ type: "text", text: "hello" }] }, []),
  ).toEqual({ text: "hello", isError: false, truncated: false });
});

it("accepts 128-character server names and retains output metadata", () => {
  const tool = {
    name: "a".repeat(128),
    title: "Display",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    annotations: { readOnlyHint: true },
  };
  expect(mcpToolInfoSchema.parse(tool)).toMatchObject(tool);
  expect(
    mcpToolInfoSchema.safeParse({ ...tool, name: "a".repeat(129) }).success,
  ).toBe(false);
});

it("answers server ping, rejects unsupported requests and detects dead live connections", async () => {
  const fixture = new Fixture();
  fixture.receiveMessage({ jsonrpc: "2.0", id: "server-ping", method: "ping" });
  expect(fixture.sent.at(-1)).toEqual({
    jsonrpc: "2.0",
    id: "server-ping",
    result: {},
  });
  fixture.receiveMessage({
    jsonrpc: "2.0",
    id: "sampling",
    method: "sampling/createMessage",
  });
  expect(fixture.sent.at(-1)?.error).toMatchObject({ code: -32601 });
  fixture.handler = (message) => {
    if (message.method === "initialize")
      fixture.reply(message, {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "fixture", version: "1" },
      });
  };
  await fixture.connect();
  await expect(fixture.ping()).rejects.toThrow("timed out");
  expect(fixture.isClosed).toBe(true);
  await expect(fixture.connect()).rejects.toThrow();
  await fixture.close();
});

it("consumes tool changes and rejects inconsistent pagination without replaying calls", async () => {
  const fixture = new Fixture();
  let changed = false;
  fixture.handler = (message) => {
    if (message.method === "tools/list") {
      if (!changed) {
        changed = true;
        fixture.receiveMessage({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        });
      }
      fixture.reply(message, {
        tools: [
          {
            name: changed ? "current" : "old",
            inputSchema: { type: "object" },
          },
        ],
      });
    }
  };
  await expect(fixture.listTools()).rejects.toThrow("changed during discovery");
  await expect(fixture.listTools()).resolves.toMatchObject([
    { name: "current" },
  ]);
  await expect(fixture.callTool("effect", {})).rejects.toThrow("timed out");
  expect(
    fixture.sent.filter((message) => message.method === "tools/call"),
  ).toHaveLength(1);
  await fixture.close();
});

it("delivers large queued stdio writes instead of treating backpressure as failure", async () => {
  const connection = new StdioMcpConnection({
    command: process.execPath,
    args: ["examples/mcp/echo-server.mjs"],
    env: {},
    requestTimeoutMs: 2000,
  });
  try {
    await connection.connect();
    const result = await connection.callTool("echo", {
      text: "ok",
      padding: "x".repeat(500000),
    });
    expect(result).toEqual({ text: "ok", isError: false, truncated: false });
    expect(connection.isClosed).toBe(false);
  } finally {
    await connection.close();
  }
});

it("health probes an initialized but unresponsive server instead of trusting cached connect", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-ping-"));
  const service = await createMcpService({ home });
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{protocolVersion:'2025-11-25',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));if(q.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{tools:[]}}));});`;
  try {
    await service.register({
      id: "silent",
      label: "silent",
      command: process.execPath,
      args: ["-e", script],
      enabled: true,
      requestTimeoutMs: 1000,
    });
    await expect(service.listTools("silent")).resolves.toEqual([]);
    await expect(service.health("silent")).resolves.toMatchObject({
      connected: false,
      lastError: "MCP request timed out.",
    });
  } finally {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
