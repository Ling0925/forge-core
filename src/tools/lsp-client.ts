import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { cleanupProcess } from "../mcp/cleanup";

export const LSP_MESSAGE_LIMIT = 1024 * 1024;
const HEADER_LIMIT = 8192;
const TRAFFIC_LIMIT = 8 * LSP_MESSAGE_LIMIT;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One invocation, one child: no implicit reconnect, retry, or server fallback. */
export class StdioLspClient {
  private child: ChildProcess | undefined;
  private joined: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | undefined;
  private failure: Error | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private expected: number | undefined;
  private traffic = 0;
  private messages = 0;
  private stderrBytes = 0;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: (() => void) | undefined;

  constructor(private readonly options: Readonly<{
    command: string;
    args: readonly string[];
    cwd: string;
    signal: AbortSignal;
    timeoutMs?: number;
  }>) {}

  start(): void {
    if (this.child || this.disposal) throw new Error("LSP client already used.");
    if (this.options.signal.aborted) throw new Error("LSP invocation cancelled.");
    const env: NodeJS.ProcessEnv = { HOME: homedir() };
    // Deliberately do not forward tokens, proxy settings, NODE_OPTIONS or config.
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.platform === "win32" && process.env.SYSTEMROOT)
      env.SYSTEMROOT = process.env.SYSTEMROOT;
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    this.child = child;
    this.joined = new Promise<void>((resolve) => child.once("close", resolve));
    child.on("error", () => this.fail("LSP server failed to start."));
    child.on("exit", () => this.fail("LSP server exited."));
    child.stdin?.on("error", () => this.fail("LSP transport write failed."));
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    // Never disclose stderr: it may contain source text, credentials or paths.
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > LSP_MESSAGE_LIMIT)
        this.fail("LSP stderr limit exceeded.");
    });
    this.abort = () => this.fail("LSP invocation cancelled.");
    this.options.signal.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(
      () => this.fail("LSP invocation timed out."),
      this.options.timeoutMs ?? 10_000,
    );
    if (this.options.signal.aborted) this.abort();
  }

  private fail(message: string): void {
    if (!this.failure) this.failure = new Error(message);
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    // Store cleanup and surface any error through the caller's awaited dispose.
    void this.dispose().catch(() => undefined);
  }

  private consume(chunk: Buffer): void {
    if (this.failure || this.disposal) return;
    this.traffic += chunk.length;
    if (this.traffic > TRAFFIC_LIMIT) {
      this.fail("LSP traffic limit exceeded.");
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.expected === undefined) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > HEADER_LIMIT)
            this.fail("LSP header limit exceeded.");
          return;
        }
        if (end > HEADER_LIMIT) {
          this.fail("LSP header limit exceeded.");
          return;
        }
        const lines = this.buffer.subarray(0, end).toString("ascii").split("\r\n");
        const lengths = lines.filter((line) => /^Content-Length:/i.test(line));
        const match = lengths.length === 1
          ? /^Content-Length:\s*([0-9]+)\s*$/i.exec(lengths[0] ?? "")
          : null;
        const size = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(size) || size < 1 || size > LSP_MESSAGE_LIMIT) {
          this.fail("LSP message length invalid or exceeds 1 MiB.");
          return;
        }
        this.expected = size;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.expected) return;
      const bytes = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = undefined;
      if (++this.messages > 256) {
        this.fail("LSP message count exceeded.");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        this.fail("LSP message is not valid UTF-8 JSON.");
        return;
      }
      this.handle(message);
      if (this.failure || this.disposal) return;
    }
  }

  private handle(value: unknown): void {
    if (!object(value) || value.jsonrpc !== "2.0") {
      this.fail("Invalid LSP JSON-RPC message.");
      return;
    }
    if (typeof value.method === "string") {
      // No server-initiated edits, command execution, registration or prompts.
      if ("id" in value) {
        if (!(typeof value.id === "string" || Number.isSafeInteger(value.id))) {
          this.fail("Invalid LSP request id.");
          return;
        }
        try {
          this.send({ jsonrpc: "2.0", id: value.id,
            error: { code: -32601, message: "Server requests are not supported" } });
        } catch { this.fail("LSP server-request rejection failed."); }
      }
      return;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) ||
        (("result" in value) === ("error" in value))) {
      this.fail("Invalid LSP response.");
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) {
      this.fail("Unexpected LSP response id.");
      return;
    }
    this.pending.delete(value.id);
    if ("error" in value) pending.reject(new Error("LSP server rejected the query."));
    else pending.resolve(value.result);
  }

  private send(value: ObjectValue): void {
    if (this.failure) throw this.failure;
    if (this.disposal || !this.child?.stdin?.writable)
      throw new Error("LSP transport is closed.");
    const body = Buffer.from(JSON.stringify(value), "utf8");
    // didOpen may contain a 2 MiB file with JSON escaping.
    if (body.length > 16 * LSP_MESSAGE_LIMIT)
      throw new Error("LSP outgoing message limit exceeded.");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  notify(method: string, params: ObjectValue): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: ObjectValue): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 4) return Promise.reject(new Error("LSP pending limit exceeded."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposal = Promise.resolve().then(async () => {
        if (this.timer) clearTimeout(this.timer);
        if (this.abort) this.options.signal.removeEventListener("abort", this.abort);
        if (!this.failure) this.failure = new Error("LSP client disposed.");
        for (const pending of this.pending.values()) pending.reject(this.failure);
        this.pending.clear();
        this.buffer = Buffer.alloc(0);
        if (this.child) {
          await cleanupProcess(this.child);
          // cleanupProcess owns the process group; join stdio/close as well.
          this.child.stdin?.destroy();
          this.child.stdout?.destroy();
          this.child.stderr?.destroy();
          await this.joined;
        }
      });
    }
    return this.disposal;
  }
}
