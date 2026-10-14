import { type ChildProcess, spawn } from "node:child_process";
import { ForgeError } from "../shared/errors";
import { boundedText, checkDiscovery } from "./bounds";
import { cleanupProcess } from "./cleanup";
import {
  MCP_DISCOVERY_LIMIT,
  MCP_MAX_MESSAGE_BYTES,
  MCP_MAX_PAGES,
  MCP_MAX_PENDING,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_PROTOCOL_VERSION,
  type McpToolInfo,
  mcpToolInfoSchema,
} from "./types";

type Json = Record<string, unknown>;

const invalid = (message: string): ForgeError =>
  new ForgeError("invalid_input", message);

interface Pending {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

const cleanErrorText = (text: string): string => {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length > 300) return `${single.slice(0, 300)}…`;
  return single;
};

/**
 * A real stdio MCP connection: newline-framed JSON-RPC 2.0 over the child's
 * stdin/stdout, with byte caps, pending-request caps, per-request timeouts,
 * cancellation notifications and full process-group shutdown.
 */
export class StdioMcpConnection {
  private cleanup: Promise<void> | undefined;
  private child: ChildProcess | undefined;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private failure: string | undefined;
  private waiters: ((error: Error) => void)[] = [];
  private connectPromise: Promise<void> | undefined;
  negotiatedProtocolVersion: string | undefined;

  constructor(
    private readonly options: Readonly<{
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      requestTimeoutMs: number;
    }>,
  ) {}

