import { StdioMcpConnection } from "../../../mcp/protocol";
import { ForgeError } from "../../../shared/errors";
import type {
  BrowserCommand,
  BrowserPluginConfig,
} from "../../../shared/plugins";
import { type CliCommand, type PrivateLayout, privateEnv } from "./cli-layout";
import { cancelled } from "./result";

/**
 * Native agent-browser MCP tools reachable from the shared browser command
 * contract. There is deliberately no eval/upload/session/extraArgs passthrough;
 * this list is verified against the server before any command is sent.
 */
const REQUIRED_TOOLS = [
  "agent_browser_open",
  "agent_browser_snapshot",
  "agent_browser_read",
  "agent_browser_click",
  "agent_browser_fill",
  "agent_browser_press",
  "agent_browser_scroll",
  "agent_browser_screenshot",
  "agent_browser_close",
] as const;

const MCP_REQUEST_TIMEOUT_MS = 130_000;

export class Session {
  readonly connection: StdioMcpConnection;
  readonly layout: PrivateLayout;
  readonly secrets: readonly string[];
  readonly env: Record<string, string>;
  closed = false;
  browserClosed = false;
  browserTouched = false;
  private verified = false;
  private connecting: Promise<void> | undefined;

  constructor(
    config: BrowserPluginConfig,
    layout: PrivateLayout,
    cli: CliCommand,
    secrets: readonly string[],
  ) {
    this.layout = layout;
    this.secrets = secrets;
    const namespace = layout.namespace || undefined;
    this.env = privateEnv(layout, config, namespace);
    this.connection = new StdioMcpConnection({
      command: cli.command,
      args: [...cli.prefix, "mcp", "--tools", "core"],
      env: this.env,
      cwd: layout.work,
      requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS,
    });
  }

  assertUsable(): void {
    if (this.closed)
      throw new ForgeError(
        "tool",
        "Browser backend is closed. Start a new run to open another browser.",
      );
  }

  async connect(signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    if (this.verified) {
      if (signal?.aborted) throw cancelled();
      return;
    }
    this.connecting ??= (async () => {
      if (signal?.aborted) throw cancelled();
      await this.connection.connect(signal);
      const tools = await this.connection.listTools(signal);
      const names = new Set(tools.map((tool) => tool.name));
      const missing = REQUIRED_TOOLS.filter((name) => !names.has(name));
      if (missing.length)
        throw new ForgeError(
          "tool",
          `agent-browser MCP is missing required core tools: ${missing.join(", ")}.`,
        );
      if (signal?.aborted) throw cancelled();
      this.verified = true;
    })();
    try {
      await this.connecting;
    } catch (error) {
      this.connecting = undefined;
      throw error;
    }
  }

  /** Runtime session/namespace pinning; no caller can supply either value. */
  commonArgs(): Record<string, unknown> {
    return {
      ...(this.layout.namespace ? { namespace: this.layout.namespace } : {}),
      session: this.layout.session,
    };
  }

  toolName(command: BrowserCommand): string {
    switch (command.action) {
      case "navigate":
        return "agent_browser_open";
      case "snapshot":
        return "agent_browser_snapshot";
      case "read":
        return "agent_browser_read";
      case "click":
        return "agent_browser_click";
      case "fill":
        return "agent_browser_fill";
      case "press":
        return "agent_browser_press";
      case "scroll":
        return "agent_browser_scroll";
      case "close":
        return "agent_browser_close";
      case "screenshot":
        throw new ForgeError("tool", "Screenshot uses the private image path.");
    }
  }
}
