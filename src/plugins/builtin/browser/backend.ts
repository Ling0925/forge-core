import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StdioMcpConnection } from "../../../mcp/protocol";
import { ForgeError } from "../../../shared/errors";
import {
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserPluginConfig,
  browserPluginConfigSchema,
} from "../../../shared/plugins";

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

/** BrowserCommandResult.text is capped by the shared schema at 24,000 chars. */
const RESULT_TEXT_LIMIT = 24_000;
/** 700,000 base64 chars decode to at most 525,000 bytes. */
const IMAGE_MAX_BASE64_CHARS = 700_000;
const IMAGE_MAX_BYTES = Math.floor(IMAGE_MAX_BASE64_CHARS / 4) * 3;
const MCP_REQUEST_TIMEOUT_MS = 130_000;
const CLEANUP_TIMEOUT_MS = 12_000;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface AgentBrowserBackend {
  execute(
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult>;
  check(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

interface CliCommand {
  readonly command: string;
  /** Arguments that must precede `mcp ...` (used when the CLI is a JS entry). */
  readonly prefix: readonly string[];
}

interface PrivateLayout {
  /** Private state directory under the caller's home. */
  readonly root: string;
  /** Short temp dirs used only when the state path breaks Unix socket limits. */
  readonly tmpRoot: string | undefined;
  readonly socketRoot: string | undefined;
  readonly home: string;
  readonly work: string;
  readonly tmp: string;
  readonly config: string;
  readonly socket: string;
  readonly namespace: string;
  readonly session: string;
  readonly screens: string;
}

const cancelled = (): ForgeError =>
  new ForgeError("cancelled", "Browser operation cancelled.");

const invalidResult = (): ForgeError =>
  new ForgeError("tool", "agent-browser returned an invalid MCP tool result.");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets)
    if (secret) result = result.split(secret).join("[REDACTED]");
  return result;
}

function boundText(text: string): string {
  if (text.length <= RESULT_TEXT_LIMIT) return text;
  const marker = "\n[Browser output truncated]";
  let end = RESULT_TEXT_LIMIT - marker.length;
  // Never split a surrogate pair; the schema counts UTF-16 code units.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

function cleanText(text: string, secrets: readonly string[]): string {
  return boundText(redact(text, secrets));
}

function requireNonEmptyResult(
  value: string,
  secrets: readonly string[],
): string {
  const text = cleanText(value.trim(), secrets);
  return text.length ? text : "Browser command completed.";
}

interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * Project one native MCP tools/call result. The raw response is kept so a
 * private screenshot is not truncated by the 48 KiB rich-content cap; the
 * model-facing text is reduced to the tool's real payload instead of echoing
 * agent-browser's duplicated stdout/lifecycle JSON.
 */
function parseToolResult(raw: Readonly<Record<string, unknown>>): ToolResult {
  const content = raw.content;
  if (!Array.isArray(content)) throw invalidResult();
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) throw invalidResult();
    const type = textValue(item.type);
    if (type === "text") {
      const text = textValue(item.text);
      if (text === undefined) throw invalidResult();
      parts.push(text);
      continue;
    }
    // Images are read only from the private screenshot path. Other rich
    // content is outside the shared browser command contract.
    if (
      type !== "image" &&
      type !== "resource" &&
      type !== "resource_link" &&
      type !== "audio"
    )
      throw invalidResult();
  }
  const structured = isRecord(raw.structuredContent)
    ? raw.structuredContent
    : undefined;
  const response =
    structured && isRecord(structured.response)
      ? structured.response
      : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const upstreamError =
    response && response.success === false
      ? (textValue(response.error) ?? "agent-browser reported an error.")
      : undefined;
  let text = upstreamError;
  if (data && text === undefined) {
    for (const key of [
      "snapshot",
      "content",
      "text",
      "value",
      "url",
      "title",
      "path",
    ]) {
      const candidate = textValue(data[key]);
      if (candidate) {
        text = candidate;
        break;
      }
    }
    if (text === undefined) {
      if (typeof data.closed === "boolean")
        text = data.closed
          ? "Browser closed."
          : "Browser close was not confirmed.";
      else if (typeof data.clicked === "string")
        text = `Clicked ${data.clicked}.`;
      else if (typeof data.filled === "string") text = `Filled ${data.filled}.`;
      else if (typeof data.pressed === "string")
        text = `Pressed ${data.pressed}.`;
      else if (data.scrolled === true) text = "Scrolled.";
    }
  }
  if (text === undefined) text = parts.join("\n");
  return {
    text: text.trim(),
    isError: raw.isError === true || upstreamError !== undefined,
  };
}

