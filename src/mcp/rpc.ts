import { ForgeError } from "../shared/errors";
import { boundedText, checkDiscovery } from "./bounds";
import {
  MCP_DISCOVERY_LIMIT,
  MCP_MAX_MESSAGE_BYTES,
  MCP_MAX_PAGES,
  MCP_MAX_PENDING,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_PROTOCOL_VERSION,
  type McpToolInfo,
  isSupportedProtocolVersion,
  mcpToolInfoSchema,
} from "./types";

export type Json = Record<string, unknown>;

export interface McpToolOutcome {
  readonly text: string;
  readonly isError: boolean;
  readonly truncated: boolean;
}

/**
 * The transport-independent surface the registry uses. Stdio, Streamable HTTP
 * and legacy SSE all satisfy this interface, so service behavior, discovery
 * bounds, redaction and cancellation stay identical across transports.
 */
export interface McpConnection {
  readonly negotiatedProtocolVersion: string | undefined;
  readonly isClosed: boolean;
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<readonly McpToolInfo[]>;
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    redactValues?: readonly string[],
  ): Promise<McpToolOutcome>;
  close(): Promise<void>;
}

export const invalid = (message: string): ForgeError =>
  new ForgeError("invalid_input", message);

export const cancelled = (): ForgeError =>
  new ForgeError("cancelled", "Tool execution cancelled.");

export const cleanErrorText = (text: string): string => {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length > 300) return `${single.slice(0, 300)}…`;
  return single;
};

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/**
 * JSON-RPC 2.0 request/response correlation shared by every MCP transport.
 *
 * Pending requests are capped, timed out and aborted as a unit: cancellation
 * or a malformed frame terminates the transport instead of leaving a stream
 * or process alive, and an uncertain request is never retried.
 */
export abstract class JsonRpcConnection implements McpConnection {
  protected readonly pending = new Map<number, Pending>();
  private nextId = 1;
  protected closed = false;
  protected failure: string | undefined;
  private connectPromise: Promise<void> | undefined;
  private termination: Promise<void> | undefined;
  negotiatedProtocolVersion: string | undefined;

  constructor(
    protected readonly requestTimeoutMs: number,
    protected readonly secrets: readonly string[] = [],
  ) {}

  /** Write one JSON-RPC payload. May be async for network transports. */
  protected abstract send(payload: Json): void | Promise<void>;

  /** Tear down the underlying process/stream. Must be idempotent. */
  protected abstract terminate(): void | Promise<void>;

  /** Start the transport so `initialize` can be sent. */
  protected abstract start(signal?: AbortSignal): Promise<void>;

  protected clean(input: string): string {
    let text = input;
    for (const value of this.secrets)
      if (value) text = text.split(value).join("[REDACTED]");
    return cleanErrorText(text);
  }

