import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { DesktopRuntime } from "../desktop/runtime";
import { createRuntimeHub } from "../desktop/runtime";
import type { HarnessService } from "../shared/contracts";
import {
  HTML_PREVIEW_CSP,
  htmlPreviewRequestSchema,
  htmlPreviewResponseSchema,
} from "../shared/html-preview";
import {
  type RpcRequest,
  type RpcResponse,
  type RunEvent,
  rpcRequestSchema,
} from "../shared/ipc";
import type { SessionSnapshot } from "../shared/schemas";
import { workspaceBrowseRequestSchema } from "../shared/workspaces";
import {
  HtmlPreviewStore,
  PreviewFileError,
  readPreviewFile,
} from "./html-preview";
import { SessionDeltaCache } from "./session-delta";
import { createStaticRenderer } from "./static";
import { WorkspaceBrowseError, browseWorkspaceDirectory } from "./workspaces";

const MAX_BODY = 1024 * 1024;
const MAX_RPC_BODY = 16 * 1024 * 1024;
// JSON escaping can inflate an inline HTML preview past the default 1 MiB.
const MAX_PREVIEW_BODY = 4 * 1024 * 1024;
const LEASE_MS = 20_000;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const ackSchema = z.object({ cursor: z.number().int().nonnegative() }).strict();
const previewPathSchema = z
  .object({ path: z.string().min(1).max(4096) })
  .strict()
  .readonly();
const previewDocumentSchema = z
  .object({ id: z.string().regex(/^[0-9a-f]{48}$/) })
  .strict()
  .readonly();
const desktopOnly = new Set([
  "chooseWorkspace",
  "openExternal",
  "exportSession",
  "savePublishedFile",
]);

async function body(
  request: IncomingMessage,
  limit = MAX_BODY,
): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

interface WebHostOptions {
  workspace: string;
  host: string;
  port: number;
  /**
   * `true` (default) is the single-workspace Web/standalone behavior: sessions
   * and launches must belong to the launch workspace. `false` is the desktop
   * multi-workspace mode where the same service already governs many projects.
   */
  restrictWorkspace?: boolean;
  /** Built renderer (`dist/renderer`) served for packaged LAN hosting. */
  rendererRoot?: string;
}

/**
 * HTTP/WebSocket front end over one shared controller runtime.
 *
 * The runtime is injected when a desktop worker already owns it (LAN hosting);
 * otherwise this host creates and owns it. `close()` never disposes an injected
 * runtime, because the desktop or another Web page may still be using it.
 */