function hostAllowed(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const host = hostname.toLowerCase();
  return allowedDomains.some((pattern) => {
    const domain = pattern.toLowerCase();
    if (domain === "*") return true;
    if (domain.startsWith("*.")) {
      const base = domain.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === domain;
  });
}

function assertNavigable(
  urlText: string,
  allowedDomains: readonly string[],
): void {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ForgeError(
      "invalid_input",
      "Browser navigation requires a valid URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !hostAllowed(url.hostname, allowedDomains)
  )
    throw new ForgeError(
      "invalid_input",
      "Browser navigation requires a credential-free HTTP(S) URL on a configured allowed hostname.",
    );
}

/** The exact agent-browser release this adapter's tool mapping was verified against. */
const PINNED_AGENT_BROWSER_VERSION = "0.39.2";

/**
 * Resolve the pinned agent-browser entry from this package only. The published
 * dependency is optional (agent-browser declares Node >=24, and package
 * managers legitimately skip it), so a dev alias can also provide the same
 * exact tarball for local runs. An unvetted PATH binary is never used.
 */
function pinnedEntry(): string {
  const require = createRequire(import.meta.url);
  const failures: string[] = [];
  for (const specifier of [
    "agent-browser/bin/agent-browser.js",
    "agent-browser-dev/bin/agent-browser.js",
  ]) {
    try {
      const entry = require.resolve(specifier);
      const manifest = require(join(dirname(entry), "..", "package.json")) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.version !== PINNED_AGENT_BROWSER_VERSION) {
        failures.push(`${specifier}@${String(manifest.version)}`);
        continue;
      }
      return entry;
    } catch {
      /* try the next provided location */
    }
  }
  throw new ForgeError(
    "tool",
    `agent-browser ${PINNED_AGENT_BROWSER_VERSION} is not installed in this package${
      failures.length ? ` (found ${failures.join(", ")})` : ""
    }. Install the pinned dependency or configure an explicit executablePath.`,
  );
}

function cliFor(config: BrowserPluginConfig): CliCommand {
  // A user-supplied executable is an explicit choice and is used verbatim.
  if (config.executablePath !== "agent-browser")
    return { command: config.executablePath, prefix: [] };
  const entry = pinnedEntry();
  // The official wrapper is a Node entry point; spawning it through the
  // current Node keeps it usable without a postinstall-patched shim.
  return { command: process.execPath, prefix: [entry] };
}

