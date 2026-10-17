import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { createWorkerController } from "../desktop/controller";
import type { HarnessService } from "../shared/contracts";
import type { SessionSnapshot } from "../shared/schemas";
import { SessionDeltaCache } from "./session-delta";
import {
  type RpcRequest,
  type RpcResponse,
  type RunEvent,
  rpcRequestSchema,
} from "../shared/ipc";

const COOKIE = "forge_web_dev";
const MAX_BODY = 1024 * 1024;
const MAX_RPC_BODY = 16 * 1024 * 1024;
const LEASE_MS = 20_000;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const ackSchema = z.object({ cursor: z.number().int().nonnegative() }).strict();

async function body(request: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export async function createWebHost(options: {
  service: HarnessService;
  workspace: string;
  host: string;
  port: number;
  token?: string;
}) {
  const workspace = await realpath(resolve(options.workspace));
  const token = options.token ?? randomBytes(24).toString("hex");
  const sessionDeltas = new SessionDeltaCache();
  const cookie = randomBytes(32).toString("hex");
  const authority = `${options.host}:${options.port}`;
  const origin = `http://${authority}`;
  let authenticatedUntil = 0;
  let sequence = 0;
  let bytes = 0;
  const events: { cursor: number; data: RunEvent; bytes: number }[] = [];
  const clients = new Map<
    string,
    { socket: WebSocket | undefined; heartbeat: number; lastSeen: number }
  >();
  const pending = new Map<string, (response: RpcResponse) => void>();
  const requestIds = new Set<string>();
  const controller = createWorkerController(options.service, (message) => {
    if (message.kind === "response") {
      pending.get(message.response.id)?.(message.response);
    } else if (message.kind === "event") {
      const length = Buffer.byteLength(JSON.stringify(message.data));
      events.push({ cursor: ++sequence, data: message.data, bytes: length });
      bytes += length;
      while (
        events.length > 0 &&
        (events.length > 5000 || bytes > MAX_EVENT_BYTES)
      ) {
        const dropped = events.shift();
        if (dropped) bytes -= dropped.bytes;
      }
      sendEvents([message.data]);
    }
  });
  async function dispatch(request: RpcRequest): Promise<RpcResponse> {
    return new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(
          new Error(
            "Request timed out; its effects are uncertain. Do not retry automatically.",
          ),
        );
      }, 120_000);
      pending.set(request.id, (response) => {
        clearTimeout(timer);
        pending.delete(request.id);
        resolveResponse(response);
      });
      void controller.handle(request).catch(reject);
    });
  }
  const authenticated = (request: IncomingMessage): boolean => {
    return (
      Date.now() < authenticatedUntil &&
      (request.headers.cookie ?? "")
        .split(";")
        .some((part) => part.trim() === `${COOKIE}=${cookie}`)
    );
  };
  const validHost = (request: IncomingMessage): boolean =>
    request.headers.host === authority;
  const server = createServer();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  function sendTo(socket: WebSocket, batch: RunEvent[]): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_EVENT_BYTES) {
      socket.terminate();
      return;
    }
    socket.send(
      JSON.stringify({ cursor: sequence, events: batch }),
      (error) => {
        if (error) socket.terminate();
      },
    );
  }
  function sendEvents(batch: RunEvent[]): void {
    for (const client of clients.values())
      if (client.socket) sendTo(client.socket, batch);
  }
  // Vite's upgrade handler must never expose the dev websocket without authentication.
  server.on("upgrade", (request, socket, head) => {
    if (
      !validHost(request) ||
      request.headers.origin !== origin ||
      !authenticated(request)
    ) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname !== "/api/events") return;
    const requestedClient = url.searchParams.get("clientId");
    const client = requestedClient ? clients.get(requestedClient) : undefined;
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor === null ? Number.NaN : Number(rawCursor);
    const oldest = events[0]?.cursor ?? sequence + 1;
    if (
      !client ||
      !Number.isSafeInteger(cursor) ||
      cursor < oldest - 1 ||
      cursor > sequence ||
      request.headers["sec-websocket-protocol"]
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      client.socket?.close(4000, "Connection replaced");
      client.socket = ws;
      client.heartbeat = Date.now();
      client.lastSeen = Date.now();
      const owner = requestedClient;
      const ownsConnection = () => {
        const current = owner ? clients.get(owner) : undefined;
        return current?.socket === ws;
      };
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        if (client.socket === ws) client.socket = undefined;
      });
      ws.on("pong", () => {
        if (!ownsConnection()) return;
        client.heartbeat = Date.now();
        client.lastSeen = Date.now();
      });
      ws.on("message", (data, binary) => {
        if (!ownsConnection()) return;
        try {
          const ack = ackSchema.parse(JSON.parse(data.toString()));
          if (binary || ack.cursor > sequence)
            return ws.close(1008, "Invalid cursor");
          client.lastSeen = Date.now();
        } catch {
          ws.close(1008, "Invalid acknowledgement");
        }
      });
      const replay = events
        .filter((entry) => entry.cursor > cursor)
        .map((entry) => entry.data);
      sendTo(ws, replay);
    });
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, client] of clients) {
      if (now >= authenticatedUntil) client.socket?.terminate();
      else if (client.socket) {
        if (now - client.heartbeat > LEASE_MS) client.socket.terminate();
        else if (client.socket.readyState === WebSocket.OPEN)
          client.socket.ping();
      }
      if (now - client.lastSeen > 12 * 60 * 60 * 1000) clients.delete(id);
    }
  }, 5000);
  heartbeat.unref();

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> {
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    if (!validHost(request))
      return json(response, 403, { error: "Unexpected host" });
    const path = request.url?.split("?")[0];
    if (path?.startsWith("/api/")) {
      if (
        request.method !== "POST" ||
        request.headers.origin !== origin ||
        !request.headers["content-type"]?.startsWith("application/json")
      ) {
        return json(response, 403, { error: "Same-origin JSON POST required" });
      }
      if (
        path === "/api/connect" &&
        equal(request.headers.authorization ?? "", `Bearer ${token}`)
      ) {
        authenticatedUntil = Date.now() + 12 * 60 * 60 * 1000;
        response.setHeader(
          "Set-Cookie",
          `${COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
        );
      } else if (!authenticated(request))
        return json(response, 401, { error: "Authentication required" });
      try {
        const input = await body(request, path === "/api/rpc" ? MAX_RPC_BODY : MAX_BODY);
        if (path === "/api/connect") {
          const clientId = randomUUID();
          clients.set(clientId, {
            socket: undefined,
            heartbeat: 0,
            lastSeen: Date.now(),
          });
          return json(response, 200, {
            workspace,
            cursor: sequence,
            clientId,
            recovery: controller.recoveryEvents(),
          });
        }
        const requestedClient = request.headers["x-forge-client"];
        const client =
          typeof requestedClient === "string"
            ? clients.get(requestedClient)
            : undefined;
        if (!requestedClient || !client)
          return json(response, 410, {
            error: "Page connection expired. Reload to reconnect.",
          });
        if (path === "/api/events") {
          return json(response, 426, {
            error: "WebSocket required; reload the page.",
          });
        }
        if (path === "/api/connection") {
          const { cursor } = ackSchema.parse(input);
          const oldest = events[0]?.cursor ?? sequence + 1;
          client.lastSeen = Date.now();
          return json(response, 200, {
            resumable: cursor >= oldest - 1 && cursor <= sequence,
          });
        }
        if (path !== "/api/rpc")
          return json(response, 404, { error: "Not found" });
        const parsed = rpcRequestSchema.safeParse(input);
        if (!parsed.success)
          return json(response, 400, { error: "Invalid RPC request" });
        const rpc = parsed.data;
        if (
          ["chooseWorkspace", "openExternal", "exportSession"].includes(
            rpc.method,
          )
        )
          return json(response, 403, { error: "Desktop-only operation" });
        if (
          rpc.method === "createSession" &&
          (await realpath(resolve(rpc.input.workspace))) !== workspace
        )
          return json(response, 403, {
            error: "This server is restricted to its launch workspace",
          });
        let authorizedSnapshot: SessionSnapshot | undefined;
        if ("sessionId" in rpc || rpc.method === "startRun") {
          const id =
            rpc.method === "startRun"
              ? rpc.input.sessionId
              : (
                  rpc as {
                    sessionId: Parameters<HarnessService["getSession"]>[0];
                  }
                ).sessionId;
          const session = await options.service.getSession(id);
          authorizedSnapshot = session;
          if ((await realpath(session.workspace)) !== workspace)
            return json(response, 403, {
              error: "Session belongs to another workspace",
            });
        }
        // Workspace lookups above yield: recheck ownership before any effects.
        if (
          typeof requestedClient !== "string" ||
          clients.get(requestedClient) !== client
        )
          return json(response, 410, {
            error: "Page connection expired; request not executed",
          });
        client.lastSeen = Date.now();
        if (
          rpc.method === "startRun" &&
          (client.socket?.readyState !== WebSocket.OPEN ||
            Date.now() - client.heartbeat > LEASE_MS)
        )
          return json(response, 409, {
            error: "Event connection expired. Reload before starting a run.",
          });
        if (requestIds.has(rpc.id))
          return json(response, 409, {
            error: "Duplicate request; not replayed",
          });
        requestIds.add(rpc.id);
        const oldestRequest = requestIds.values().next().value;
        if (requestIds.size > 8192 && oldestRequest)
          requestIds.delete(oldestRequest);
        const result = rpc.method === "getSession" && authorizedSnapshot
          ? { id: rpc.id, ok: true as const, method: rpc.method, result: authorizedSnapshot }
          : await dispatch(rpc);
        if (result.ok && result.method === "getSession") {
          const base = request.headers["x-forge-snapshot"];
          const update = sessionDeltas.encode(result.result, typeof base === "string" ? base : undefined);
          response.setHeader("X-Forge-Snapshot", update.revision);
          if (update.delta) return json(response, 200, { ...result, result: { sessionDelta: update.delta } });
        }
        if (result.ok && result.method === "listSessions") {
          return json(response, 200, {
            ...result,
            result: result.result.filter(
              (session) => resolve(session.workspace) === workspace,
            ),
          });
        }
        return json(response, 200, result);
      } catch {
        return json(response, 400, {
          error:
            "The request could not be completed. Effects may be uncertain; inspect state before retrying.",
        });
      }
    }
    if (!authenticated(request)) {
      if (request.method !== "GET" || path !== "/")
        return json(response, 401, { error: "Authentication required" });
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'",
      });
      response.end(
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Forge Web 登录</title><style>body{font:16px system-ui;max-width:520px;margin:12vh auto;padding:24px;background:#f7f5ef;color:#292b26}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin:8px 0}p{line-height:1.6}</style><h1>Forge Web Dev</h1><p>请输入服务启动时打印的访问口令。此页面能操作服务器文件并执行命令，仅限可信局域网使用，请勿向公网开放。</p><form><input type="password" autocomplete="off" required aria-label="访问口令" placeholder="访问口令"><button>连接工作台</button></form><p id="status"></p><script>document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();const s=document.querySelector('#status');s.textContent='连接中…';try{const r=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+document.querySelector('input').value},body:'{}'});if(!r.ok)throw Error();location.reload()}catch{s.textContent='连接失败，请检查口令。'}}</script></html>`,
      );
      return;
    }
    if (path === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    next();
  }
  async function close(): Promise<void> {
    clearInterval(heartbeat);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await controller.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  return { server, handle, close, token, origin, workspace };
}
