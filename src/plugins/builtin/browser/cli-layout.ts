import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ForgeError } from "../../../shared/errors";
import type { BrowserPluginConfig } from "../../../shared/plugins";

export interface CliCommand {
  readonly command: string;
  /** Arguments that must precede `mcp ...` (used when the CLI is a JS entry). */
  readonly prefix: readonly string[];
}

export interface PrivateLayout {
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

export function cliFor(config: BrowserPluginConfig): CliCommand {
  // A user-supplied executable is an explicit choice and is used verbatim.
  if (config.executablePath !== "agent-browser")
    return { command: config.executablePath, prefix: [] };
  const entry = pinnedEntry();
  // The official wrapper is a Node entry point; spawning it through the
  // current Node keeps it usable without a postinstall-patched shim.
  return { command: process.execPath, prefix: [entry] };
}

export function privateEnv(
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

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function createLayout(homeInput: string): Promise<PrivateLayout> {
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
