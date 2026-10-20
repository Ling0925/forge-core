import { ForgeError } from "../shared/errors";
import { type Json, JsonRpcConnection, invalid } from "./rpc";
import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_MAX_SSE_EVENT_BYTES,
  MCP_PROTOCOL_VERSION,
  type McpTransport,
} from "./types";

const SESSION_HEADER = "mcp-session-id";
const PROTOCOL_HEADER = "mcp-protocol-version";

const transportError = (message: string): ForgeError =>
  new ForgeError("tool", message);

/** Bounded, sanitized remote endpoint description for errors/logs. */
export const describeEndpoint = (value: URL): string =>
  `${value.protocol}//${value.host}${value.pathname}`.slice(0, 512);

/** Session ids are opaque, bounded and control-character free. */
export function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

/**
 * Resolve a server-supplied endpoint against the registered origin. Remote
 * transports never cross origins: an explicit registration authorizes exactly
 * one origin, and server-negotiated endpoints stay inside it.
 */
export function sameOriginEndpoint(base: URL, raw: string): URL | undefined {
  try {
    const candidate = new URL(raw, base);
    if (candidate.origin !== base.origin) return undefined;
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:")
      return undefined;
    if (candidate.username || candidate.password) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental text/event-stream parser with per-event byte bounds. Frames may
 * be split at any byte boundary; only complete blank-line-delimited events are
 * dispatched.
 */
export function createSseParser(
  onEvent: (event: SseEvent) => void,
  onError: (error: Error) => void,
): (chunk: string) => void {
  let buffer = "";
  let bytes = 0;
  return (chunk: string) => {
    buffer += chunk;
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > MCP_MAX_SSE_EVENT_BYTES) {
      onError(
        invalid("MCP SSE stream exceeded the 4 MiB event buffer ceiling."),
      );
      buffer = "";
      return;
    }
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      bytes = Buffer.byteLength(buffer, "utf8");
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0) onEvent({ event, data: data.join("\n") });
    }
  };
}

