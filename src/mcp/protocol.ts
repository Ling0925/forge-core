import { type ChildProcess, spawn } from "node:child_process";
import { ForgeError } from "../shared/errors";
import { cleanupProcess } from "./cleanup";
import { type Json, JsonRpcConnection, invalid } from "./rpc";
import { MCP_MAX_MESSAGE_BYTES } from "./types";

/**
 * A real stdio MCP connection: newline-framed JSON-RPC 2.0 over the child's
 * stdin/stdout, with byte caps, pending-request caps, per-request timeouts,
 * cancellation notifications and full process-group shutdown.
 */
export class StdioMcpConnection extends JsonRpcConnection {
  private child: ChildProcess | undefined;
  private buffer = "";

  constructor(
    private readonly options: Readonly<{
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      requestTimeoutMs: number;
    }>,
  ) {
    super(options.requestTimeoutMs, Object.values(options.env));
  }

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

  protected async start(): Promise<void> {
    const child = spawn(this.options.command, [...this.options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env(),
      // New process group so the whole tree can be terminated on disposal.
      detached: true,
      windowsHide: true,
    });
    this.child = child;
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
  }

  private consume(buffer: string): string {
    let rest = buffer;
    for (;;) {
      const index = rest.indexOf("\n");
      if (index < 0) {
        if (Buffer.byteLength(rest, "utf8") > MCP_MAX_MESSAGE_BYTES) {
          this.shutdown(
            invalid("MCP server exceeded the 1 MiB message ceiling."),
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
          invalid("MCP server exceeded the 1 MiB message ceiling."),
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
      this.receive(message);
      if (this.closed) return "";
    }
  }

  protected send(payload: Json): void {
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

  protected async terminate(): Promise<void> {
    if (this.child) {
      await cleanupProcess(this.child);
    }
  }
}
