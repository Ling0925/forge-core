import { mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sameOriginEndpoint, validSessionId } from "../../src/mcp/http";
import { createMcpService } from "../../src/mcp/registry";
import {
  mcpRegisterAnyInputSchema,
  mcpRemoteServerConfigSchema,
} from "../../src/mcp/types";

const initResult = {
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  serverInfo: { name: "remote-fixture", version: "1" },
};

const tools = [
  {
    name: "echo",
    description: "echo",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
    },
  },
];

const result = (id: unknown, value: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: value });

const callResult = (id: unknown, text: string) =>
  result(id, { content: [{ type: "text", text }], isError: false });

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 2 * 1024 * 1024) reject(new Error("body too large"));
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });

async function listen(
  handler: (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void,
): Promise<Readonly<{ server: Server; base: string; port: number }>> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, port };
}

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

const until = async (check: () => boolean, timeout = 2000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * Streamable HTTP fixture. Each POST carries one JSON-RPC message. The caller
 * chooses application/json or text/event-stream responses per method so both
 * response framings are exercised.
 */
function streamableFixture(options: Readonly<{ initProtocol?: string }> = {}) {
  const state = {
    posts: 0,
    calls: 0,
    deletes: 0,
    active: 0,
    sessions: [] as string[],
    authSeen: [] as string[],
    protocolHeaders: [] as string[],
    cancelSeen: 0,
    serverRequests: 0,
    stallInitialized: false,
    replyErrors: [] as unknown[],
    held: [] as import("node:http").ServerResponse[],
  };
  const base = {
    server: undefined as unknown as Server,
    url: "",
  };
  const handler = async (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    state.active += 1;
    request.on("close", () => {
      state.active -= 1;
    });
    if (request.method === "DELETE") {
      state.deletes += 1;
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    state.posts += 1;
    const session = request.headers["mcp-session-id"];
    if (typeof session === "string") state.sessions.push(session);
    const auth = request.headers.authorization;
    if (typeof auth === "string") state.authSeen.push(auth);
    const protocol = request.headers["mcp-protocol-version"];
    if (typeof protocol === "string") state.protocolHeaders.push(protocol);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(await readBody(request)) as Record<string, unknown>;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (message.method === "notifications/cancelled") {
      state.cancelSeen += 1;
      response.writeHead(202).end();
      return;
    }
    if (
      message.method === "notifications/initialized" &&
      state.stallInitialized
    ) {
      // Never send response headers: exercises request timeouts on
      // notifications.
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const id = message.id;
    const method = message.method;
    if (method === "tools/call") {
      state.calls += 1;
      const params = message.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      const name = params?.name;
      const text = String(params?.arguments?.text ?? "");
      if (name === "slow") {
        state.held.push(response);
        return;
      }
      if (name === "malformed") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{not-json");
        return;
      }
      if (name === "oversized") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: "x".repeat(1100 * 1024) }],
            },
          }),
        );
        return;
      }
      if (name === "wrong_content") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("nope");
        return;
      }
      if (name === "server_request") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        state.serverRequests += 1;
        response.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: "srv-1",
            method: "sampling/createMessage",
            params: {},
          })}\n\n`,
        );
        response.write(`event: message\ndata: ${callResult(id, text)}\n\n`);
        response.end();
        return;
      }
      if (name === "sse") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Split the event across chunks to exercise incremental framing.
        const frame = `event: message\ndata: ${callResult(id, text)}\n\n`;
        response.write(frame.slice(0, 12));
        setTimeout(() => response.end(frame.slice(12)), 5);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
      response.end(callResult(id, text));
      return;
    }
    if (method === "tools/list") {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
      response.end(result(id, { tools }));
      return;
    }
    if (method === "initialize") {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
      response.end(
        result(id, {
          ...initResult,
          ...(options.initProtocol === undefined
            ? {}
            : { protocolVersion: options.initProtocol }),
        }),
      );
      return;
    }
    // A client reply to a server-triggered request.
    if ("error" in message || "result" in message) {
      state.replyErrors.push(message.error);
      response.writeHead(202).end();
      return;
    }
    response.writeHead(404).end();
  };
  return { state, base, handler };
}

/**
 * Legacy SSE fixture with controllable negotiation: optional stalled GET
 * headers, configurable initialize revision, and an endpoint that never
 * answers a call so stream/close behavior can be observed.
 */
function legacySseControlFixture(
  options: Readonly<{
    initProtocol?: string;
    stallHeaders?: boolean;
  }> = {},
) {
  const state = {
    posts: 0,
    calls: 0,
    protocolHeaders: [] as string[],
    getClosed: false,
    released: false,
  };
  const streams = new Set<import("node:http").ServerResponse>();
  const pending: import("node:http").ServerResponse[] = [];
  let releaseStream: (() => void) | undefined;
  const getClosed = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const handler = async (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    if (request.method === "GET") {
      if (options.stallHeaders) {
        // Never send response headers; the client's negotiation must time out
        // and abort this socket.
        request.on("close", () => {
          state.getClosed = true;
          releaseStream?.();
        });
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      streams.add(response);
      request.on("close", () => {
        streams.delete(response);
        state.getClosed = true;
        releaseStream?.();
      });
      response.write("event: endpoint\ndata: /messages?session=s1\n\n");
      return;
    }
    if (request.method === "POST") {
      state.posts += 1;
      const protocol = request.headers["mcp-protocol-version"];
      if (typeof protocol === "string") state.protocolHeaders.push(protocol);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(await readBody(request)) as Record<
          string,
          unknown
        >;
      } catch {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(202).end();
      if (message.id === undefined) return;
      if (message.method === "initialize") {
        for (const stream of streams)
          stream.write(
            `event: message\ndata: ${result(message.id, {
              ...initResult,
              ...(options.initProtocol === undefined
                ? {}
                : { protocolVersion: options.initProtocol }),
            })}\n\n`,
          );
        return;
      }
      if (message.method === "tools/list") {
        for (const stream of streams)
          stream.write(
            `event: message\ndata: ${result(message.id, { tools })}\n\n`,
          );
        return;
      }
      // tools/call: hold forever so a pending call is observable.
      state.calls += 1;
      pending.push(response);
      return;
    }
    response.writeHead(405).end();
  };
  return {
    state,
    streams,
    handler,
    getClosed,
    endStream: () => {
      state.released = true;
      for (const response of streams) response.end();
    },
  };
}

/**
 * Legacy HTTP+SSE fixture: one GET event stream announces a same-origin POST
 * endpoint; responses are pushed onto that stream and routed by JSON-RPC id.
 */
function legacySseFixture(originOverride?: string) {
  const state = { posts: 0, calls: 0, authSeen: [] as string[] };
  const streams = new Set<import("node:http").ServerResponse>();
  const handler = async (
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    const auth = request.headers.authorization;
    if (typeof auth === "string") state.authSeen.push(auth);
    if (request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      streams.add(response);
      request.on("close", () => streams.delete(response));
      const endpoint = `${originOverride ?? ""}/messages?session=s1`;
      response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      return;
    }
    if (request.method === "POST") {
      state.posts += 1;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(await readBody(request)) as Record<
          string,
          unknown
        >;
      } catch {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(202).end();
      if (message.id === undefined) return;
      const id = message.id;
      let payload: string | undefined;
      if (message.method === "tools/call") {
        state.calls += 1;
        const params = message.params as { arguments?: { text?: unknown } };
        payload = callResult(id, String(params?.arguments?.text ?? ""));
      } else if (message.method === "tools/list") {
        payload = result(id, { tools });
      } else if (message.method === "initialize") {
        payload = result(id, initResult);
      }
      if (payload !== undefined)
        for (const stream of streams)
          stream.write(`event: message\ndata: ${payload}\n\n`);
      return;
    }
    response.writeHead(405).end();
  };
  return { state, streams, handler };
}

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "forge-remote-mcp-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

const open: {
  server: Server;
  service: Awaited<ReturnType<typeof createMcpService>>;
}[] = [];

afterEach(async () => {
  for (const entry of open.splice(0))
    await entry.service.dispose().catch(() => undefined);
  for (const entry of servers.splice(0)) await close(entry);
});

const servers: Server[] = [];

async function service(): Promise<
  Awaited<ReturnType<typeof createMcpService>>
> {
  const value = await createMcpService({ home });
  return value;
}

describe("remote registration validation", () => {
  it("accepts an explicit remote transport with credential-free URL", () => {
    const parsed = mcpRegisterAnyInputSchema.parse({
      id: "remote",
      label: "Remote",
      transport: "http",
      url: "http://127.0.0.1:1234/mcp",
    });
    expect(parsed.transport).toBe("http");
    const config = mcpRemoteServerConfigSchema.parse({
      ...parsed,
      enabled: false,
      requestTimeoutMs: 15000,
    });
    expect(config.transport).toBe("http");
  });

  it.each([
    [
      "userinfo",
      { transport: "http", url: "http://user:pass@127.0.0.1:1/mcp" },
    ],
    ["non-http", { transport: "http", url: "ftp://127.0.0.1/mcp" }],
    ["fragment", { transport: "http", url: "http://127.0.0.1:1/mcp#x" }],
    ["relative", { transport: "http", url: "/mcp" }],
  ])("rejects %s remote URLs", (_name, extra) => {
    expect(() =>
      mcpRegisterAnyInputSchema.parse({
        id: "bad",
        label: "Bad",
        ...extra,
      }),
    ).toThrow();
  });

  it("rejects reserved or injected headers", () => {
    for (const headers of [
      { host: "evil" },
      { "content-length": "1" },
      { "mcp-session-id": "x" },
      { authorization: "a\r\nInjected: 1" },
    ]) {
      expect(() =>
        mcpRegisterAnyInputSchema.parse({
          id: "bad",
          label: "Bad",
          transport: "http",
          url: "http://127.0.0.1:1/mcp",
          headers,
        }),
      ).toThrow();
    }
  });

  it("keeps legacy stdio registration working unchanged", () => {
    const parsed = mcpRegisterAnyInputSchema.parse({
      id: "legacy",
      label: "Legacy",
      command: "node",
      args: ["server.mjs"],
    });
    expect(parsed.transport).toBeUndefined();
    expect("url" in parsed).toBe(false);
  });
});

describe("URL and session helpers", () => {
  it("keeps negotiated endpoints on the registered origin", () => {
    const base = new URL("http://127.0.0.1:4000/sse");
    expect(sameOriginEndpoint(base, "/messages")?.href).toBe(
      "http://127.0.0.1:4000/messages",
    );
    expect(
      sameOriginEndpoint(base, "http://127.0.0.1:4001/messages"),
    ).toBeUndefined();
    expect(
      sameOriginEndpoint(base, "https://127.0.0.1:4000/messages"),
    ).toBeUndefined();
  });
  it("bounds session ids", () => {
    expect(validSessionId("abc-123")).toBe(true);
    expect(validSessionId("")).toBe(false);
    expect(validSessionId("bad\nid")).toBe(false);
    expect(validSessionId("x".repeat(600))).toBe(false);
  });
});

describe("Streamable HTTP transport", () => {
  it("registers without contacting the endpoint, then initialize/list/call and hide headers", async () => {
    const fixture = streamableFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    const registered = await mcp.register({
      id: "http",
      label: "HTTP remote",
      transport: "http",
      url: `${listening.base}/mcp`,
      headers: { Authorization: "Bearer super-secret-token" },
      enabled: true,
    });
    // Registration is side-effect free: the endpoint was never contacted.
    expect(fixture.state.posts).toBe(0);
    expect(registered.transport).toBe("http");
    expect(registered.url).toBe(`${listening.base}/mcp`);
    expect(registered.hasPrivateHeaders).toBe(true);
    expect(registered.headerCount).toBe(1);
    // Public catalog never exposes header names or values.
    const listed = JSON.stringify(await mcp.list());
    expect(listed).not.toContain("super-secret-token");
    expect(listed).not.toContain("Authorization");
    expect(JSON.stringify(registered)).not.toContain("super-secret-token");

    const health = await mcp.health("http");
    expect(health.connected).toBe(true);
    expect(health.negotiatedProtocolVersion).toBe("2025-11-25");
    // The private header reached the server and a session id was adopted.
    expect(fixture.state.authSeen).toContain("Bearer super-secret-token");
    expect(fixture.state.sessions).toContain("session-1");

    const discovered = await mcp.listTools("http");
    expect(discovered.map((tool) => tool.name)).toEqual(["echo"]);
    const called = await mcp.callTool("http", "echo", { text: "hello" });
    expect(called.text).toBe("hello");
    expect(called.isError).toBe(false);
    expect(fixture.state.calls).toBe(1);
  });

  it("accepts text/event-stream POST responses and routes by id", async () => {
    const fixture = streamableFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "sse-response",
      label: "SSE POST response",
      transport: "http",
      url: `${listening.base}/mcp`,
      enabled: true,
    });
    const called = await mcp.callTool("sse-response", "echo", {
      text: "framed",
    });
    expect(called.text).toBe("framed");
    expect(fixture.state.calls).toBe(1);
  });

  it("answers server-triggered requests with method-not-found instead of executing anything", async () => {
    const fixture = streamableFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "server-request",
      label: "Server request",
      transport: "http",
      url: `${listening.base}/mcp`,
      enabled: true,
    });
    const called = await mcp.callTool("server-request", "server_request", {
      text: "kept",
    });
    expect(called.text).toBe("kept");
    expect(fixture.state.serverRequests).toBe(1);
    // The client reply is sent on a separate POST; wait for it to arrive.
    await until(() => fixture.state.replyErrors.length > 0);
    expect(fixture.state.replyErrors[0]).toMatchObject({ code: -32601 });
  });

  it("rejects malformed and oversized frames and closes the connection", async () => {
    for (const [tool, id] of [
      ["malformed", "bad-malformed"],
      ["oversized", "bad-oversized"],
      ["wrong_content", "bad-content"],
    ] as const) {
      const fixture = streamableFixture();
      const listening = await listen(fixture.handler);
      servers.push(listening.server);
      const mcp = await service();
      open.push({ server: listening.server, service: mcp });
      await mcp.register({
        id,
        label: "Bad frame",
        transport: "http",
        url: `${listening.base}/mcp`,
        enabled: true,
      });
      await expect(mcp.callTool(id, tool, {})).rejects.toBeInstanceOf(Error);
    }
  });

  it("refuses redirects instead of following them", async () => {
    const target = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(result(1, initResult));
    });
    servers.push(target.server);
    const source = await listen((_request, response) => {
      response.writeHead(307, { location: `${target.base}/elsewhere` });
      response.end();
    });
    servers.push(source.server);
    const mcp = await service();
    open.push({ server: source.server, service: mcp });
    await mcp.register({
      id: "redirect",
      label: "Redirect",
      transport: "http",
      url: `${source.base}/mcp`,
      enabled: true,
    });
    await expect(mcp.listTools("redirect")).rejects.toMatchObject({
      code: "tool",
    });
  });
});

describe("legacy SSE transport", () => {
  it("negotiates a same-origin POST endpoint and routes responses by id", async () => {
    const fixture = legacySseFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "legacy",
      label: "Legacy SSE",
      transport: "sse",
      url: `${listening.base}/sse`,
      headers: { Authorization: "Bearer legacy-token" },
      enabled: true,
    });
    const health = await mcp.health("legacy");
    expect(health.connected).toBe(true);
    expect(fixture.state.authSeen).toContain("Bearer legacy-token");
    const discovered = await mcp.listTools("legacy");
    expect(discovered.map((tool) => tool.name)).toEqual(["echo"]);
    const called = await mcp.callTool("legacy", "echo", {
      text: "legacy-hello",
    });
    expect(called.text).toBe("legacy-hello");
    expect(fixture.state.calls).toBe(1);
  });

  it("rejects a cross-origin negotiated endpoint", async () => {
    const other = await listen((_request, response) => {
      response.writeHead(202).end();
    });
    servers.push(other.server);
    const fixture = legacySseFixture(`${other.base}/messages`);
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "cross-origin",
      label: "Cross origin",
      transport: "sse",
      url: `${listening.base}/sse`,
      enabled: true,
    });
    await expect(mcp.health("cross-origin")).resolves.toMatchObject({
      connected: false,
    });
  });

  it("terminates the stream on a malformed response frame", async () => {
    const streams = new Set<import("node:http").ServerResponse>();
    const listening = await listen(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        streams.add(response);
        request.on("close", () => streams.delete(response));
        response.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      const message = JSON.parse(await readBody(request)) as {
        id?: unknown;
        method?: string;
      };
      response.writeHead(202).end();
      if (message.id === undefined) return;
      if (message.method === "initialize")
        for (const stream of streams)
          stream.write(
            `event: message\ndata: ${result(message.id, initResult)}\n\n`,
          );
      else
        for (const stream of streams)
          stream.write("event: message\ndata: {broken-json\n\n");
    });
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "sse-bad",
      label: "SSE bad frame",
      transport: "sse",
      url: `${listening.base}/sse`,
      enabled: true,
    });
    await mcp.health("sse-bad");
    await expect(mcp.listTools("sse-bad")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("lifecycle: cancellation, disable and revoke", () => {
  it("cancels a pending call, never replays it, and disable/remove close live streams", async () => {
    const fixture = streamableFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "cancel",
      label: "Cancel",
      transport: "http",
      url: `${listening.base}/mcp`,
      enabled: true,
    });
    // Establish the connection first.
    await mcp.listTools("cancel");
    const controller = new AbortController();
    const pending = mcp.callTool(
      "cancel",
      "slow",
      {},
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.state.calls).toBe(1);
    // Wait a moment: no automatic replay may occur.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fixture.state.calls).toBe(1);

    const disabled = await mcp.setEnabled("cancel", false);
    expect(disabled.enabled).toBe(false);
    await expect(mcp.listTools("cancel")).rejects.toMatchObject({
      code: "tool",
    });

    await mcp.setEnabled("cancel", true);
    await mcp.listTools("cancel");
    // revoke() actively terminates a live in-flight operation; a later
    // explicitly enabled effect may still reconnect (it is not a disable).
    const slow = mcp.callTool("cancel", "slow", {});
    await until(() => fixture.state.calls === 2);
    await mcp.revoke("cancel");
    await expect(slow).rejects.toMatchObject({ code: "tool" });
    expect(fixture.state.calls).toBe(2);
  });

  it("disabled servers never connect and registration stays side-effect free", async () => {
    const fixture = streamableFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "disabled",
      label: "Disabled",
      transport: "http",
      url: `${listening.base}/mcp`,
    });
    await expect(mcp.listTools("disabled")).rejects.toMatchObject({
      code: "tool",
    });
    await expect(mcp.health("disabled")).resolves.toMatchObject({
      enabled: false,
      connected: false,
    });
    expect(fixture.state.posts).toBe(0);
  });

  it("detects revocation from another service instance before an effect", async () => {
    const fixture = streamableFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const first = await service();
    const second = await service();
    open.push({ server: listening.server, service: first });
    open.push({ server: listening.server, service: second });
    await first.register({
      id: "shared",
      label: "Shared",
      transport: "http",
      url: `${listening.base}/mcp`,
      enabled: true,
    });
    await first.listTools("shared");
    await second.remove("shared");
    await expect(first.listTools("shared")).rejects.toMatchObject({
      code: "tool",
    });
  });
});

describe("lifecycle defects: negotiation, timeouts and cleanup", () => {
  it("times out a legacy SSE GET that never sends response headers", async () => {
    const fixture = legacySseControlFixture({ stallHeaders: true });
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "stalled-headers",
      label: "Stalled headers",
      transport: "sse",
      url: `${listening.base}/sse`,
      requestTimeoutMs: 1000,
      enabled: true,
    });
    const started = Date.now();
    await expect(mcp.health("stalled-headers")).resolves.toMatchObject({
      connected: false,
    });
    expect(Date.now() - started).toBeLessThan(4000);
    // The owned GET stream was actually aborted, not merely abandoned.
    await fixture.getClosed;
    expect(fixture.state.getClosed).toBe(true);
  });

  it("times out a streamable HTTP initialized notification that never answers", async () => {
    const fixture = streamableFixture();
    fixture.state.stallInitialized = true;
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "stalled-init",
      label: "Stalled init",
      transport: "http",
      url: `${listening.base}/mcp`,
      requestTimeoutMs: 1000,
      enabled: true,
    });
    const started = Date.now();
    await expect(mcp.health("stalled-init")).resolves.toMatchObject({
      connected: false,
    });
    expect(Date.now() - started).toBeLessThan(4000);
    // No retry/replay: initialize and the notification were each sent once.
    expect(fixture.state.posts).toBe(2);
  });

  it("times out a legacy SSE POST notification that never answers", async () => {
    let holdNotification = true;
    const streams = new Set<import("node:http").ServerResponse>();
    const listening = await listen(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        streams.add(response);
        request.on("close", () => streams.delete(response));
        response.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      const message = JSON.parse(await readBody(request)) as {
        id?: unknown;
        method?: string;
      };
      if (message.method === "notifications/initialized" && holdNotification) {
        holdNotification = false;
        return; // Never send response headers.
      }
      response.writeHead(202).end();
      if (message.method === "initialize")
        for (const stream of streams)
          stream.write(
            `event: message\ndata: ${result(message.id, initResult)}\n\n`,
          );
    });
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "stalled-sse-post",
      label: "Stalled SSE POST",
      transport: "sse",
      url: `${listening.base}/sse`,
      requestTimeoutMs: 1000,
      enabled: true,
    });
    const started = Date.now();
    await expect(mcp.health("stalled-sse-post")).resolves.toMatchObject({
      connected: false,
    });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("shuts down pending calls promptly when the ready SSE stream ends", async () => {
    const fixture = legacySseControlFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "sse-eof",
      label: "SSE EOF",
      transport: "sse",
      url: `${listening.base}/sse`,
      requestTimeoutMs: 30000,
      enabled: true,
    });
    await mcp.listTools("sse-eof");
    const pending = mcp.callTool("sse-eof", "echo", {});
    await until(() => fixture.state.calls === 1);
    const started = Date.now();
    // Server closes the ready event stream while the call is pending.
    fixture.endStream();
    await expect(pending).rejects.toMatchObject({ code: "tool" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("joins owned requests on dispose with no leftover DELETE or open request", async () => {
    const fixture = streamableFixture();
    const listening = await listen(fixture.handler);
    servers.push(listening.server);
    const mcp = await service();
    await mcp.register({
      id: "dispose",
      label: "Dispose",
      transport: "http",
      url: `${listening.base}/mcp`,
      requestTimeoutMs: 30000,
      enabled: true,
    });
    await mcp.listTools("dispose");
    const pending = mcp.callTool("dispose", "slow", {});
    await until(() => fixture.state.calls === 1);
    const started = Date.now();
    await mcp.dispose();
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(3000);
    // The held POST was aborted and the server-side request closed.
    await until(() => fixture.state.active === 0);
    expect(fixture.state.deletes).toBe(0);
  });

  it("uses the negotiated legacy protocol version and rejects unsupported ones", async () => {
    const legacy = legacySseControlFixture({ initProtocol: "2024-11-05" });
    const listening = await listen(legacy.handler);
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "legacy-version",
      label: "Legacy version",
      transport: "sse",
      url: `${listening.base}/sse`,
      enabled: true,
    });
    await expect(mcp.health("legacy-version")).resolves.toMatchObject({
      connected: true,
      negotiatedProtocolVersion: "2024-11-05",
    });
    // Later POSTs carry the negotiated revision, not the advertised one.
    await mcp.listTools("legacy-version");
    expect(legacy.state.protocolHeaders).toContain("2024-11-05");

    const unsupported = streamableFixture({ initProtocol: "2099-01-01" });
    const other = await listen(unsupported.handler);
    servers.push(other.server);
    const second = await service();
    open.push({ server: other.server, service: second });
    await second.register({
      id: "unsupported-version",
      label: "Unsupported",
      transport: "http",
      url: `${other.base}/mcp`,
      enabled: true,
    });
    await expect(second.health("unsupported-version")).resolves.toMatchObject({
      connected: false,
    });
  });

  it("does not wait for a response body when POSTing a JSON-RPC response", async () => {
    // Server sends a server-triggered request, then expects a client reply.
    // The reply POST returns 200 with no body: if the client mistook the reply's
    // numeric id for an outgoing request it would wait for a response body,
    // fail on the empty payload, and tear the connection down.
    let replySeen = false;
    const listening = await listen(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(await readBody(request)) as {
        id?: unknown;
        method?: string;
      };
      const json = (payload: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (message.method === "initialize")
        return json({ jsonrpc: "2.0", id: message.id, result: initResult });
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list")
        return json({ jsonrpc: "2.0", id: message.id, result: { tools } });
      if (message.method === "tools/call") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const id = message.id;
        // Server-triggered request followed by the real result. The client
        // must reply on a separate POST whose response has no body.
        response.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            method: "sampling/createMessage",
            params: {},
          })}\n\n`,
        );
        response.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "reply-ok" }] },
          })}\n\n`,
        );
        response.end();
        return;
      }
      // Reply to the server-triggered request: 200, empty body.
      replySeen = true;
      response.writeHead(200).end();
    });
    servers.push(listening.server);
    const mcp = await service();
    open.push({ server: listening.server, service: mcp });
    await mcp.register({
      id: "reply-body",
      label: "Reply body",
      transport: "http",
      url: `${listening.base}/mcp`,
      requestTimeoutMs: 3000,
      enabled: true,
    });
    const called = await mcp.callTool("reply-body", "echo", {});
    expect(called.text).toBe("reply-ok");
    await until(() => replySeen);
    // The empty reply body did not tear the connection down.
    await expect(mcp.health("reply-body")).resolves.toMatchObject({
      connected: true,
    });
  });

  it("accepts every published protocol version", async () => {
    for (const version of [
      "2024-11-05",
      "2025-03-26",
      "2025-06-18",
      "2025-11-25",
    ]) {
      const fixture = streamableFixture({ initProtocol: version });
      const listening = await listen(fixture.handler);
      servers.push(listening.server);
      const mcp = await service();
      open.push({ server: listening.server, service: mcp });
      await mcp.register({
        id: `version-${version}`,
        label: version,
        transport: "http",
        url: `${listening.base}/mcp`,
        enabled: true,
      });
      await expect(mcp.health(`version-${version}`)).resolves.toMatchObject({
        connected: true,
        negotiatedProtocolVersion: version,
      });
    }
  });
});
