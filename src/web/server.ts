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
import { resolveStateDirectory } from "../core/state-directory";
import { createRuntimeHub } from "../host/runtime";
import type { HarnessService } from "../shared/contracts";
import {
  type AuthorizedDevice,
  type DeviceAuthorization,
  pairingExchangeSchema,
} from "../shared/device-authorization";
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
import type { RuntimeHost } from "../shared/runtime-host";
import type { SessionSnapshot } from "../shared/schemas";
import { workspaceBrowseRequestSchema } from "../shared/workspaces";
import { openDeviceAuthorization } from "../store/devices";
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
function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

interface WebHostOptions {
  /** Personal LAN access is direct by default. false is reserved for custom authenticated hosts. */
  trustedLan?: boolean;
  authorization?: DeviceAuthorization;
  stateDir?: string;
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
 * otherwise this host creates and owns it. `close()` only stops publishing and
 * never cancels accepted tasks. Explicit `dispose()` also stops an owned runtime;
 * an injected runtime always remains its caller's responsibility.
 */
export async function createWebHost(
  options: WebHostOptions &
    (
      | { service: HarnessService; runtime?: undefined }
      | { runtime: RuntimeHost; service?: undefined }
    ),
) {
  const trustedLan = options.trustedLan !== false;
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
  const authorization = trustedLan
    ? undefined
    : (options.authorization ??
      (await openDeviceAuthorization({
        directory: resolveStateDirectory(options.stateDir),
      })));
  const ownsAuthorization = !trustedLan && options.authorization === undefined;
  const authority = `${options.host}:${options.port}`;
  const origin = `http://${authority}`;
  let sequence = 0;
  let bytes = 0;
  const events: { cursor: number; data: RunEvent; bytes: number }[] = [];
  interface Client {
    socket: WebSocket | undefined;
    heartbeat: number;
    lastSeen: number;
    deviceId: string | undefined;
    lastSent: number;
    pumping: boolean;
    pending: boolean;
  }
  const clients = new Map<string, Client>();
  let pairingsInFlight = 0;
  let upgradesInFlight = 0;
  const requestIds = new Set<string>();
  const injected = options.runtime;
  const runtime: RuntimeHost = injected ?? createRuntimeHub(options.service);
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
  const sendTo = (
    socket: WebSocket,
    batch: RunEvent[],
    cursor = sequence,
  ): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_EVENT_BYTES) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify({ cursor, events: batch }), (error) => {
      if (error) socket.terminate();
    });
  };
  const validHost = (request: IncomingMessage): boolean =>
    request.headers.host === authority;
  const server = createServer();
  let stopped = false;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  const credentialOf = (request: IncomingMessage): string | undefined => {
    const headers = request.rawHeaders.filter(
      (_value, index) =>
        index % 2 === 0 &&
        request.rawHeaders[index]?.toLowerCase() === "authorization",
    );
    if (headers.length > 1) return undefined;
    const bearer = request.headers.authorization;
    const cookies = (request.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter((item) => item.startsWith("forge_device="));
    if (cookies.length > 1 || (bearer && cookies.length)) return undefined;
    if (bearer)
      return /^Bearer [A-Za-z0-9_.-]+$/.test(bearer)
        ? bearer.slice(7)
        : undefined;
    return cookies[0]?.slice("forge_device=".length);
  };
  const authenticate = (
    request: IncomingMessage,
  ): Promise<AuthorizedDevice | undefined> =>
    authorization?.verify(credentialOf(request) ?? "") ??
    Promise.resolve(undefined);
  const removeClient = (id: string, client: Client) => {
    client.socket?.terminate();
    if (clients.get(id) === client) clients.delete(id);
  };
  const sweep = async () => {
    if (!authorization) return;
    const checks = new Map<string, Promise<boolean>>();
    await Promise.all(
      [...clients].map(async ([id, client]) => {
        if (!client.deviceId) {
          removeClient(id, client);
          return;
        }
        let check = checks.get(client.deviceId);
        if (!check) {
          check = authorization
            .isAuthorized(client.deviceId)
            .catch(() => false);
          checks.set(client.deviceId, check);
        }
        if (!(await check)) removeClient(id, client);
      }),
    );
  };
  const unsubscribeAuthorization = authorization?.subscribe(sweep);
  // One coalescing pump per page, backed by the bounded shared replay ring.
  // Never create an unbounded queue of auth checks/event copies for a slow client.
  const pump = (id: string, client: Client) => {
    client.pending = true;
    if (client.pumping || !authorization) return;
    client.pumping = true;
    void (async () => {
      while (client.pending && clients.get(id) === client && client.socket) {
        client.pending = false;
        const socket = client.socket;
        if (
          !client.deviceId ||
          !(await authorization.isAuthorized(client.deviceId))
        ) {
          removeClient(id, client);
          return;
        }
        if (clients.get(id) !== client || client.socket !== socket) continue;
        if (client.lastSent < (events[0]?.cursor ?? sequence + 1) - 1) {
          socket.close(4009, "Event history expired");
          return;
        }
        const cursor = sequence;
        const batch = events
          .filter(
            (entry) => entry.cursor > client.lastSent && entry.cursor <= cursor,
          )
          .map((entry) => entry.data);
        sendTo(socket, batch, cursor);
        client.lastSent = cursor;
      }
    })()
      .catch(() => removeClient(id, client))
      .finally(() => {
        client.pumping = false;
        if (client.pending && clients.get(id) === client && client.socket)
          pump(id, client);
      });
  };
  function sendEvents(batch: RunEvent[]): void {
    for (const [id, client] of clients)
      if (client.socket) {
        if (trustedLan) sendTo(client.socket, batch);
        else pump(id, client);
      }
  }
  // Keep both event and Vite HMR sockets restricted to the launch origin.
  server.on("upgrade", (request, socket, head) => {
    if (stopped || !validHost(request) || request.headers.origin !== origin) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname !== "/api/events") return;
    if (upgradesInFlight >= 16) {
      socket.destroy();
      return;
    }
    upgradesInFlight++;
    void (async () => {
      const device = trustedLan ? undefined : await authenticate(request);
      if (stopped || (!trustedLan && !device)) {
        socket.destroy();
        return;
      }
      const requestedClient = url.searchParams.get("clientId");
      const client = requestedClient ? clients.get(requestedClient) : undefined;
      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor === null ? Number.NaN : Number(rawCursor);
      const oldest = events[0]?.cursor ?? sequence + 1;
      if (
        !client ||
        (!trustedLan && client.deviceId !== device?.id) ||
        !Number.isSafeInteger(cursor) ||
        cursor < oldest - 1 ||
        cursor > sequence ||
        request.headers["sec-websocket-protocol"] ||
        socket.destroyed
      ) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        client.socket?.close(4000, "Connection replaced");
        client.socket = ws;
        client.heartbeat = Date.now();
        client.lastSeen = Date.now();
        client.lastSent = cursor;
        const owner = requestedClient;
        const ownsConnection = () =>
          (owner ? clients.get(owner) : undefined)?.socket === ws;
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
        if (trustedLan)
          sendTo(
            ws,
            events
              .filter((entry) => entry.cursor > cursor)
              .map((entry) => entry.data),
          );
        else if (owner) pump(owner, client);
      });
    })()
      .catch(() => socket.destroy())
      .finally(() => {
        upgradesInFlight--;
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
    let device: AuthorizedDevice | undefined;
    let protectedRequest = false;
    const authorized = async () => {
      if (stopped) return false;
      if (trustedLan) return true;
      const valid =
        !!device && (await authorization?.isAuthorized(device.id)) === true;
      return !stopped && valid;
    };
    const json = async (
      target: ServerResponse,
      status: number,
      value: unknown,
    ): Promise<void> => {
      if (protectedRequest && status < 400 && !(await authorized())) {
        target.removeHeader("X-Forge-Snapshot");
        return writeJson(target, 401, {
          error: "Device authorization required",
        });
      }
      writeJson(target, status, value);
    };
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    if (stopped) return json(response, 503, { error: "Listener stopped" });
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
      if (path === "/api/pair") {
        if (!authorization || pairingsInFlight >= 8)
          return json(response, 503, { error: "Pairing unavailable" });
        pairingsInFlight++;
        try {
          const input = pairingExchangeSchema.parse(await body(request, 1024));
          const result = await authorization.exchange(input.token);
          response.setHeader(
            "Set-Cookie",
            `forge_device=${result.credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          );
          return json(response, 200, result);
        } catch {
          return json(response, 401, {
            error: "Pairing unavailable or expired",
          });
        } finally {
          pairingsInFlight--;
        }
      }
      device = trustedLan ? undefined : await authenticate(request);
      if (!trustedLan && !device)
        return json(response, 401, { error: "Device authorization required" });
      protectedRequest = true;
      try {
        const input = await body(
          request,
          path === "/api/rpc"
            ? MAX_RPC_BODY
            : path === "/api/preview"
              ? MAX_PREVIEW_BODY
              : MAX_BODY,
        );
        if (!(await authorized()))
          return json(response, 401, {
            error: "Device authorization required",
          });
        if (path === "/api/connect") {
          if (clients.size >= 1024)
            return json(response, 503, {
              error: "Page connection limit reached",
            });
          const clientId = randomUUID();
          clients.set(clientId, {
            socket: undefined,
            deviceId: device?.id,
            lastSent: sequence,
            pumping: false,
            pending: false,
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
        if (
          !requestedClient ||
          !client ||
          (!trustedLan && client.deviceId !== device?.id)
        )
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
          if (
            "sessionId" in rpc ||
            rpc.method === "startRun" ||
            rpc.method === "enqueueInput"
          ) {
            const id =
              rpc.method === "startRun"
                ? rpc.input.sessionId
                : rpc.method === "enqueueInput"
                  ? rpc.input.input.sessionId
                  : (
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
        // Workspace lookups above yield: recheck device and page ownership before any effects.
        if (!(await authorized()))
          return json(response, 401, {
            error: "Device authorization required",
          });
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
        if (
          result.ok &&
          result.method === "getHostState" &&
          restrictWorkspace
        ) {
          const visible = await Promise.all(
            result.result.runs.map(async (run) => {
              const session = await snapshotOf(run.sessionId);
              return session && (await inWorkspace(session.workspace))
                ? run
                : undefined;
            }),
          );
          return json(response, 200, {
            ...result,
            result: { ...result.result, runs: visible.filter(Boolean) },
          });
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
      device = trustedLan ? undefined : await authenticate(request);
      if (!(await authorized()))
        return json(response, 401, { error: "Device authorization required" });
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
    // An unbuilt dev server may expose source modules through its fallback.
    if (!renderer && !trustedLan) {
      device = await authenticate(request);
      if (!(await authorized()))
        return json(response, 401, { error: "Device authorization required" });
    }
    next();
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeAuthorization?.();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    const listenerClosed = new Promise<void>((done) =>
      server.close(() => done()),
    );
    closing = (async () => {
      try {
        if (ownsAuthorization) await authorization?.close();
      } finally {
        await listenerClosed;
        clients.clear();
      }
    })();
    return closing;
  }
  let disposing: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (!disposing)
      disposing = close().finally(async () => {
        if (ownsRuntime) await runtime.dispose();
      });
    return disposing;
  };
  return {
    server,
    handle,
    close,
    dispose,
    origin,
    workspace,
    runtime,
    ownsRuntime,
  };
}
