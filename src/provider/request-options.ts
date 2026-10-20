import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import tls from "node:tls";
import { ForgeError } from "../shared/errors";
import { ProviderError } from "./errors";
import type { ProviderConfig } from "../shared/schemas";
import { prepareCodexBody } from "./accounts/codex";
import * as copilotAccounts from "./accounts/copilot";

type ProviderAuth = NonNullable<ProviderConfig["auth"]>;
type ProviderProtocol = NonNullable<ProviderConfig["apiMode"]>;

/**
 * Magpie's extraBody fields the model identity, the conversation, the tools or
 * the local streaming controls own. They may fill in other fields, but may
 * never replace these.
 */
export const extraBodyReserved = new Set([
  "model",
  "stream",
  "stream_options",
  "messages",
  "input",
  "contents",
  "system",
  "systemInstruction",
  "system_instruction",
  "instructions",
  "tools",
  "tool_choice",
]);

type HeaderValue = string | null;
type HeaderMap = Map<string, HeaderValue>;

const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const transportHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
]);

const invalid = (message: string): ForgeError =>
  new ForgeError("invalid_input", message, false);

const hasLineBreak = (value: string): boolean => /[\r\n\0]/.test(value);

function putHeader(headers: HeaderMap, name: string, value: HeaderValue): void {
  if (!headerName.test(name))
    throw invalid("A provider header name is invalid.");
  if (transportHeaders.has(name.toLowerCase()))
    throw invalid("A provider header uses a reserved transport header name.");
  for (const existing of [...headers.keys()])
    if (existing.toLowerCase() === name.toLowerCase()) headers.delete(existing);
  headers.set(name, value);
}

function authName(
  auth: ProviderAuth,
  protocol: ProviderProtocol,
): string | undefined {
  switch (auth.type) {
    case "none":
      return undefined;
    case "bearer":
      return "Authorization";
    case "header":
      return auth.header;
    case "api-key":
      return protocol === "gemini"
        ? "x-goog-api-key"
        : protocol === "anthropic"
          ? "x-api-key"
          : "api-key";
    case "auto":
      return protocol === "gemini"
        ? "x-goog-api-key"
        : protocol === "anthropic"
          ? "x-api-key"
          : "Authorization";
  }
}

function authValue(
  auth: ProviderAuth,
  protocol: ProviderProtocol,
  credential: string | undefined,
): string | undefined {
  if (!credential || auth.type === "none") return undefined;
  const bearer =
    auth.type === "bearer" ||
    (auth.type === "auto" &&
      (protocol === "chat-completions" || protocol === "responses"));
  if (bearer) return `${auth.prefix ?? "Bearer "}${credential}`;
  return `${auth.prefix ?? ""}${credential}`;
}

/**
 * Resolve public auth/header settings into the headers both SDK clients use.
 * Explicit headers win over generated auth headers, as in Magpie. Nulls tell
 * the OpenAI and Anthropic SDKs not to add their own credentials.
 */
export function requestHeaders(
  config: ProviderConfig,
): Record<string, string | null> {
  const protocol = config.apiMode ?? "chat-completions";
  const auth = config.auth ?? { type: "auto" };
  const credential = config.apiKey || config.account?.accessToken;
  const headers: HeaderMap = new Map();
  // Both SDKs otherwise add credentials of their own. The nulls are explicit
  // removals in their header builders.
  putHeader(headers, "Authorization", null);
  if (protocol === "anthropic") putHeader(headers, "x-api-key", null);
  if (protocol === "gemini") putHeader(headers, "x-goog-api-key", null);

  const name = authName(auth, protocol);
  // "auto" names the header the protocol normally uses; with no credential (a
  // local server, an anonymous relay) it sends none instead of demanding one.
  if (name && auth.type !== "none" && (credential || auth.type !== "auto")) {
    if (hasLineBreak(name))
      throw invalid("A provider auth header name is invalid.");
    const value = authValue(auth, protocol, credential);
    if (value === undefined)
      throw invalid(
        "The configured provider authentication needs a credential.",
      );
    if (hasLineBreak(value))
      throw invalid("A provider credential contains a line break.");
    putHeader(headers, name, value);
  }
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (hasLineBreak(name) || hasLineBreak(value))
      throw invalid("A provider header contains a line break.");
    putHeader(headers, name, value);
  }
  return Object.fromEntries(headers);
}

function cloneJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw invalid("extraBody must contain JSON values.");
  }
}

function withSession(value: unknown, sessionId: string | undefined): unknown {
  if (typeof value === "string")
    return sessionId === undefined
      ? value
      : value.replaceAll("${sessionId}", sessionId);
  if (Array.isArray(value))
    return value.map((entry) => withSession(entry, sessionId));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        withSession(entry, sessionId),
      ]),
    );
  }
  return value;
}

function extraName(key: string): { name: string; forced: boolean } {
  const trimmed = key.trim();
  const forced = trimmed.startsWith("!");
  return { name: (forced ? trimmed.slice(1) : trimmed).trim(), forced };
}

/**
 * Validate extraBody once per provider instance. A plain reserved name is left
 * out (Magpie does the same for fields written into a providers file by hand);
 * forcing one with "!" is an explicit attempt to override the model identity,
 * the conversation, tools, streaming or a local control, and is refused.
 * Account materialization also supplies plain reserved defaults, which are
 * harmless because the body already carries its own values.
 */
function validatedExtraBody(
  extraBody: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!extraBody) return undefined;
  const seen = new Set<string>();
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extraBody)) {
    const { name, forced } = extraName(key);
    if (!name) throw invalid("An extraBody field needs a name.");
    if (extraBodyReserved.has(name)) {
      if (forced)
        throw invalid(
          "extraBody cannot force the model, messages, tools, streaming, or local request controls.",
        );
      continue;
    }
    if (seen.has(name))
      throw invalid("extraBody names a field more than once.");
    seen.add(name);
    cloneJson(value);
    kept[key] = value;
  }
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Merge extraBody at the top level. A body field that already exists wins;
 * a key prefixed with "!" is forced. `${sessionId}` is replaced in string
 * values at any depth. The inputs are never mutated.
 */
export function applyExtraBody<T extends Record<string, unknown>>(
  body: T,
  extraBody: Readonly<Record<string, unknown>> | undefined,
  sessionId?: string,
): T {
  if (!extraBody) return body;
  const merged: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(extraBody)) {
    const { name, forced } = extraName(key);
    if (!forced && Object.prototype.hasOwnProperty.call(merged, name)) continue;
    merged[name] = withSession(cloneJson(value), sessionId);
  }
  return merged as T;
}

function proxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function proxyError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  return new ProviderError(
    "network",
    "The provider proxy connection failed.",
    true,
  );
}

/**
 * A fetch that tunnels an HTTP(S) proxy with CONNECT and preserves streaming.
 * SOCKS needs a dedicated agent dependency; it is rejected explicitly instead
 * of silently bypassing the user's proxy.
 */
export function createProxyFetch(proxyUrl: string): typeof globalThis.fetch {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw invalid("The provider proxy URL is invalid.");
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:")
    throw invalid(
      "Only HTTP(S) proxies are supported by the built-in transport; configure an HTTP(S) proxy URL.",
    );
  const proxyPort = Number(
    proxy.port || (proxy.protocol === "https:" ? 443 : 80),
  );
  const proxyTransport = proxy.protocol === "https:" ? https : http;
  const authorization = proxyAuthorization(proxy);

  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    if (target.protocol !== "http:" && target.protocol !== "https:")
      throw new ProviderError(
        "network",
        "The provider URL has an unsupported protocol.",
        false,
      );
    const targetPort = Number(
      target.port || (target.protocol === "https:" ? 443 : 80),
    );
    const body = request.body
      ? Buffer.from(await request.arrayBuffer())
      : undefined;
    const outgoing = new Headers(request.headers);
    outgoing.delete("host");
    outgoing.delete("connection");
    outgoing.delete("transfer-encoding");
    outgoing.delete("content-length");
    if (body) outgoing.set("content-length", String(body.length));

    let tunnel: Awaited<ReturnType<typeof connectProxy>>;
    try {
      tunnel = await connectProxy(
        proxyTransport,
        proxy.hostname,
        proxyPort,
        target.hostname,
        targetPort,
        authorization,
        request.signal,
        proxy.protocol === "https:",
      );
    } catch (error) {
      throw proxyError(error);
    }

    let socket = tunnel;
    if (target.protocol === "https:") {
      try {
        socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
          const secure = tls.connect({
            socket: tunnel,
            servername: target.hostname,
          });
          secure.once("secureConnect", () => resolve(secure));
          secure.once("error", reject);
          request.signal.addEventListener(
            "abort",
            () => {
              secure.destroy();
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      } catch (error) {
        tunnel.destroy();
        throw proxyError(error);
      }
    }

    const targetTransport = target.protocol === "https:" ? https : http;
    let response: http.IncomingMessage;
    try {
      response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const outgoingRequest = targetTransport.request(
          {
            method: request.method,
            hostname: target.hostname,
            port: targetPort,
            path: `${target.pathname}${target.search}`,
            headers: Object.fromEntries(outgoing.entries()),
            // agent:false creates a fresh default Agent and ignores this socket.
            // An explicit connection callback must own this CONNECT tunnel.
            createConnection: () => socket,
            signal: request.signal,
            ...(target.protocol === "https:"
              ? { servername: target.hostname }
              : {}),
          },
          resolve,
        );
        outgoingRequest.once("error", reject);
        if (body) outgoingRequest.write(body);
        outgoingRequest.end();
      });
    } catch (error) {
      socket.destroy();
      throw proxyError(error);
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value))
        for (const entry of value) headers.append(name, entry);
      else if (value !== undefined) headers.append(name, value);
    }
    headers.delete("connection");
    headers.delete("keep-alive");
    headers.delete("proxy-authenticate");
    headers.delete("proxy-authorization");
    headers.delete("transfer-encoding");
    return new Response(
      Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>,
      {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers,
      },
    );
  };
}

