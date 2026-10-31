import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { cleanupProcess } from "../mcp/cleanup";

export const LSP_MESSAGE_LIMIT = 1024 * 1024;
const HEADER_LIMIT = 8192;
const TRAFFIC_LIMIT = 8 * LSP_MESSAGE_LIMIT;

type ObjectValue = Record<string, unknown>;
type Invocation = {
  traffic: number;
  messages: number;
  stderrBytes: number;
  pending: number;
};
const object = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class StdioLspClient {
  private child: ChildProcess | undefined;
  private joined: Promise<void> = Promise.resolve();
  private disposal: Promise<void> | undefined;
  private failure: Error | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private expected: number | undefined;
  private frameBytes = 0;
  private invocations = new Map<Invocation, (error: Error) => void>();
  private cancelled = new Set<number>();
  private nextId = 1;
  private pending = new Map<
    number,
    {
      invocation: Invocation;
      method: string;
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly options: Readonly<{
      command: string;
      args: readonly string[];
      cwd: string;
      timeoutMs?: number;
      onFailure?: () => void;
    }>,
  ) {}

  start(): void {
    if (this.child || this.disposal)
      throw new Error("LSP client already used.");
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
      for (const invocation of this.invocations.keys()) {
        invocation.stderrBytes += chunk.length;
        if (invocation.stderrBytes > LSP_MESSAGE_LIMIT)
          this.fail("LSP stderr limit exceeded.");
      }
    });
  }

  private fail(message: string): Error {
    if (!this.failure) {
      this.failure = new Error(message);
      this.options.onFailure?.();
    }
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    for (const reject of this.invocations.values()) reject(this.failure);
    // Store cleanup and surface any error through the caller's awaited dispose.
    void this.dispose().catch(() => undefined);
    return this.failure;
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
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
        const lines = this.buffer
          .subarray(0, end)
          .toString("ascii")
          .split("\r\n");
        const lengths = lines.filter((line) => /^Content-Length:/i.test(line));
        const match =
          lengths.length === 1
            ? /^Content-Length:\s*([0-9]+)\s*$/i.exec(lengths[0] ?? "")
            : null;
        const size = match ? Number(match[1]) : Number.NaN;
        if (
          !Number.isSafeInteger(size) ||
          size < 1 ||
          size > LSP_MESSAGE_LIMIT
        ) {
          this.fail("LSP message length invalid or exceeds 1 MiB.");
          return;
        }
        this.expected = size;
        this.frameBytes = end + 4 + size;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.expected) return;
      const bytes = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = undefined;
      let message: unknown;
      try {
        message = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        this.fail("LSP message is not valid UTF-8 JSON.");
        return;
      }
      this.handle(message, this.frameBytes);
      if (this.failure) return;
    }
  }

  private handle(value: unknown, bytes: number): void {
    if (!object(value) || value.jsonrpc !== "2.0") {
      this.fail("Invalid LSP JSON-RPC message.");
      return;
    }
    const pending =
      typeof value.id === "number" ? this.pending.get(value.id) : undefined;
    const invocations =
      typeof value.method === "string" || pending?.method === "initialize"
        ? this.invocations.keys()
        : pending
          ? [pending.invocation]
          : [];
    for (const invocation of invocations) {
      invocation.traffic += bytes;
      if (invocation.traffic > TRAFFIC_LIMIT) {
        this.fail("LSP traffic limit exceeded.");
        return;
      }
      if (++invocation.messages > 256) {
        this.fail("LSP message count exceeded.");
        return;
      }
    }
    if (typeof value.method === "string") {
      // No server-initiated edits, command execution, registration or prompts.
      if ("id" in value) {
        if (!(typeof value.id === "string" || Number.isSafeInteger(value.id))) {
          this.fail("Invalid LSP request id.");
          return;
        }
        try {
          this.send({
            jsonrpc: "2.0",
            id: value.id,
            error: {
              code: -32601,
              message: "Server requests are not supported",
            },
          });
        } catch {
          this.fail("LSP server-request rejection failed.");
        }
      }
      return;
    }
    if (
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      "result" in value === "error" in value
    ) {
      this.fail("Invalid LSP response.");
      return;
    }
    if (!pending) {
      if (this.cancelled.delete(value.id)) return;
      this.fail("Unexpected LSP response id.");
      return;
    }
    this.pending.delete(value.id);
    if ("error" in value)
      pending.reject(new Error("LSP server rejected the query."));
    else pending.resolve(value.result);
  }

  private send(value: ObjectValue): void {
    if (this.failure) throw this.failure;
    if (!this.child?.stdin?.writable)
      throw this.fail("LSP transport is closed.");
    const body = Buffer.from(JSON.stringify(value), "utf8");
    // didOpen may contain a 2 MiB file with JSON escaping.
    if (body.length > 16 * LSP_MESSAGE_LIMIT)
      throw this.fail("LSP outgoing message limit exceeded.");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  notify(method: string, params: ObjectValue): void {
    if (this.disposal) throw new Error("LSP transport is closed.");
    this.send({ jsonrpc: "2.0", method, params });
  }

  closeDocument(uri: string): void {
    if (!this.failure && !this.disposal)
      this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  private sendRequest(
    method: string,
    params: ObjectValue,
    signal: AbortSignal,
    invocation: Invocation,
  ): Promise<unknown> {
    if (this.disposal)
      return Promise.reject(new Error("LSP transport is closed."));
    if (signal.aborted)
      return Promise.reject(new Error("LSP invocation cancelled."));
    if (invocation.pending >= 4)
      return Promise.reject(new Error("LSP pending limit exceeded."));
    const id = this.nextId++;
    invocation.pending++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        invocation.pending--;
        this.cancelled.add(id);
        signal.removeEventListener("abort", abort);
        reject(new Error("LSP invocation cancelled."));
        try {
          this.notify("$/cancelRequest", { id });
        } catch {
          this.fail("LSP transport write failed.");
        }
      };
      this.pending.set(id, {
        invocation,
        method,
        resolve: (result) => {
          invocation.pending--;
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          invocation.pending--;
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
        signal.addEventListener("abort", abort, { once: true });
      } catch (error) {
        if (this.pending.delete(id)) invocation.pending--;
        reject(error);
      }
    });
  }

  async invoke<T>(
    signal: AbortSignal,
    action: (
      request: (method: string, params: ObjectValue) => Promise<unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) throw new Error("LSP invocation cancelled.");
    if (this.failure) throw this.failure;
    const invocation = { traffic: 0, messages: 0, stderrBytes: 0, pending: 0 };
    let abort = () => {};
    const timer = setTimeout(
      () => this.fail("LSP invocation timed out."),
      this.options.timeoutMs ?? 10_000,
    );
    try {
      return await Promise.race([
        new Promise<never>((_resolve, reject) => {
          this.invocations.set(invocation, reject);
          abort = () => reject(new Error("LSP invocation cancelled."));
          signal.addEventListener("abort", abort, { once: true });
        }),
        action((method, params) =>
          this.sendRequest(method, params, signal, invocation),
        ),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.invocations.delete(invocation);
    }
  }

  async joinFailure(): Promise<void> {
    if (this.failure || this.disposal) await this.dispose();
  }

  dispose(reason?: Error): Promise<void> {
    if (!this.disposal) {
      this.disposal = Promise.resolve().then(async () => {
        const error =
          this.failure ?? reason ?? new Error("LSP client disposed.");
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        for (const reject of this.invocations.values()) reject(error);
        this.failure ??= error;
        this.cancelled.clear();
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