export async function createWebHost(
  options: WebHostOptions &
    (
      | { service: HarnessService; runtime?: undefined }
      | { runtime: DesktopRuntime; service?: undefined }
    ),
) {
  const restrictWorkspace = options.restrictWorkspace !== false;
  const requested = resolve(options.workspace);
  // The restricted mode keeps the original strict realpath contract; the
  // multi-workspace mode must still start if the launch folder was renamed.
  const workspace = restrictWorkspace
    ? await realpath(requested)
    : await realpath(requested).catch(() => requested);
  const sessionDeltas = new SessionDeltaCache();
  const previews = new HtmlPreviewStore();
  const renderer = options.rendererRoot
    ? await createStaticRenderer({ rendererRoot: options.rendererRoot })
    : undefined;
  const authority = `${options.host}:${options.port}`;
  const origin = `http://${authority}`;
  let sequence = 0;
  let bytes = 0;
  const events: { cursor: number; data: RunEvent; bytes: number }[] = [];
  const clients = new Map<
    string,
    { socket: WebSocket | undefined; heartbeat: number; lastSeen: number }
  >();
  const requestIds = new Set<string>();
  const injected = options.runtime;
  const runtime: DesktopRuntime = injected ?? createRuntimeHub(options.service);
  const ownsRuntime = injected === undefined;
  const unsubscribe = runtime.subscribe((message) => {
    if (message.kind !== "event") return;
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
  });
  const sendTo = (socket: WebSocket, batch: RunEvent[]): void => {
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
    for (const client of clients.values())
      if (client.socket) sendTo(client.socket, batch);
  }
  // Keep both event and Vite HMR sockets restricted to the launch origin.
  server.on("upgrade", (request, socket, head) => {
    if (!validHost(request) || request.headers.origin !== origin) {
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
      if (client.socket) {
        if (now - client.heartbeat > LEASE_MS) client.socket.terminate();
        else if (client.socket.readyState === WebSocket.OPEN)
          client.socket.ping();
      }
      if (now - client.lastSeen > 12 * 60 * 60 * 1000) clients.delete(id);
    }
  }, 5000);
  heartbeat.unref();

  // Authorization probes are ordinary runtime reads with their own ids; they
  // never reuse a page request id, so the no-replay contract is untouched.
  const snapshotOf = async (
    sessionId: Parameters<HarnessService["getSession"]>[0],
  ) => {
    const response = await runtime
      .request({
        id: randomUUID(),
        method: "getSession",
        sessionId,
      } as RpcRequest)
      .catch(() => undefined);
    return response?.ok && response.method === "getSession"
      ? (response.result as SessionSnapshot)
      : undefined;
  };
  const inWorkspace = async (candidate: string): Promise<boolean> => {
    try {
      return (await realpath(resolve(candidate))) === workspace;
    } catch {
      return false;
    }
  };

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
      try {
        const input = await body(
          request,
          path === "/api/rpc"
            ? MAX_RPC_BODY
            : path === "/api/preview"
              ? MAX_PREVIEW_BODY
              : MAX_BODY,
        );
        if (path === "/api/connect") {
          const clientId = randomUUID();
          clients.set(clientId, {
            socket: undefined,
            heartbeat: 0,
            lastSeen: Date.now(),
          });
          return json(response, 200, {
            workspace,
            restrictWorkspace,
            cursor: sequence,
            clientId,
            recovery: runtime.recoveryEvents(),
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
        if (path === "/api/preview") {
          const { html } = htmlPreviewRequestSchema.parse(input);
          client.lastSeen = Date.now();
          return json(
            response,
            200,
            htmlPreviewResponseSchema.parse({ url: previews.put(html) }),
          );
        }
        if (path === "/api/preview/file") {
          // The preview protocol carries a workspace-relative path but no
          // session id, so a multi-workspace host cannot tell which project a
          // page means. Refuse rather than silently read the launch project.
          if (!restrictWorkspace)
            return json(response, 403, {
              error:
                "File previews are not available while hosting multiple workspaces; attach the file to the conversation instead.",
            });
          const { path: relative } = previewPathSchema.parse(input);
          client.lastSeen = Date.now();
          let html: string;
          try {
            html = await readPreviewFile(workspace, relative);
          } catch (error) {
            if (error instanceof PreviewFileError)
              return json(response, error.status, { error: error.message });
            return json(response, 404, {
              error: "The file is not available for preview.",
            });
          }
          return json(
            response,
            200,
            htmlPreviewResponseSchema.parse({ url: previews.put(html) }),
          );
        }
        // Read-only server directory browsing for multi-workspace hosts. The
        // restricted host already answers with its own single workspace, so it
        // must never enumerate the filesystem.
        if (path === "/api/workspaces/browse") {
          if (restrictWorkspace)
            return json(response, 403, {
              error:
                "Directory browsing is not available while hosting a single workspace.",
            });
          const browse = workspaceBrowseRequestSchema.safeParse(input);
          if (!browse.success)
            return json(response, 400, { error: "Expected an absolute path." });
          client.lastSeen = Date.now();
          try {
            return json(
              response,
              200,
              await browseWorkspaceDirectory(workspace, browse.data.path),
            );
          } catch (error) {
            if (error instanceof WorkspaceBrowseError)
              return json(response, error.status, { error: error.message });
            return json(response, 500, {
              error: "The directory could not be listed.",
            });
          }
        }
        // Address discovery only: a paired page learns the origin it is already
        // talking to. There is no password, token or secret in this response.
        if (path === "/api/pairing") {
          client.lastSeen = Date.now();
          return json(response, 200, { url: origin, workspace });
        }
        if (path !== "/api/rpc")
          return json(response, 404, { error: "Not found" });
        const parsed = rpcRequestSchema.safeParse(input);
        if (!parsed.success)
          return json(response, 400, { error: "Invalid RPC request" });
        const rpc = parsed.data;
        if (desktopOnly.has(rpc.method))
          return json(response, 403, { error: "Desktop-only operation" });
        let authorizedSnapshot: SessionSnapshot | undefined;
        if (restrictWorkspace) {
          if (
            rpc.method === "createSession" &&
            !(await inWorkspace(rpc.input.workspace))
          )
            return json(response, 403, {
              error: "This server is restricted to its launch workspace",
            });
          if ("sessionId" in rpc || rpc.method === "startRun" || rpc.method === "enqueueInput") {
            const id =
              rpc.method === "startRun"
                ? rpc.input.sessionId
                : rpc.method === "enqueueInput" ? rpc.input.input.sessionId : (
                    rpc as {
                      sessionId: Parameters<HarnessService["getSession"]>[0];
                    }
                  ).sessionId;
            const session = await snapshotOf(id);
            if (!session)
              return json(response, 403, {
                error: "The session could not be authorized",
              });
            authorizedSnapshot = session;
            if (!(await inWorkspace(session.workspace)))
              return json(response, 403, {
                error: "Session belongs to another workspace",
              });
          }
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
        const result: RpcResponse =
          rpc.method === "getSession" && authorizedSnapshot
            ? {
                id: rpc.id,
                ok: true,
                method: rpc.method,
                result: authorizedSnapshot,
              }
            : await runtime.request(rpc);
        if (result.ok && result.method === "getSession") {
          const base = request.headers["x-forge-snapshot"];
          const update = sessionDeltas.encode(
            result.result,
            typeof base === "string" ? base : undefined,
          );
          response.setHeader("X-Forge-Snapshot", update.revision);
          if (update.delta)
            return json(response, 200, {
              ...result,
              result: { sessionDelta: update.delta },
            });
        }
        if (result.ok && result.method === "getHostState" && restrictWorkspace) {
          const visible = await Promise.all(result.result.runs.map(async run => {
            const session = await snapshotOf(run.sessionId);
            return session && await inWorkspace(session.workspace) ? run : undefined;
          }));
          return json(response, 200, { ...result, result: { ...result.result, runs: visible.filter(Boolean) } });
        }
        if (
          result.ok &&
          result.method === "listSessions" &&
          restrictWorkspace
        ) {
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
    if (path === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (path === "/preview/document") {
      const query = new URL(request.url ?? "/", origin).searchParams;
      const parsed = previewDocumentSchema.safeParse({ id: query.get("id") });
      const html = parsed.success ? previews.get(parsed.data.id) : undefined;
      if (html === undefined)
        return json(response, 404, { error: "Preview document expired" });
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": HTML_PREVIEW_CSP,
        // The workbench itself keeps DENY; only a preview document may be framed.
        "X-Frame-Options": "SAMEORIGIN",
      });
      response.end(html);
      return;
    }
    // The packaged React renderer, only from the build output directory.
    if (renderer && (await renderer.handle(request, response, origin))) return;
    next();
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    clearInterval(heartbeat);
    unsubscribe();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    const listenerClosed = new Promise<void>((done) => server.close(() => done()));
    closing = (async () => {
      try {
        if (ownsRuntime) await runtime.dispose();
      } finally {
        await listenerClosed;
        clients.clear();
      }
    })();
    return closing;
  }
  return { server, handle, close, origin, workspace, runtime, ownsRuntime };
}