function connectProxy(
  transport: typeof http | typeof https,
  host: string,
  port: number,
  targetHost: string,
  targetPort: number,
  authorization: string | undefined,
  signal: AbortSignal,
  secure: boolean,
): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const request = transport.request({
      host,
      port,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: authorization ? { "Proxy-Authorization": authorization } : {},
      signal,
      ...(secure ? { servername: host } : {}),
    });
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(
          new ProviderError(
            "network",
            `The provider proxy refused the tunnel (HTTP ${response.statusCode ?? "unknown"}).`,
            response.statusCode === 408 ||
              response.statusCode === 429 ||
              (response.statusCode ?? 0) >= 500,
          ),
        );
        return;
      }
      resolve(socket);
    });
    request.once("error", reject);
    request.end();
  });
}

type BodyHeaders = (body: Record<string, unknown>) => Record<string, string>;

/**
 * Copilot's per-request headers depend on the exact body sent (initiator role,
 * vision input), so the account module owns them. The export lands with the
 * account work; resolving it here keeps the provider core usable meanwhile.
 */
const prepareCopilotHeaders = (
  copilotAccounts as unknown as { prepareCopilotHeaders?: BodyHeaders }
).prepareCopilotHeaders;

export type ProviderRequestOptions = Readonly<{
  /** Headers for both SDKs; null removes a default credential header. */
  headers: Record<string, string | null>;
  /** Base transport, set when the source has its own proxy. */
  fetch: typeof globalThis.fetch | undefined;
  /** Add extraBody fields to a complete() request body. */
  applyBody: <T extends Record<string, unknown>>(
    body: T,
    sessionId?: string,
  ) => T;
  /** Headers computed from the body actually sent; never used for catalogs. */
  headersFor: (body: Record<string, unknown>) => Record<string, string>;
}>;

/**
 * Validate and resolve request extensions once per provider instance. Secrets
 * are only placed into headers or bodies; errors never repeat their values.
 */
export function createRequestOptions(
  config: ProviderConfig,
): ProviderRequestOptions {
  const extraBody = validatedExtraBody(config.extraBody);
  const proxyUrl = config.proxyUrl?.trim();
  const platform = config.account?.platform;
  // Order matters: the user's fields are merged and validated first, then the
  // account's own transform decides the final shape (Codex CLI's Responses).
  const applyBody = <T extends Record<string, unknown>>(
    body: T,
    sessionId?: string,
  ): T => {
    const merged = applyExtraBody(body, extraBody, sessionId);
    return platform === "codex" ? (prepareCodexBody(merged) as T) : merged;
  };
  const headersFor = (
    body: Record<string, unknown>,
  ): Record<string, string> => {
    if (platform === "copilot" && prepareCopilotHeaders)
      return prepareCopilotHeaders(body);
    return {};
  };
  return {
    headers: requestHeaders(config),
    fetch: proxyUrl ? createProxyFetch(proxyUrl) : undefined,
    applyBody,
    headersFor,
  };
}

export type { ProviderAuth };