/** Read a response body with a hard byte cap, then release the stream. */
async function boundedBody(response: Response, limit: number): Promise<string> {
  if (!response.body)
    throw transportError("MCP server returned an empty response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit)
        throw transportError("MCP server response exceeded the size ceiling.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

function parseJsonFrame(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid("MCP server sent malformed JSON.");
  }
}

function sanitizedStatus(response: Response): string {
  return `HTTP ${String(response.status)}`;
}

interface RemoteOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestTimeoutMs: number;
}

/**
 * Streamable HTTP transport (MCP revision 2025-11-25): every JSON-RPC message
 * is POSTed to one endpoint. A response may be a single `application/json`
 * message or an SSE stream whose events are routed by JSON-RPC id.
 */
export class HttpMcpConnection extends JsonRpcConnection {
  private readonly endpoint: URL;
  private sessionId: string | undefined;
  private readonly controllers = new Set<AbortController>();
  private readonly inflight = new Set<Promise<void>>();
  private disposed = false;

  constructor(private readonly options: RemoteOptions) {
    super(options.requestTimeoutMs, Object.values(options.headers));
    this.endpoint = new URL(options.url);
  }

  private baseHeaders(): Record<string, string> {
    return {
      ...this.options.headers,
      accept: "application/json, text/event-stream",
    };
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      "content-type": "application/json",
    };
    if (this.sessionId !== undefined) headers[SESSION_HEADER] = this.sessionId;
    if (this.negotiatedProtocolVersion !== undefined)
      headers[PROTOCOL_HEADER] = this.negotiatedProtocolVersion;
    return headers;
  }

  private captureSession(response: Response): void {
    const value = response.headers.get(SESSION_HEADER);
    if (value === null) return;
    if (!validSessionId(value))
      throw transportError("MCP server sent an invalid session id.");
    this.sessionId = value;
  }

  protected async start(): Promise<void> {
    // The explicit registration already authorizes the endpoint; nothing is
    // fetched until the first operation. A GET probe is not performed.
    if (
      this.endpoint.protocol !== "http:" &&
      this.endpoint.protocol !== "https:"
    )
      throw invalid("Unsupported MCP remote URL protocol.");
  }

  protected send(payload: Json): Promise<void> {
    const task = this.doSend(payload);
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task)).catch(() => undefined);
    return task;
  }

  private async doSend(payload: Json): Promise<void> {
    if (this.closed || this.disposed)
      throw new ForgeError(
        "tool",
        this.failure ?? "MCP server connection is closed.",
      );
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, "utf8") > MCP_MAX_MESSAGE_BYTES)
      throw transportError("MCP request exceeds the message ceiling.");
    const controller = new AbortController();
    this.controllers.add(controller);
    const id =
      typeof payload.method === "string" &&
      typeof payload.id === "number" &&
      Number.isSafeInteger(payload.id)
        ? payload.id
        : undefined;
    // Every network send is bounded, including notifications, so a server that
    // never answers `notifications/initialized` cannot hang connect.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.requestTimeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.requestHeaders(),
        body: text,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        this.shutdown(
          transportError(
            "MCP server attempted a redirect; refusing to follow.",
          ),
        );
        return;
      }
      this.captureSession(response);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        this.shutdown(
          transportError(
            `MCP server rejected the request (${sanitizedStatus(response)}).`,
          ),
        );
        return;
      }
      if (id === undefined || response.status === 202) {
        // Notifications have no correlated body; never hold a stream open.
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType === "application/json") {
        const body = await boundedBody(response, MCP_MAX_MESSAGE_BYTES);
        if (body.trim().length === 0)
          throw invalid("MCP server returned an empty JSON response.");
        this.receive(parseJsonFrame(body));
        return;
      }
      if (contentType === "text/event-stream") {
        await this.consumeStream(response, id);
        return;
      }
      await response.body?.cancel().catch(() => undefined);
      this.shutdown(
        transportError("MCP server returned an unsupported content type."),
      );
    } catch (error) {
      if (this.closed) return;
      if (timedOut) this.shutdown(transportError("MCP request timed out."));
      else if (error instanceof ForgeError) this.shutdown(error);
      else if ((error as { name?: string }).name === "AbortError")
        this.shutdown(transportError("MCP request was aborted."));
      else this.shutdown(transportError("MCP remote request failed."));
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private async consumeStream(response: Response, id: number): Promise<void> {
    if (!response.body)
      throw transportError("MCP server returned an empty event stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let answered = false;
    const parse = createSseParser(
      (event) => {
        if (event.event !== "message") return;
        this.receive(parseJsonFrame(event.data));
        if (!this.pending.has(id)) answered = true;
      },
      (error) => this.shutdown(error),
    );
    try {
      for (;;) {
        if (this.closed) break;
        const { done, value } = await reader.read();
        if (done) break;
        parse(decoder.decode(value, { stream: true }));
        if (this.closed) break;
        // The correlated response has arrived; stop reading this stream so the
        // request settles promptly. Any later frames are not replayed.
        if (!this.pending.has(id)) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      // A stream that ends before answering leaves the call waiting on its
      // timer; settle it now instead.
      if (!answered && !this.closed && this.pending.has(id))
        this.shutdown(
          transportError("MCP stream ended before the response arrived."),
        );
    }
  }

  protected async terminate(): Promise<void> {
    this.disposed = true;
    // Session termination via DELETE is optional in MCP; skipping it guarantees
    // close() never leaves an unjoined request behind.
    this.sessionId = undefined;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    await Promise.allSettled([...this.inflight]);
  }
}

/**
 * Legacy HTTP+SSE transport: a single server-sent-event GET stream delivers
 * responses, while requests are POSTed to a same-origin endpoint negotiated by
 * the server's `endpoint` event. Responses are routed by JSON-RPC id.
 */
export class SseMcpConnection extends JsonRpcConnection {
  private readonly endpoint: URL;
  private postEndpoint: URL | undefined;
  private streamController: AbortController | undefined;
  private ready: Promise<void> | undefined;
  private disposed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly options: RemoteOptions) {
    super(options.requestTimeoutMs, Object.values(options.headers));
    this.endpoint = new URL(options.url);
  }

  /** Track an owned network task so terminate() can join it. */
  private track(task: Promise<void>): void {
    const observed = task.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(observed);
    void observed.finally(() => this.inflight.delete(observed));
  }

  protected start(signal?: AbortSignal): Promise<void> {
    if (!this.ready) {
      this.ready = this.openStream(signal);
      this.track(this.ready);
    }
    return this.ready;
  }

  private async openStream(signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    this.streamController = controller;
    const abort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw invalid("Tool execution cancelled.");
      signal.addEventListener("abort", abort, { once: true });
    }
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Observe immediately: the timeout can reject while fetch is still pending.
    void ready.catch(() => undefined);
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Abort the owned HTTP stream so an unanswered GET really ends, and
      // settle the negotiation rather than leaving it waiting on headers.
      controller.abort();
      if (!settled) {
        settled = true;
        rejectReady(transportError("MCP SSE endpoint negotiation timed out."));
      }
    }, this.options.requestTimeoutMs);
    const pump = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const run = async () => {
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parse(decoder.decode(value, { stream: true }));
            if (this.closed) break;
          }
        } catch (error) {
          if (!this.closed)
            this.shutdown(
              error instanceof ForgeError
                ? error
                : transportError("MCP SSE stream failed."),
            );
        } finally {
          await reader.cancel().catch(() => undefined);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            rejectReady(transportError("MCP SSE stream closed before ready."));
          } else if (!this.closed) {
            // The transport ended after negotiation: pending calls must settle
            // promptly instead of waiting for their individual timers.
            this.shutdown(transportError("MCP SSE stream ended."));
          }
        }
      };
      this.track(run());
    };
    let parse: (chunk: string) => void = () => undefined;
    try {
      const response = await fetch(this.endpoint, {
        method: "GET",
        headers: { ...this.options.headers, accept: "text/event-stream" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw transportError(
          "MCP SSE server attempted a redirect; refusing to follow.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw transportError(
          `MCP SSE server refused the stream (${sanitizedStatus(response)}).`,
        );
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "text/event-stream") {
        await response.body?.cancel().catch(() => undefined);
        throw transportError(
          "MCP SSE server returned an unsupported content type.",
        );
      }
      if (!response.body)
        throw transportError("MCP SSE server returned an empty stream.");
      parse = createSseParser(
        (event) => {
          if (event.event === "endpoint") {
            if (this.postEndpoint !== undefined) return;
            const endpoint = sameOriginEndpoint(this.endpoint, event.data);
            if (!endpoint) {
              this.shutdown(
                transportError(
                  "MCP SSE endpoint must stay on the registered origin.",
                ),
              );
              return;
            }
            this.postEndpoint = endpoint;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolveReady();
            }
            return;
          }
          if (event.event === "message")
            this.receive(parseJsonFrame(event.data));
        },
        (error) => this.shutdown(error),
      );
      pump(response.body.getReader());
      await ready;
    } catch (error) {
      if (timedOut)
        throw transportError("MCP SSE endpoint negotiation timed out.");
      if (error instanceof ForgeError) throw error;
      if ((error as { name?: string }).name === "AbortError")
        throw transportError("MCP SSE stream was aborted.");
      throw transportError("MCP SSE connection failed.");
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
    }
  }

  protected send(payload: Json): Promise<void> {
    const task = this.doSend(payload);
    this.track(task);
    return task;
  }

  private async doSend(payload: Json): Promise<void> {
    if (this.closed || this.disposed)
      throw new ForgeError(
        "tool",
        this.failure ?? "MCP server connection is closed.",
      );
    const endpoint = this.postEndpoint;
    if (!endpoint)
      throw transportError("MCP SSE endpoint is not negotiated yet.");
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, "utf8") > MCP_MAX_MESSAGE_BYTES)
      throw transportError("MCP request exceeds the message ceiling.");
    const controller = new AbortController();
    this.controllers.add(controller);
    // Every network send is bounded, including notifications, so a stalled
    // POST cannot hang connect forever.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.requestTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...this.options.headers,
          "content-type": "application/json",
          [PROTOCOL_HEADER]:
            this.negotiatedProtocolVersion ?? MCP_PROTOCOL_VERSION,
        },
        body: text,
        redirect: "manual",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 300 && response.status < 400) {
        this.shutdown(
          transportError(
            "MCP SSE server attempted a redirect; refusing to follow.",
          ),
        );
        return;
      }
      if (!response.ok)
        this.shutdown(
          transportError(
            `MCP SSE server rejected the request (${sanitizedStatus(response)}).`,
          ),
        );
    } catch (error) {
      if (this.closed) return;
      if (timedOut) this.shutdown(transportError("MCP SSE request timed out."));
      else if (error instanceof ForgeError) this.shutdown(error);
      else if ((error as { name?: string }).name === "AbortError")
        this.shutdown(transportError("MCP SSE request was aborted."));
      else this.shutdown(transportError("MCP SSE request failed."));
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  protected async terminate(): Promise<void> {
    this.disposed = true;
    this.postEndpoint = undefined;
    this.streamController?.abort();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    // Join owned requests and the event stream so dispose/revoke is settled.
    await Promise.allSettled([...this.inflight]);
  }
}

/** Build a remote connection for the configured transport. */
export function createRemoteConnection(
  transport: Exclude<McpTransport, "stdio">,
  options: RemoteOptions,
): HttpMcpConnection | SseMcpConnection {
  return transport === "http"
    ? new HttpMcpConnection(options)
    : new SseMcpConnection(options);
}