  protected shutdown(cause: Error): void {
    if (this.closed) return;
    this.closed = true;
    const error = new ForgeError(
      cause instanceof ForgeError ? cause.code : "tool",
      this.clean(cause.message),
    );
    this.failure = error.message;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.onAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.termination = Promise.resolve(this.terminate());
    } catch (failure) {
      this.termination = Promise.reject(failure);
    }
    // Observe rejection even when shutdown originated from an event; close()
    // still awaits the original promise and reports cleanup failure.
    void this.termination.catch(() => undefined);
  }

  /** Request-scoped failure that also stops the transport. */
  protected fail(cause: Error): void {
    this.shutdown(cause);
  }
  protected async notify(method: string, params: Json): Promise<void> {
    if (this.closed)
      throw new ForgeError(
        "tool",
        this.failure ?? "MCP server connection is closed.",
      );
    await this.send({ jsonrpc: "2.0", method, params });
    // A failed send shuts the transport down rather than throwing; surface that
    // here so initialization cannot resolve over a dead connection.
    if (this.closed)
      throw new ForgeError(
        "tool",
        this.failure ?? "MCP server connection is closed.",
      );
  }

  /**
   * Feed one already-parsed JSON-RPC message into the correlation table.
   * Malformed frames terminate the connection and settle every pending call.
   */
  protected receive(message: unknown): void {
    const object = (value: unknown): value is Json =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const fail = () =>
      this.shutdown(invalid("Malformed MCP JSON-RPC message."));
    if (!object(message)) {
      fail();
      return;
    }
    if (message.jsonrpc !== "2.0") {
      fail();
      return;
    }
    if ("method" in message) {
      if (
        typeof message.method !== "string" ||
        !message.method ||
        "result" in message ||
        "error" in message ||
        ("params" in message && !object(message.params))
      ) {
        fail();
        return;
      }
      if (!("id" in message)) return;
      if (
        !(
          typeof message.id === "string" ||
          (typeof message.id === "number" && Number.isSafeInteger(message.id))
        )
      ) {
        fail();
        return;
      }
      // Server-triggered requests are never executed locally (no sampling,
      // elicitation, roots or local commands). Reply method-not-found.
      try {
        void Promise.resolve(
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not supported" },
          }),
        ).catch(() => undefined);
      } catch {
        this.shutdown(invalid("MCP reply failed."));
      }
      return;
    }
    if (
      typeof message.id !== "number" ||
      !Number.isSafeInteger(message.id) ||
      "result" in message === "error" in message
    ) {
      fail();
      return;
    }
    if (
      "error" in message &&
      (!object(message.error) ||
        !Number.isInteger(message.error.code) ||
        typeof message.error.message !== "string")
    ) {
      fail();
      return;
    }
    if ("result" in message && !object(message.result)) {
      fail();
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      fail();
      return;
    }
    this.pending.delete(message.id);
    pending.onAbort?.();
    clearTimeout(pending.timer);
    if (object(message.error))
      pending.reject(
        new ForgeError("tool", this.clean(String(message.error.message))),
      );
    else pending.resolve(message.result as Json);
  }

  request(
    method: string,
    params: Json,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Json> {
    if (options?.signal?.aborted) return Promise.reject(cancelled());
    if (this.closed)
      return Promise.reject(
        new ForgeError("tool", this.failure ?? "Connection closed."),
      );
    if (this.pending.size >= MCP_MAX_PENDING)
      return Promise.reject(
        new ForgeError("busy", "Too many pending MCP requests."),
      );
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.has(id)) return;
        // Best-effort cancellation notification, then close the transport so
        // no stream or request is left running. Never replay the call.
        try {
          void Promise.resolve(
            this.send({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: id, reason: "cancelled" },
            }),
          ).catch(() => undefined);
        } catch {
          /* transport already gone */
        }
        this.shutdown(cancelled());
      };
      const timer = setTimeout(
        () => this.shutdown(new ForgeError("tool", "MCP request timed out.")),
        this.requestTimeoutMs,
      );
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        onAbort: () => options?.signal?.removeEventListener("abort", abort),
      });
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        void Promise.resolve(
          this.send({ jsonrpc: "2.0", id, method, params }),
        ).catch((error: unknown) =>
          this.shutdown(
            error instanceof Error ? error : invalid("MCP transport failed."),
          ),
        );
      } catch (error) {
        this.shutdown(
          error instanceof Error ? error : invalid("MCP send failed."),
        );
      }
    });
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelled();
    this.connectPromise ??= (async () => {
      if (this.closed)
        throw new ForgeError(
          "tool",
          this.failure ?? "MCP server connection is closed.",
        );
      await this.start(signal);
      const result = await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "forge-desktop-harness", version: "0.1.0" },
        },
        signal === undefined ? undefined : { signal },
      );
      const version = result.protocolVersion;
      if (!isSupportedProtocolVersion(version))
        throw invalid("Unsupported MCP protocol version.");
      this.negotiatedProtocolVersion = version;
      const caps = result.capabilities;
      const info = result.serverInfo;
      const obj = (value: unknown): value is Json =>
        typeof value === "object" && value !== null && !Array.isArray(value);
      if (
        !obj(caps) ||
        !obj(info) ||
        typeof info.name !== "string" ||
        typeof info.version !== "string"
      )
        throw invalid("Invalid MCP initialize response.");
      for (const key of [
        "tools",
        "resources",
        "prompts",
        "logging",
        "completions",
        "experimental",
        "tasks",
      ]) {
        if (key in caps && !obj(caps[key]))
          throw invalid("Invalid MCP capability.");
      }
      for (const key of ["tools", "resources", "prompts"]) {
        const cap = caps[key];
        if (
          obj(cap) &&
          (("listChanged" in cap && typeof cap.listChanged !== "boolean") ||
            (key === "resources" &&
              "subscribe" in cap &&
              typeof cap.subscribe !== "boolean"))
        )
          throw invalid("Invalid MCP capability flag.");
      }
      if (signal?.aborted) throw cancelled();
      this.negotiatedProtocolVersion = version;
      await this.notify("notifications/initialized", {});
    })();
    try {
      await this.connectPromise;
    } catch (error) {
      this.shutdown(
        error instanceof Error ? error : invalid("Initialization failed."),
      );
      throw error;
    }
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let exhausted = false;
    let receivedBytes = 0;
    for (let page = 0; page < MCP_MAX_PAGES; page += 1) {
      if (signal?.aborted) throw cancelled();
      const result = await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        signal === undefined ? undefined : { signal },
      );
      receivedBytes += Buffer.byteLength(JSON.stringify(result), "utf8");
      if (receivedBytes > MCP_DISCOVERY_LIMIT)
        throw invalid(
          "MCP discovery exceeds the 256 KiB aggregate input budget.",
        );
      const rawTools = result.tools;
      if (!Array.isArray(rawTools))
        throw invalid("MCP tools/list response is missing a tools array.");
      if (rawTools.length > MCP_MAX_TOOLS_PER_SERVER)
        throw invalid("MCP tools/list page exceeds the tool limit.");
      for (const raw of rawTools) {
        const parsed = mcpToolInfoSchema.parse(raw);
        if (seen.has(parsed.name))
          throw invalid("MCP server declared a duplicate tool name.");
        seen.add(parsed.name);
        tools.push(parsed);
        if (tools.length > MCP_MAX_TOOLS_PER_SERVER)
          throw invalid("MCP discovery exceeds the tool limit.");
      }
      checkDiscovery(tools);
      const next = result.nextCursor;
      if (next !== undefined && (typeof next !== "string" || next.length === 0))
        throw invalid("Invalid MCP pagination cursor.");
      if (next === undefined) {
        exhausted = true;
        break;
      }
      if (next.length > 4096)
        throw invalid("MCP pagination cursor is too long.");
      if (next === cursor)
        throw invalid("MCP pagination cursor did not advance.");
      cursor = next;
    }
    if (!exhausted)
      throw invalid("MCP tools/list pagination exceeded its bounds.");
    return tools;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    redactValues: readonly string[] = [],
  ): Promise<McpToolOutcome> {
    const result = await this.request(
      "tools/call",
      { name, arguments: { ...args } },
      signal === undefined ? undefined : { signal },
    );
    const content = result.content;
    if (!Array.isArray(content))
      throw invalid("MCP tools/call response is missing content.");
    if (content.length > 256) throw invalid("MCP tool result is too large.");
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        throw invalid("MCP tool result content item is malformed.");
      const entry = item as Json;
      const text = entry.text;
      if (entry.type !== "text" || typeof text !== "string")
        throw invalid("Only text MCP tool result content is supported.");
      parts.push(text);
    }
    let merged = parts.join("\n");
    for (const value of [...this.secrets, ...redactValues])
      if (value) merged = merged.split(value).join("[REDACTED]");
    const bounded = boundedText(merged);
    return {
      ...bounded,
      isError: result.isError === true || bounded.truncated,
    };
  }

  async close(): Promise<void> {
    this.shutdown(new Error("MCP server connection closed."));
    await this.termination;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get lastFailure(): string | undefined {
    return this.failure;
  }

  static messageLimit(): number {
    return MCP_MAX_MESSAGE_BYTES;
  }
}