function privateEnv(
  layout: PrivateLayout,
  config: BrowserPluginConfig,
  namespace: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: layout.home,
    USERPROFILE: layout.home,
    TMPDIR: layout.tmp,
    TMP: layout.tmp,
    TEMP: layout.tmp,
    APPDATA: join(layout.root, "config"),
    LOCALAPPDATA: join(layout.root, "data"),
    XDG_CACHE_HOME: join(layout.root, "cache"),
    XDG_CONFIG_HOME: join(layout.root, "config"),
    XDG_DATA_HOME: join(layout.root, "data"),
    AGENT_BROWSER_CONFIG: layout.config,
    AGENT_BROWSER_SOCKET_DIR: layout.socket,
    AGENT_BROWSER_SESSION: layout.session,
    AGENT_BROWSER_NO_WEBMCP: "1",
  };
  if (namespace) env.AGENT_BROWSER_NAMESPACE = namespace;
  // "*" is Forge's explicit allow-all grant. Omit the upstream filter rather
  // than passing a literal wildcard as a hostname. The empty-list action guard
  // below still denies all browser actions when no grant has been configured.
  if (config.allowedDomains.length && !config.allowedDomains.includes("*"))
    env.AGENT_BROWSER_ALLOWED_DOMAINS = config.allowedDomains.join(",");
  if (config.browserExecutablePath)
    env.AGENT_BROWSER_EXECUTABLE_PATH = config.browserExecutablePath;
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createLayout(homeInput: string): Promise<PrivateLayout> {
  // Prefer the caller's protected home. Long Unix socket paths require a
  // short temp location for Chrome's ephemeral profile/SingletonSocket. Every
  // such directory has a reserved `credentials` segment so Forge file, search
  // and publication guards refuse it even when it falls inside a workspace.
  // Do not set --profile: upstream refuses it together with --allowed-domains.
  const base = resolve(homeInput);
  const root = join(
    base,
    "browser-plugin",
    `run-${randomBytes(8).toString("hex")}`,
  );
  const home = join(root, "home");
  const work = join(root, "work");
  const tmpBase = join(root, "credentials-tmp");
  const config = join(root, "agent-browser.json");
  const screens = join(root, "screens");
  const namespace = `n${randomBytes(4).toString("hex")}`;
  const session = `f${randomBytes(8).toString("hex")}`;
  let socketRoot: string | undefined;
  let tmpRoot: string | undefined;
  try {
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(work, { recursive: true, mode: 0o700 }),
      mkdir(screens, { recursive: true, mode: 0o700 }),
      mkdir(join(root, "cache"), { recursive: true, mode: 0o700 }),
      mkdir(join(root, "config"), { recursive: true, mode: 0o700 }),
      mkdir(join(root, "data"), { recursive: true, mode: 0o700 }),
    ]);
    // Explicit `--config` prevents user/project config discovery. No plugins,
    // profiles, credentials or persisted state are imported.
    await writeFile(config, '{"plugins":[]}\n', { mode: 0o600 });
    // Chrome's Unix-domain SingletonSocket also lives under TMPDIR and must
    // stay below the same OS limit. Keep TMPDIR under home when it fits;
    // otherwise use a short private, sensitive-path-protected directory.
    // Never rely on tmpdir() itself being short.
    const tmpFinal = (base: string) =>
      join(base, "com.google.Chrome.XXXXXX", "SingletonSocket");
    let tmp = tmpBase;
    if (
      process.platform !== "win32" &&
      Buffer.byteLength(tmpFinal(tmp), "utf8") > 100
    ) {
      const candidates = [tmpdir(), "/tmp"];
      let chosen: string | undefined;
      for (const base of candidates) {
        const probe = join(
          base,
          "forge-ab-credentials-tmp-XXXXXX",
          "com.google.Chrome.XXXXXX",
          "SingletonSocket",
        );
        if (Buffer.byteLength(probe, "utf8") > 100) continue;
        if (!(await exists(base))) continue;
        chosen = await mkdtemp(join(base, "forge-ab-credentials-tmp-"));
        break;
      }
      if (!chosen || Buffer.byteLength(tmpFinal(chosen), "utf8") > 100) {
        if (chosen)
          await rm(chosen, { recursive: true, force: true }).catch(
            () => undefined,
          );
        throw new ForgeError(
          "tool",
          "No private temp directory is short enough for this isolated Chrome profile.",
        );
      }
      tmpRoot = chosen;
      tmp = chosen;
    }
    // The daemon appends /namespaces/<ns>/run itself, and Unix sockets cap at
    // 104 bytes. Keep the socket under home when possible; otherwise use a
    // short random temp directory (socket only, no browser state).
    let socket = join(root, "socket");
    const finalPath = (base: string) =>
      join(base, "namespaces", namespace, "run", `${session}.sock`);
    if (
      process.platform !== "win32" &&
      Buffer.byteLength(finalPath(socket), "utf8") > 100
    ) {
      const candidates = [tmpdir(), "/tmp"];
      let chosen: string | undefined;
      for (const base of candidates) {
        // Cheap pre-check: prefix + fixed longest random suffix must fit too.
        const probe = join(
          base,
          "forge-ab-credentials-sock-XXXXXX",
          "namespaces",
          namespace,
          "run",
          `${session}.sock`,
        );
        if (Buffer.byteLength(probe, "utf8") > 100) continue;
        if (!(await exists(base))) continue;
        chosen = await mkdtemp(join(base, "forge-ab-credentials-sock-"));
        break;
      }
      if (!chosen || Buffer.byteLength(finalPath(chosen), "utf8") > 100) {
        if (chosen)
          await rm(chosen, { recursive: true, force: true }).catch(
            () => undefined,
          );
        throw new ForgeError(
          "tool",
          "No private socket directory is short enough for this isolated agent-browser session.",
        );
      }
      socketRoot = chosen;
      socket = chosen;
    }
    await Promise.all([
      mkdir(socket, { recursive: true, mode: 0o700 }),
      mkdir(tmp, { recursive: true, mode: 0o700 }),
    ]);
    return {
      root,
      tmpRoot,
      socketRoot,
      home,
      work,
      tmp,
      config,
      socket,
      namespace,
      session,
      screens,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (socketRoot)
      await rm(socketRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    if (tmpRoot)
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    throw error;
  }
}

