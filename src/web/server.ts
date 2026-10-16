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
import {
  type RpcRequest,
  type RpcResponse,
  type RunEvent,
  rpcRequestSchema,
} from "../shared/ipc";

const COOKIE = "forge_web_dev";
const MAX_BODY = 1024 * 1024;
const LEASE_MS = 20_000;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const ackSchema = z.object({ cursor: z.number().int().nonnegative() }).strict();

async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request too large");
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
  const cookie = randomBytes(32).toString("hex");
  const authority = `${options.host}:${options.port}`;
  const origin = `http://${authority}`;
  let authenticatedUntil = 0;
  let clientId = "";
  let lastHeartbeat = 0;
  let eventSocket: WebSocket | undefined;
  let sequence = 0;
  let bytes = 0;
  let overflow = false;
  const events: { cursor: number; data: RunEvent; bytes: number }[] = [];
  const pending = new Map<string, (response: RpcResponse) => void>();
  const requestIds = new Set<string>();
  const controller = createWorkerController(options.service, (message) => {
    if (message.kind === "response") {
      pending.get(message.response.id)?.(message.response);
    } else if (message.kind === "event") {
      const length = Buffer.byteLength(JSON.stringify(message.data));
      events.push({ cursor: ++sequence, data: message.data, bytes: length });
      bytes += length;
      if (events.length > 5000 || bytes > MAX_EVENT_BYTES) {
        overflow = true;
        events.length = 0;
        bytes = 0;
        eventSocket?.close(1013, "Event buffer exceeded");
      } else sendEvents([message.data]);
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
  function sendEvents(batch: RunEvent[]): void {
    const socket = eventSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_EVENT_BYTES) {
      overflow = true;
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
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor === null ? Number.NaN : Number(rawCursor);
    const oldest = events[0]?.cursor ?? sequence + 1;
    if (
      !clientId ||
      url.searchParams.get("clientId") !== clientId ||
      !Number.isSafeInteger(cursor) ||
      cursor < oldest - 1 ||
      cursor > sequence ||
      overflow ||
      request.headers["sec-websocket-protocol"]
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      eventSocket?.close(4001, "Connection replaced");
      eventSocket = ws;
      lastHeartbeat = Date.now();
      const owner = clientId;
      const ownsConnection = () => eventSocket === ws && owner === clientId;
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        if (eventSocket === ws) eventSocket = undefined;
      });
      ws.on("pong", () => {
        if (ownsConnection()) lastHeartbeat = Date.now();
      });
      ws.on("message", (data, binary) => {
        if (!ownsConnection()) return ws.close(4001, "Control changed");
        try {
          const ack = ackSchema.parse(JSON.parse(data.toString()));
          if (binary || ack.cursor > sequence)
            return ws.close(1008, "Invalid cursor");
          while (events[0] && events[0].cursor <= ack.cursor) {
            const entry = events.shift();
            if (entry) bytes -= entry.bytes;
          }
        } catch {
          ws.close(1008, "Invalid acknowledgement");
        }
      });
      sendEvents(
        events
          .filter((entry) => entry.cursor > cursor)
          .map((entry) => entry.data),
      );
    });
  });
  const heartbeat = setInterval(() => {
    if (!eventSocket) return;
    if (
      Date.now() >= authenticatedUntil ||
      Date.now() - lastHeartbeat > LEASE_MS
    )
      eventSocket.terminate();
    else if (eventSocket.readyState === WebSocket.OPEN) eventSocket.ping();
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
        const input = await body(request);
        if (path === "/api/connect") {
          clientId = "";
          eventSocket?.close(4001, "Another page took control");
          eventSocket = undefined;
          clientId = randomUUID();
          lastHeartbeat = 0;
          events.length = 0;
          bytes = 0;
          overflow = false;
          return json(response, 200, { workspace, cursor: sequence, clientId, recovery: controller.recoveryEvents() });
        }
        if (!clientId || request.headers["x-forge-client"] !== clientId)
          return json(response, 409, {
            error: "Another page has taken control. Reload to reconnect.",
          });
        if (path === "/api/events") {
          return json(response, 426, {
            error: "WebSocket required; reload the page.",
          });
        }
        if (path === "/api/connection") {
          const { cursor } = ackSchema.parse(input);
          const oldest = events[0]?.cursor ?? sequence + 1;
          return json(response, 200, { resumable: !overflow && cursor >= oldest - 1 && cursor <= sequence });
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
          if ((await realpath(session.workspace)) !== workspace)
            return json(response, 403, {
              error: "Session belongs to another workspace",
            });
        }
        // Workspace lookups above yield: recheck ownership before any effects.
        if (!clientId || request.headers["x-forge-client"] !== clientId)
          return json(response, 409, {
            error: "Control changed; request not executed",
          });
        if (
          rpc.method === "startRun" &&
          (overflow ||
            eventSocket?.readyState !== WebSocket.OPEN ||
            Date.now() - lastHeartbeat > LEASE_MS)
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
        const result = await dispatch(rpc);
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