  private env(): NodeJS.ProcessEnv {
    // Minimal inherited environment: PATH/TMPDIR plus explicitly approved
    // names only. Credentials, proxies and API keys are never forwarded.
    const env: Record<string, string> = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.platform === "win32" && process.env.SYSTEMROOT)
      env.SYSTEMROOT = process.env.SYSTEMROOT;
    return { ...env, ...this.options.env };
  }

  private spawn(): ChildProcess {
    const child = spawn(this.options.command, [...this.options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env(),
      // New process group so the whole tree can be terminated on disposal.
      detached: true,
      windowsHide: true,
    });
    child.stdin?.on("error", (error) => this.shutdown(error));
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let stderr = "";
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr = `${stderr}${chunk}`.slice(0, 4000);
    });
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.buffer = this.consume(this.buffer);
    });
    child.on("error", (error) => this.shutdown(error));
    child.on("exit", () => {
      const message = this.closed
        ? "MCP server exited."
        : stderr.trim() || "MCP server exited unexpectedly.";
      this.shutdown(new Error(message));
    });
    child.on("close", () => {
      if (!this.closed) {
        const message = stderr.trim() || "MCP server exited unexpectedly.";
        this.shutdown(new Error(message));
      }
    });
    return child;
  }

  private consume(buffer: string): string {
    let rest = buffer;
    for (;;) {
      const index = rest.indexOf("\n");
      if (index < 0) {
        if (Buffer.byteLength(rest, "utf8") > MCP_MAX_MESSAGE_BYTES) {
          this.shutdown(
            new ForgeError(
              "tool",
              "MCP server exceeded the 1 MiB message ceiling.",
            ),
          );
          return "";
        }
        return rest;
      }
      const line = rest.slice(0, index);
      rest = rest.slice(index + 1);
      if (line.trim().length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MCP_MAX_MESSAGE_BYTES) {
        this.shutdown(
          new ForgeError(
            "tool",
            "MCP server exceeded the 1 MiB message ceiling.",
          ),
        );
        return "";
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.shutdown(invalid("MCP server sent malformed JSON."));
        return "";
      }
      if (
        typeof message !== "object" ||
        message === null ||
        Array.isArray(message)
      ) {
        this.shutdown(invalid("MCP server sent a non-object message."));
        return "";
      }
      this.handle(message as Json);
      if (this.closed) return "";
    }
  }

  private handle(message: Json): void {
    const object = (value: unknown): value is Json =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const fail = () =>
      this.shutdown(invalid("Malformed MCP JSON-RPC message."));
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
      try {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not supported" },
        });
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

  private clean(input: string): string {
    let text = input;
    for (const value of Object.values(this.options.env))
      if (value) text = text.split(value).join("[REDACTED]");
    return cleanErrorText(text);
  }

  private shutdown(cause: Error): void {
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
    for (const waiter of this.waiters.splice(0)) waiter(error);
    if (this.child) {
      this.cleanup = cleanupProcess(this.child);
      // Observe rejection even when shutdown originated from an event. close()
      // still awaits the original promise and reports cleanup failure.
      void this.cleanup.catch(() => undefined);
    }
  }

  private send(payload: Json): void {
    if (this.closed)
      throw new ForgeError(
        "tool",
        this.failure ?? "MCP server connection is closed.",
      );
    const child = this.child;
    if (!child?.stdin)
      throw new ForgeError("tool", "MCP server connection is closed.");
    const text = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(text, "utf8") > MCP_MAX_MESSAGE_BYTES)
      throw new ForgeError("tool", "MCP request exceeds the message ceiling.");
    if (!child.stdin.write(text))
      this.shutdown(new ForgeError("tool", "MCP server input is blocked."));
  }

  request(
    method: string,
    params: Json,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Json> {
    if (options?.signal?.aborted)
      return Promise.reject(
        new ForgeError("cancelled", "Tool execution cancelled."),
      );
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
      const abort = () =>
        this.shutdown(new ForgeError("cancelled", "Tool execution cancelled."));
      const timer = setTimeout(
        () => this.shutdown(new ForgeError("tool", "MCP request timed out.")),
        this.options.requestTimeoutMs,
      );
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        onAbort: () => options?.signal?.removeEventListener("abort", abort),
      });
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.shutdown(
          error instanceof Error ? error : invalid("MCP send failed."),
        );
      }
    });
  }

  notify(method: string, params: Json): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
      throw new ForgeError("cancelled", "Tool execution cancelled.");
    this.connectPromise ??= (async () => {
      if (this.closed)
        throw new ForgeError(
          "tool",
          this.failure ?? "MCP server connection is closed.",
        );
      const child = this.spawn();
      this.child = child;
      const failure = new Promise<never>((_, reject) => {
        this.waiters.push(reject);
      });
      const initialize = this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "forge-desktop-harness", version: "0.1.0" },
        },
        signal === undefined ? undefined : { signal },
      );
      const result = await Promise.race([initialize, failure]);
      const version = result.protocolVersion;
      if (version !== MCP_PROTOCOL_VERSION)
        throw invalid("Unsupported MCP protocol version.");
      const caps = result.capabilities;
      const info = result.serverInfo;
      const obj = (v: unknown): v is Json =>
        typeof v === "object" && v !== null && !Array.isArray(v);
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
      if (signal?.aborted)
        throw new ForgeError("cancelled", "Tool execution cancelled.");
      this.negotiatedProtocolVersion = version;
      this.notify("notifications/initialized", {});
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
      if (signal?.aborted)
        throw new ForgeError("cancelled", "Tool execution cancelled.");
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
    // Reaching the page bound without an explicit end means the server never
    // stopped paginating; that is a bounded-discovery violation, not a result.
    if (!exhausted)
      throw invalid("MCP tools/list pagination exceeded its bounds.");
    return tools;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    redactValues: readonly string[] = [],
  ): Promise<Readonly<{ text: string; isError: boolean; truncated: boolean }>> {
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
    for (const value of [...Object.values(this.options.env), ...redactValues])
      if (value) merged = merged.split(value).join("[REDACTED]");
    const bounded = boundedText(merged);
    return {
      ...bounded,
      isError: result.isError === true || bounded.truncated,
    };
  }

  async close(): Promise<void> {
    this.shutdown(new Error("MCP server connection closed."));
    await this.cleanup;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get lastFailure(): string | undefined {
    return this.failure;
  }
}
