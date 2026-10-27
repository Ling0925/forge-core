import {
  type ClientRequest,
  type IncomingMessage,
  STATUS_CODES,
  type Server,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createStaticRenderer } from "./static";

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
// The gateway is not an origin server; these are either handled here or must
// never be trusted from an external page.
const STRIPPED_REQUEST = new Set([
  "expect",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
const PROXY_EXACT = new Set(["/favicon.ico", "/preview"]);
const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export interface WebGatewayOptions {
  /** A concrete IPv4 literal the browser connects to; `0.0.0.0` is refused. */
  readonly host: string;
  /** The externally advertised and validated port. */
  readonly port: number;
  /** Loopback HTTP origin of the separate Core process, with an explicit port. */
  readonly coreUrl: string;
  /** Built renderer (`dist/renderer`) served by this process. */
  readonly rendererRoot: string;
}

export interface WebGateway {
  /** Already wired for `request`/`upgrade`; the caller only binds it. */
  readonly server: Server;
  /** Browser-facing origin used for CSP, Host and Origin checks. */
  readonly origin: string;
  /** Rewritten origin the Core process sees. */
  readonly coreOrigin: string;
  /** Idempotent transport shutdown; it never touches Core state. */
  readonly close: () => Promise<void>;
}

interface CoreTarget {
  readonly authority: string;
  readonly host: string;
  readonly origin: string;
  readonly port: number;
}

interface RawHeader {
  readonly count: number;
  readonly value: string | undefined;
}

function validEndpoint(host: string, port: number): boolean {
  return (
    IPV4.test(host) &&
    host !== "0.0.0.0" &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535
  );
}

function loopbackIpv4(host: string): boolean {
  return IPV4.test(host) && host.startsWith("127.");
}

/**
 * Only a bare loopback HTTP origin is accepted. Credentials, paths, queries and
 * fragments are refused before any request is forwarded, so the gateway cannot
 * be turned into a general-purpose proxy.
 */
function parseCoreUrl(raw: string, gatewayOrigin: string): CoreTarget {
  const invalid = (): never => {
    throw new Error(
      "coreUrl must be an http loopback IPv4 origin with an explicit port, and must not contain credentials, a path, query or fragment.",
    );
  };
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 512 ||
    raw.trim() !== raw ||
    raw.includes("?") ||
    raw.includes("#")
  )
    invalid();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port === "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !loopbackIpv4(url.hostname)
  )
    invalid();
  // URL parsing can normalize short/octal IPv4 forms and dot segments. Compare
  // against the canonical serialization so only the literal origin is accepted.
  if (raw !== url.origin) invalid();
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) invalid();
  const origin = `http://${url.hostname}:${port}`;
  if (origin === gatewayOrigin)
    throw new Error("The Web gateway cannot proxy to its own origin.");
  return {
    authority: `${url.hostname}:${port}`,
    host: url.hostname,
    origin,
    port,
  };
}

/** Counts duplicate security-sensitive headers before they are collapsed. */
function rawHeader(request: IncomingMessage, name: string): RawHeader {
  let count = 0;
  let value: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== name) continue;
    count += 1;
    if (count === 1) value = request.rawHeaders[index + 1];
  }
  return { count, value };
}

function connectionTokens(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isProxyPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/preview/") ||
    PROXY_EXACT.has(pathname)
  );
}

/**
 * Rebuilds the request headers without hop-by-hop names, then writes the Core
 * authority. Duplicate end-to-end headers are preserved so Core's own
 * authorization/cookie handling keeps seeing the same shape.
 */
function forwardedRequestHeaders(
  request: IncomingMessage,
  core: CoreTarget,
  forwardedOrigin: string | undefined,
): string[] {
  const tokens = connectionTokens(request.headers.connection);
  const headers: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    if (name === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "origin") continue;
    if (
      HOP_BY_HOP.has(lower) ||
      STRIPPED_REQUEST.has(lower) ||
      tokens.has(lower)
    )
      continue;
    headers.push(name, request.rawHeaders[index + 1] ?? "");
  }
  headers.push("Host", core.authority);
  if (forwardedOrigin !== undefined) headers.push("Origin", forwardedOrigin);
  return headers;
}