class Backend implements AgentBrowserBackend {
  private readonly connection: StdioMcpConnection;
  private readonly cli: CliCommand;
  private readonly layout: PrivateLayout;
  private readonly allowedDomains: readonly string[];
  private readonly secrets: readonly string[];
  private readonly env: Record<string, string>;
  private closed = false;
  private browserClosed = false;
  private browserTouched = false;
  private verified = false;
  private connecting: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;

  constructor(
    config: BrowserPluginConfig,
    layout: PrivateLayout,
    cli: CliCommand,
    secrets: readonly string[],
  ) {
    this.layout = layout;
    this.cli = cli;
    this.allowedDomains = [...config.allowedDomains];
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

  private assertUsable(): void {
    if (this.closed)
      throw new ForgeError(
        "tool",
        "Browser backend is closed. Start a new run to open another browser.",
      );
  }

  private async connect(signal?: AbortSignal): Promise<void> {
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
  private commonArgs(): Record<string, unknown> {
    return {
      ...(this.layout.namespace ? { namespace: this.layout.namespace } : {}),
      session: this.layout.session,
    };
  }

  private actionArgs(
    command: BrowserCommand,
  ): Readonly<Record<string, unknown>> {
    const common = this.commonArgs();
    switch (command.action) {
      case "navigate":
        return { ...common, url: command.url, headed: false, webmcp: false };
      case "snapshot":
        return { ...common, interactive: true };
      case "read":
        return { ...common };
      case "click":
        return { ...common, selector: command.selector };
      case "fill":
        return { ...common, selector: command.selector, text: command.text };
      case "press":
        return { ...common, key: command.key };
      case "scroll":
        return {
          ...common,
          direction: command.direction,
          amount: command.pixels ?? 500,
        };
      case "close":
        return { ...common };
      case "screenshot":
        throw new ForgeError("tool", "Screenshot uses the private image path.");
    }
  }

  private toolName(command: BrowserCommand): string {
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

  private async requestTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.connection.request(
      "tools/call",
      { name, arguments: { ...args } },
      signal === undefined ? undefined : { signal },
    );
    // The transport caps a frame at 1 MiB; retain a local guard so oversized
    // structured content cannot be mistaken for a usable browser result.
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TOOL_RESULT_BYTES
    )
      throw new ForgeError(
        "tool",
        "agent-browser tool result exceeds the browser adapter limit.",
      );
    return result;
  }

  private async closeViaMcp(): Promise<void> {
    if (this.connection.isClosed) return;
    const result = await this.requestTool(
      "agent_browser_close",
      this.commonArgs(),
      AbortSignal.timeout(5_000),
    );
    if (parseToolResult(result).isError)
      throw new ForgeError(
        "tool",
        "agent-browser did not confirm browser close.",
      );
  }

  /** Artifacts agent-browser writes for exactly this private session. */
  private sessionArtifacts(): readonly string[] {
    const base = join(
      this.layout.socket,
      "namespaces",
      this.layout.namespace,
      "run",
    );
    return [
      join(base, `${this.layout.session}.sock`),
      join(base, `${this.layout.session}.pid`),
      join(base, `${this.layout.session}.port`),
    ];
  }

  private async daemonAlive(): Promise<boolean> {
    for (const path of this.sessionArtifacts())
      if (await exists(path)) return true;
    return false;
  }

  /** Wait, bounded, for the daemon to remove this session's own artifacts. */
  private async daemonGone(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      if (!(await this.daemonAlive())) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Close only this backend's private session through a fresh CLI process.
   * `--all` is never passed, and the session socket lives inside our private
   * directory, so this cannot address a user's real browser.
   */
  private async cleanupCli(): Promise<void> {
    const child = spawn(
      this.cli.command,
      [
        ...this.cli.prefix,
        "--session",
        this.layout.session,
        ...(this.layout.namespace
          ? ["--namespace", this.layout.namespace]
          : []),
        "close",
        "--json",
      ],
      {
        cwd: this.layout.work,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 4_000) stdout = `${stdout}${chunk}`.slice(0, 4_000);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4_000) stderr = `${stderr}${chunk}`.slice(0, 4_000);
    });
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    const outcome = await new Promise<{
      readonly code: number | null;
      readonly closed: boolean;
    }>((finish) => {
      const settle = (value: {
        readonly code: number | null;
        readonly closed: boolean;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(abandonTimer);
        finish(value);
      };
      const killOwnedGroup = () => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      // Wait for the kill to be confirmed by close(); never report cleanup
      // success while the process handle is still unjoined.
      const killTimer = setTimeout(() => {
        timedOut = true;
        killOwnedGroup();
      }, CLEANUP_TIMEOUT_MS);
      const abandonTimer = setTimeout(() => {
        killOwnedGroup();
        settle({ code: null, closed: false });
      }, CLEANUP_TIMEOUT_MS + 3_000);
      child.once("error", (error) => {
        spawnError = error;
        settle({ code: null, closed: true });
      });
      child.once("close", (code) => settle({ code, closed: true }));
    });
    if (!outcome.closed)
      throw new ForgeError(
        "tool",
        "agent-browser cleanup did not confirm process exit for this isolated session.",
      );
    if (spawnError)
      throw new ForgeError(
        "tool",
        `agent-browser cleanup could not start: ${redact(spawnError.message, this.secrets).slice(0, 300)}`,
      );
    // Exit code alone is not evidence: a close racing an already-exiting
    // daemon reports EOF as a failure while the session is in fact gone.
    if (timedOut) {
      if (await this.daemonGone(3_000)) return;
      throw new ForgeError(
        "tool",
        "agent-browser cleanup timed out and this session's daemon is still present.",
      );
    }
    // Native close can acknowledge before Chromium flushes its disposable
    // profile and removes the daemon artifacts. Confirm exit with a bounded
    // grace period instead of treating that short race as a cleanup failure.
    if (await this.daemonGone(3_000)) return;
    const detail = [stdout, stderr]
      .map((value) => redact(value.trim(), this.secrets).slice(0, 400))
      .filter(Boolean)
      .join(" ");
    throw new ForgeError(
      "tool",
      `agent-browser cleanup failed for this isolated session${
        detail ? `: ${detail}` : "."
      }`,
    );
  }

  /**
   * Reclaim this backend's daemon/browser. `force` skips the MCP close (used
   * after cancellation or an uncertain command, when that channel may be
   * dead) and always closes this one private session through the CLI.
   */
  private async cleanup(browser: boolean, force = false): Promise<void> {
    let failure: Error | undefined;
    let mcpClosed = false;
    if (browser) {
      if (!force) {
        try {
          await this.closeViaMcp();
          mcpClosed = true;
        } catch {
          // Never replay the failed page action; fall back to process cleanup.
        }
      }
      // A confirmed in-band close is sufficient evidence. Only when that close
      // was not possible (dead channel/uncertain call) or the session's daemon
      // artifacts are still present do we spawn a fresh CLI close. `--all` is
      // never used, so this can only address our own private session.
      try {
        if (!mcpClosed || !(await this.daemonGone(3_000)))
          await this.cleanupCli();
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error("agent-browser cleanup failed.");
      }
    }
    try {
      await this.connection.close();
    } catch (error) {
      failure ??=
        error instanceof Error
          ? error
          : new Error("MCP connection cleanup failed.");
    }
    // Keep the private state if the owned daemon could not be confirmed dead:
    // deleting it would remove evidence and may break a live agent-browser.
    if (!failure) {
      await rm(this.layout.root, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (this.layout.socketRoot)
        await rm(this.layout.socketRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      if (this.layout.tmpRoot)
        await rm(this.layout.tmpRoot, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
    if (failure)
      throw new ForgeError(
        "tool",
        `Browser cleanup failed; the private state was retained for inspection. ${redact(
          failure.message,
          this.secrets,
        )}`.slice(0, 2_000),
      );
  }

  /** Mark this backend unusable and reclaim its daemon/browser exactly once. */
  private recover(): Promise<void> {
    this.closed = true;
    this.disposal ??= this.cleanup(this.browserTouched, true);
    return this.disposal;
  }

  private async readOwnedImage(path: string): Promise<Buffer | undefined> {
    const screens = resolve(this.layout.screens);
    const candidate = resolve(path);
    // Never trust a path supplied by the page or the MCP response: only the
    // exact file this backend asked agent-browser to write is readable, and
    // only as a regular non-symlink file.
    if (dirname(candidate) !== screens) return undefined;
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(candidate);
    } catch {
      return undefined;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
    if (entry.size > IMAGE_MAX_BYTES) return undefined;
    const noFollow =
      (constants as unknown as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ??
      0;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(candidate, constants.O_RDONLY | noFollow);
    } catch {
      return undefined;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > IMAGE_MAX_BYTES) return undefined;
      const data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < info.size) {
        const { bytesRead } = await handle.read(
          data,
          offset,
          info.size - offset,
          offset,
        );
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      return offset === info.size ? data : undefined;
    } finally {
      await handle.close();
    }
  }

  private async capture(
    path: string,
    format: "png" | "jpeg",
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const result = await this.requestTool(
      "agent_browser_screenshot",
      {
        ...this.commonArgs(),
        path,
        format,
        ...(format === "jpeg" ? { quality: 80 } : {}),
      },
      signal,
    );
    return parseToolResult(result);
  }

  private async screenshot(
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const pngPath = join(this.layout.screens, `shot-${randomUUID()}.png`);
    const jpegPath = join(this.layout.screens, `shot-${randomUUID()}.jpg`);
    try {
      const png = await this.capture(pngPath, "png", signal);
      if (png.isError)
        return {
          text: requireNonEmptyResult(png.text, this.secrets),
          isError: true,
        };
      let data = await this.readOwnedImage(pngPath);
      if (!data) {
        // PNG can exceed the shared image budget; ask for a bounded JPEG once.
        // This is a new screenshot of current state, never a replay of a
        // mutating action.
        const jpeg = await this.capture(jpegPath, "jpeg", signal);
        if (jpeg.isError)
          return {
            text: requireNonEmptyResult(jpeg.text, this.secrets),
            isError: true,
          };
        data = await this.readOwnedImage(jpegPath);
      }
      if (!data)
        return {
          text: "Screenshot was unavailable as a private PNG/JPEG within the 700,000-character image limit.",
          isError: true,
        };
      const mimeType = imageMimeType(data);
      if (!mimeType || data.toString("base64").length > IMAGE_MAX_BASE64_CHARS)
        return {
          text: "Screenshot is not a supported PNG/JPEG within the image limit.",
          isError: true,
        };
      return {
        text: `Screenshot captured (${mimeType}, ${data.length} bytes).`,
        isError: false,
        image: { mimeType, data: data.toString("base64") },
      };
    } finally {
      await Promise.all([
        rm(pngPath, { force: true }).catch(() => undefined),
        rm(jpegPath, { force: true }).catch(() => undefined),
      ]);
    }
  }

  async check(signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    if (signal?.aborted) throw cancelled();
    try {
      // Starts the MCP server and verifies required tools. It never launches
      // a browser or navigates; that only happens on an approved execute().
      await this.connect(signal);
    } catch (error) {
      await this.dispose().catch(() => undefined);
      throw error;
    }
  }

  async execute(
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    this.assertUsable();
    if (this.browserClosed && command.action !== "close")
      throw new ForgeError(
        "tool",
        "This browser is closed. Start a new run to open another browser.",
      );
    if (signal?.aborted) throw cancelled();
    if (command.action !== "close" && !this.allowedDomains.length)
      throw new ForgeError(
        "invalid_input",
        "Browser plugin requires at least one allowed domain before executing actions.",
      );
    if (command.action === "navigate")
      assertNavigable(command.url, this.allowedDomains);
    try {
      await this.connect(signal);
      if (signal?.aborted) throw cancelled();
      // Past this point the command may launch or touch the browser, so
      // disposal must assume it needs reclaiming even if no response arrives.
      this.browserTouched = true;
      if (command.action === "screenshot") return await this.screenshot(signal);
      const result = await this.requestTool(
        this.toolName(command),
        this.actionArgs(command),
        signal,
      );
      const parsed = parseToolResult(result);
      if (command.action === "close" && !parsed.isError) {
        this.browserClosed = true;
        return {
          text: requireNonEmptyResult(parsed.text, this.secrets),
          isError: false,
        };
      }
      if (command.action === "close") {
        const reclaimed = await this.reclaim();
        return {
          text: boundText(
            `${requireNonEmptyResult(parsed.text, this.secrets)}${
              reclaimed
                ? ""
                : " Cleanup also failed; inspect this isolated browser before starting again."
            }`.trim(),
          ),
          isError: true,
        };
      }
      return {
        text: requireNonEmptyResult(parsed.text, this.secrets),
        isError: parsed.isError,
      };
    } catch (error) {
      // Cancellation and transport failures leave the page outcome unknown.
      // Reclaim the daemon/browser; the command is never replayed.
      const reclaimed = await this.reclaim();
      if (error instanceof ForgeError) {
        if (reclaimed) throw error;
        throw new ForgeError(
          error.code,
          boundText(
            `${error.message} Cleanup also failed; inspect this isolated browser before starting again.`,
          ),
        );
      }
      throw new ForgeError(
        "tool",
        reclaimed
          ? "Browser command failed or its outcome is unknown. This isolated browser was reclaimed; the command was not replayed."
          : "Browser command failed or its outcome is unknown, was not replayed, and cleanup of the isolated browser also failed. Inspect it before starting again.",
      );
    }
  }

  /** Returns true only when cleanup was confirmed. */
  private async reclaim(): Promise<boolean> {
    try {
      await this.recover();
      return true;
    } catch {
      return false;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = this.cleanup(this.browserTouched && !this.browserClosed);
    return this.disposal;
  }
}

function imageMimeType(data: Buffer): "image/png" | "image/jpeg" | undefined {
  if (
    data.length >= PNG_SIGNATURE.length &&
    data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    return "image/png";
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "image/jpeg";
  return undefined;
}

export async function createAgentBrowserBackend(
  configInput: BrowserPluginConfig,
  options: { home: string; redactValues?: readonly string[] },
): Promise<AgentBrowserBackend> {
  // Re-parse the shared contract so a caller cannot smuggle extra keys past
  // the host's config parser.
  const config = browserPluginConfigSchema.parse(configInput);
  const layout = await createLayout(options.home);
  try {
    const cli = cliFor(config);
    if (cli.prefix.length && !(await exists(cli.prefix[0] ?? "")))
      throw new ForgeError(
        "tool",
        "The pinned agent-browser CLI entry was not found in this package.",
      );
    const backend = new Backend(
      config,
      layout,
      cli,
      options.redactValues ?? [],
    );
    // Fail construction early if the private HOME is unusable, so a broken
    // sandbox never reports a ready backend.
    await writeFile(join(layout.home, ".keep"), "", { mode: 0o600 });
    return backend;
  } catch (error) {
    await rm(layout.root, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (layout.socketRoot)
      await rm(layout.socketRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    if (layout.tmpRoot)
      await rm(layout.tmpRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      "tool",
      "Could not create the isolated agent-browser backend.",
    );
  }
}