function forwardedResponseHeaders(response: IncomingMessage): string[] {
  const tokens = connectionTokens(response.headers.connection);
  const headers: string[] = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    if (name === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || tokens.has(lower)) continue;
    headers.push(name, response.rawHeaders[index + 1] ?? "");
  }
  return headers;
}

function writeGatewayError(
  response: ServerResponse,
  status: number,
  error: string,
  request?: IncomingMessage,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error });
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
  // A rejected request may still have an unread body; drain it so it cannot be
  // interpreted as a second request on this connection.
  request?.resume();
}

function writeNotFound(
  response: ServerResponse,
  request: IncomingMessage,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = "Not found";
  response.writeHead(404, {
    ...SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(request.method === "HEAD" ? undefined : body);
  request.resume();
}

function rejectUpgrade(socket: Duplex, status: number, error: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error });
  const reason = STATUS_CODES[status] ?? "Error";
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    ...Object.entries(SECURITY_HEADERS).map(
      ([name, value]) => `${name}: ${value}`,
    ),
    "Cache-Control: no-store",
    "Connection: close",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Content-Type: application/json; charset=utf-8",
  ];
  socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

function writeUpgradeResponse(socket: Duplex, response: IncomingMessage): void {
  const status = response.statusCode ?? 101;
  const reason =
    response.statusMessage || STATUS_CODES[status] || "Switching Protocols";
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    if (name === undefined) continue;
    lines.push(`${name}: ${response.rawHeaders[index + 1] ?? ""}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

/** Relays a normal HTTP rejection that answered a WebSocket handshake. */
function writeUpgradeRejection(
  socket: Duplex,
  response: IncomingMessage,
): void {
  if (socket.destroyed) {
    response.destroy();
    return;
  }
  const status = response.statusCode ?? 502;
  const reason = response.statusMessage || STATUS_CODES[status] || "Error";
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  const headers = forwardedResponseHeaders(response);
  for (let index = 0; index < headers.length; index += 2)
    lines.push(`${headers[index]}: ${headers[index + 1] ?? ""}`);
  lines.push("Connection: close");
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  response.on("error", () => socket.destroy());
  socket.on("close", () => response.destroy());
  response.pipe(socket);
}

/**
 * A separately hosted static renderer plus reverse proxy for one already-running
 * Core Web server.
 *
 * The returned server has no listener of its own; the caller binds it and
 * decides when the Web process starts or stops. Closing this gateway destroys
 * only HTTP/WebSocket connections. It has no Harness, Runtime, session or
 * request-retry logic, so a Core process keeps running and replays events from
 * its cursor ring after the gateway is restarted.
 */
export async function createWebGateway(
  options: WebGatewayOptions,
): Promise<WebGateway> {
  if (!validEndpoint(options.host, options.port))
    throw new Error(
      "Use one concrete IPv4 address (not 0.0.0.0) and a port between 1024 and 65535.",
    );
  const origin = `http://${options.host}:${options.port}`;
  const authority = `${options.host}:${options.port}`;
  const core = parseCoreUrl(options.coreUrl, origin);
  const renderer = await createStaticRenderer({
    rendererRoot: options.rendererRoot,
  });
  const server = createServer();
  const upstreams = new Set<ClientRequest>();
  const tunnels = new Set<() => void>();
  const upgrading = new Set<Duplex>();
  let stopped = false;
  let closing: Promise<void> | undefined;

  function proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    forwardedOrigin: string | undefined,
  ): void {
    const upstream = httpRequest({
      agent: false,
      headers: forwardedRequestHeaders(request, core, forwardedOrigin),
      host: core.host,
      method: request.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      port: core.port,
    });
    upstreams.add(upstream);
    let responded = false;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      upstreams.delete(upstream);
    };
    upstream.on("response", (upstreamResponse) => {
      responded = true;
      // Core may answer before consuming a rejected body. Stop writing to it,
      // but drain the browser side so the response can finish cleanly.
      request.unpipe(upstream);
      if (!upstream.writableEnded) upstream.end();
      request.resume();
      if (response.headersSent || response.destroyed) {
        upstreamResponse.destroy();
        return;
      }
      const status = upstreamResponse.statusCode ?? 502;
      const statusMessage = upstreamResponse.statusMessage;
      const headers = forwardedResponseHeaders(upstreamResponse);
      if (statusMessage) response.writeHead(status, statusMessage, headers);
      else response.writeHead(status, headers);
      upstreamResponse.on("error", () => response.destroy());
      upstreamResponse.on("aborted", () => response.destroy());
      response.on("close", () => {
        if (!response.writableFinished) {
          upstreamResponse.destroy();
          upstream.destroy();
        }
      });
      // Stream status, headers and bytes directly; no response buffering, so
      // large attachments and preview documents keep backpressure.
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      // An error after a response began is a broken stream, not a retryable
      // request. Never send the request a second time.
      if (responded || stopped) {
        response.destroy();
        return;
      }
      writeGatewayError(response, 502, "Core service unavailable", request);
    });
    upstream.on("close", settle);
    request.on("aborted", () => upstream.destroy());
    request.on("close", () => {
      if (!request.complete) upstream.destroy();
    });
    request.pipe(upstream);
  }

  function tunnel(client: Duplex, upstream: Socket): () => void {
    let closed = false;
    const teardown = (): void => {
      if (closed) return;
      closed = true;
      tunnels.delete(teardown);
      client.destroy();
      upstream.destroy();
    };
    tunnels.add(teardown);
    client.on("error", teardown);
    upstream.on("error", teardown);
    client.on("close", teardown);
    upstream.on("close", teardown);
    if (client.destroyed || upstream.destroyed) {
      teardown();
      return teardown;
    }
    client.pipe(upstream);
    upstream.pipe(client);
    return teardown;
  }

  function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (socket.destroyed) return;
    // The socket is an upgraded connection as soon as Node emits this event,
    // even while the Core handshake is still pending. Track it separately so
    // close() can destroy it before it ever becomes a tunnel.
    upgrading.add(socket);
    const forget = (): void => {
      upgrading.delete(socket);
    };
    socket.once("close", forget);
    socket.once("error", forget);
    if (stopped) {
      rejectUpgrade(socket, 503, "Web gateway stopped");
      return;
    }
    const host = rawHeader(request, "host");
    if (host.count !== 1 || host.value !== authority) {
      rejectUpgrade(socket, 403, "Unexpected host");
      return;
    }
    if (request.method !== "GET") {
      rejectUpgrade(socket, 400, "WebSocket GET required");
      return;
    }
    const rawUrl = request.url;
    if (!rawUrl || rawUrl.includes("#")) {
      rejectUpgrade(socket, 400, "Invalid request target");
      return;
    }
    let target: URL;
    try {
      target = new URL(rawUrl, origin);
    } catch {
      rejectUpgrade(socket, 400, "Invalid request target");
      return;
    }
    if (target.origin !== origin || target.pathname !== "/api/events") {
      rejectUpgrade(socket, 404, "Not found");
      return;
    }
    const requestOrigin = rawHeader(request, "origin");
    if (requestOrigin.count !== 1 || requestOrigin.value !== origin) {
      rejectUpgrade(socket, 403, "Unexpected origin");
      return;
    }
    if (
      (request.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
      !connectionTokens(request.headers.connection).has("upgrade")
    ) {
      rejectUpgrade(socket, 400, "WebSocket upgrade required");
      return;
    }
    const key = rawHeader(request, "sec-websocket-key");
    const version = rawHeader(request, "sec-websocket-version");
    if (
      key.count !== 1 ||
      !key.value ||
      version.count !== 1 ||
      !version.value
    ) {
      rejectUpgrade(socket, 400, "Invalid WebSocket handshake");
      return;
    }

    const headers = forwardedRequestHeaders(request, core, core.origin);
    headers.push("Connection", "Upgrade", "Upgrade", "websocket");
    const upstream = httpRequest({
      agent: false,
      headers,
      host: core.host,
      method: "GET",
      path: `${target.pathname}${target.search}`,
      port: core.port,
    });
    upstreams.add(upstream);
    let upgraded = false;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      upstreams.delete(upstream);
    };
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      if (upstreamResponse.statusCode !== 101) {
        writeUpgradeRejection(socket, upstreamResponse);
        upstreamSocket.destroy();
        return;
      }
      upgraded = true;
      if (stopped || socket.destroyed) {
        upstreamSocket.destroy();
        socket.destroy();
        return;
      }
      writeUpgradeResponse(socket, upstreamResponse);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      // A browser must wait for 101 before sending frames, but a non-browser
      // client may pipeline bytes with the handshake. Forward them in order.
      if (head.length > 0 && upstreamSocket.writable)
        upstreamSocket.write(head);
      tunnel(socket, upstreamSocket);
    });
    upstream.on("response", (upstreamResponse) =>
      writeUpgradeRejection(socket, upstreamResponse),
    );
    upstream.on("error", () => {
      if (!upgraded && !socket.destroyed)
        rejectUpgrade(socket, 502, "Core service unavailable");
    });
    upstream.on("close", settle);
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => {
      if (!upgraded) upstream.destroy();
    });
    upstream.end();
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (stopped)
      return writeGatewayError(response, 503, "Web gateway stopped", request);
    const host = rawHeader(request, "host");
    if (host.count !== 1 || host.value !== authority)
      return writeGatewayError(response, 403, "Unexpected host", request);
    const rawUrl = request.url;
    if (!rawUrl || rawUrl.includes("#"))
      return writeGatewayError(
        response,
        400,
        "Invalid request target",
        request,
      );
    let target: URL;
    try {
      target = new URL(rawUrl, origin);
    } catch {
      return writeGatewayError(
        response,
        400,
        "Invalid request target",
        request,
      );
    }
    if (target.origin !== origin)
      return writeGatewayError(response, 403, "Unexpected origin", request);
    const pathname = target.pathname;
    if (!isProxyPath(pathname)) {
      // The renderer owns every non-API path. A miss is a local 404, never a
      // fallback proxy to Core.
      if (request.method === "GET" || request.method === "HEAD") {
        if (await renderer.handle(request, response, origin)) return;
      }
      return writeNotFound(response, request);
    }
    const requestOrigin = rawHeader(request, "origin");
    if (requestOrigin.count > 1)
      return writeGatewayError(response, 403, "Unexpected origin", request);
    if (pathname.startsWith("/api/")) {
      // The build diagnosis is a bodyless same-origin GET: an absent Origin is
      // what a page's fetch sends, but a present Origin must match exactly.
      const diagnosed = pathname === "/api/version" && request.method === "GET";
      if (
        diagnosed
          ? requestOrigin.count === 1 && requestOrigin.value !== origin
          : requestOrigin.count !== 1 || requestOrigin.value !== origin
      )
        return writeGatewayError(
          response,
          403,
          "Same-origin JSON POST required",
          request,
        );
    } else if (requestOrigin.count === 1 && requestOrigin.value !== origin) {
      return writeGatewayError(response, 403, "Unexpected origin", request);
    }
    proxyHttp(
      request,
      response,
      target,
      requestOrigin.count === 1 ? core.origin : undefined,
    );
  }

  server.on("request", (request, response) => {
    void handleRequest(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else writeGatewayError(response, 500, "Web gateway unavailable", request);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      handleUpgrade(request, socket, head);
    } catch {
      socket.destroy();
    }
  });

  function close(): Promise<void> {
    if (closing) return closing;
    stopped = true;
    for (const teardown of [...tunnels]) teardown();
    for (const socket of [...upgrading]) socket.destroy();
    for (const upstream of [...upstreams]) upstream.destroy();
    upgrading.clear();
    upstreams.clear();
    const listenerClosed = server.listening
      ? new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
      : Promise.resolve();
    closing = listenerClosed.catch(() => undefined);
    return closing;
  }

  return { server, origin, coreOrigin: core.origin, close };
}
