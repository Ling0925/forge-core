import type { McpHealth, McpService, McpToolInfo } from "../shared/mcp";
export type { McpService } from "../shared/mcp";
import { join } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import { atomicJson, privateDirectory, readJson } from "../store/io";
import { fileLock } from "../store/lock";
import { checkDiscovery } from "./bounds";
import { createRemoteConnection } from "./http";
import { StdioMcpConnection } from "./protocol";
import type { McpConnection } from "./rpc";
import {
  MCP_MAX_SERVERS,
  type McpRegisterAnyInput,
  type McpRemoteServerConfig,
  type McpServerConfig,
  type McpServerRecord,
  mcpRegisterAnyInputSchema,
  mcpRemoteServerConfigSchema,
  mcpServerConfigSchema,
  mcpStdioServerConfigSchema,
} from "./types";

const catalogSchema = z
  .object({ version: z.literal(1), servers: z.array(mcpServerConfigSchema) })
  .strict();

const record = (config: McpServerConfig): McpServerRecord => {
  if (isRemote(config)) {
    return {
      id: config.id,
      label: config.label,
      // Legacy fields stay present for callers that always read them.
      command: "",
      args: [],
      enabled: config.enabled,
      requestTimeoutMs: config.requestTimeoutMs,
      envNameCount: 0,
      hasPrivateEnv: false,
      transport: config.transport,
      url: config.url,
      // Never expose header names or values, only presence/counts.
      headerCount: Object.keys(config.headers).length,
      hasPrivateHeaders: Object.keys(config.headers).length > 0,
    };
  }
  return {
    id: config.id,
    label: config.label,
    command: config.command,
    args: [...config.args],
    enabled: config.enabled,
    requestTimeoutMs: config.requestTimeoutMs,
    envNameCount: Object.keys(config.envNames).length,
    hasPrivateEnv: Object.keys(config.env).length > 0,
    // Additive transport marker; stdio records keep every historical field.
    transport: "stdio",
    headerCount: 0,
    hasPrivateHeaders: false,
  };
};

const notFound = (): ForgeError =>
  new ForgeError("not_found", "MCP server was not found.");
const revoked = (): ForgeError =>
  new ForgeError("tool", "MCP server is not registered or not enabled.");

const isRemote = (config: McpServerConfig): config is McpRemoteServerConfig =>
  config.transport === "http" || config.transport === "sse";

const redact = (text: string, values: readonly string[]): string => {
  let clean = text;
  for (const value of values)
    if (value.length > 0) clean = clean.split(value).join("[REDACTED]");
  return clean;
};

/**
 * The user-owned private MCP catalog. Every operation that can produce an
 * effect (discovery or a call) re-reads this authoritative file under an
 * advisory flock *before* touching a live process, so that a disable/remove
 * performed by any other `McpService` instance in the same or another process
 * is observed before a stale instance can launch or use a server.
 */
export async function createMcpService(options: {
  home: string;
}): Promise<McpService> {
  const folder = await privateDirectory(join(options.home, "mcp"));
  const catalogPath = join(folder, "servers.json");
  const lockPath = join(folder, "servers.lock");
  // Each live connection remembers the exact definition signature it was
  // opened under, so any authoritative change (disable, removal, re-point,
  // env/header change) is detected as a revocation even when the *current*
  // config still looks enabled to a stale reader.
  const connections = new Map<
    string,
    Readonly<{ connection: McpConnection; signature: string }>
  >();

  const readCatalog = async (): Promise<McpServerConfig[]> => {
    let parsed: unknown;
    try {
      parsed = await readJson(catalogPath, 1 << 20);
    } catch (error) {
      if (error instanceof ForgeError && error.code === "not_found") return [];
      throw new ForgeError("storage", "MCP catalog could not be read.");
    }
    const result = catalogSchema.safeParse(parsed);
    if (!result.success)
      throw new ForgeError("storage", "MCP catalog could not be read.");
    return [...result.data.servers];
  };

  // Cross-process serialization: the writer lock guards every read-modify-write
  // and every authoritative read. Reads therefore never observe a half-published
  // status change, and an instance that has cached a now-revoked server is
  // corrected before it acts. The underlying lock is non-blocking, so `busy`
  // is retried with bounded backoff; two instances (or two in-process callers)
  // never fail a read just because another holds the lock momentarily.
  const locked = async <T>(operation: () => Promise<T>): Promise<T> => {
    let release: (() => Promise<void>) | undefined;
    for (
      let attempt = 0;
      attempt < 200 && release === undefined;
      attempt += 1
    ) {
      try {
        release = await fileLock(lockPath);
      } catch (error) {
        if (
          error instanceof ForgeError &&
          error.code === "busy" &&
          attempt < 199
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          continue;
        }
        throw error;
      }
    }
    if (release === undefined)
      throw new ForgeError("busy", "MCP catalog is busy.");
    try {
      return await operation();
    } finally {
      await release();
    }
  };

  const persist = async (
    servers: readonly McpServerConfig[],
  ): Promise<void> => {
    await atomicJson(
      catalogPath,
      { version: 1, servers: [...servers] },
      1 << 20,
    );
  };

  // Hold the kernel lock across the whole mutation so concurrent processes
  // cannot interleave a read-modify-write of the same catalog.
  const mutate = async <T>(
    change: (
      servers: readonly McpServerConfig[],
    ) => Promise<Readonly<{ servers: readonly McpServerConfig[]; result: T }>>,
  ): Promise<T> =>
    locked(async () => {
      const current = await readCatalog();
      const { servers, result } = await change(current);
      await persist(servers);
      return result;
    });

  const closeConnection = async (id: string): Promise<void> => {
    const open = connections.get(id);
    connections.delete(id);
    await open?.connection.close();
  };

  /** Latest authoritative config for `id`, or `undefined` when absent. */
  const authoritative = async (
    id: string,
  ): Promise<McpServerConfig | undefined> =>
    locked(async () => {
      const servers = await readCatalog();
      return servers.find((entry) => entry.id === id);
    });

  /**
   * Resolve a server for an *effectful* operation: re-read the authoritative
   * catalog under the store lock, then compare the authoritative definition
   * signature to the signature any *live* connection in this instance was
   * opened under. If this instance holds a stale connection (the operator
   * disabled, removed, re-pointed or edited the server through any other
   * instance or process) it is closed before proceeding. A revoked server
   * never proceeds on stale state.
   */
  const resolveForEffect = async (id: string): Promise<McpServerConfig> => {
    const config = await authoritative(id);
    if (!config || !config.enabled) {
      await closeConnection(id);
      throw revoked();
    }
    const live = connections.get(id);
    if (live && live.signature !== signature(config)) {
      // The stored definition changed; never reuse the old connection.
      await closeConnection(id);
    }
    return config;
  };

  const connection = async (
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<McpConnection> => {
    if (signal?.aborted)
      throw new ForgeError("cancelled", "Tool execution cancelled.");
    const expected = signature(config);
    const existing = connections.get(config.id);
    if (
      existing &&
      !existing.connection.isClosed &&
      existing.signature === expected
    ) {
      await existing.connection.connect(signal);
      return existing.connection;
    }
    if (existing) await closeConnection(config.id);
    let created: McpConnection;
    if (isRemote(config)) {
      created = createRemoteConnection(config.transport, {
        url: config.url,
        headers: config.headers,
        requestTimeoutMs: config.requestTimeoutMs,
      });
    } else {
      const env: Record<string, string> = {};
      for (const [child, host] of Object.entries(config.envNames)) {
        const value = process.env[host];
        if (value !== undefined) env[child] = value;
      }
      for (const [name, value] of Object.entries(config.env)) env[name] = value;
      created = new StdioMcpConnection({
        command: config.command,
        args: config.args,
        env,
        requestTimeoutMs: config.requestTimeoutMs,
      });
    }
    connections.set(config.id, { connection: created, signature: expected });
    try {
      await created.connect(signal);
    } catch (error) {
      await closeConnection(config.id);
      throw error;
    }
    return created;
  };

  const effect = async <T>(
    id: string,
    opts:
      | Readonly<{ signal?: AbortSignal; redactValues?: readonly string[] }>
      | undefined,
    action: (open: McpConnection, values: readonly string[]) => Promise<T>,
  ): Promise<T> => {
    if (opts?.signal?.aborted)
      throw new ForgeError("cancelled", "Tool execution cancelled.");
    const config = await resolveForEffect(id);
    const values = [...secretValues(config), ...(opts?.redactValues ?? [])];
    try {
      const open = await connection(config, opts?.signal);
      return await action(open, values);
    } catch (error) {
      if (opts?.signal?.aborted) await closeConnection(id);
      throw new ForgeError(
        error instanceof ForgeError ? error.code : "tool",
        redact(
          error instanceof Error ? error.message : "MCP operation failed.",
          values,
        ),
      );
    }
  };

  return {
    async register(input) {
      const parsed = mcpRegisterAnyInputSchema.parse(input);
      const config = normalizeRegistration(parsed);
      return mutate((servers) => {
        if (servers.some((entry) => entry.id === config.id))
          throw new ForgeError(
            "invalid_input",
            "MCP server id already exists.",
          );
        if (servers.length >= MCP_MAX_SERVERS)
          throw new ForgeError("invalid_input", "MCP server limit reached.");
        return Promise.resolve({
          servers: [...servers, config],
          result: record(config),
        });
      });
    },
    async list() {
      const servers = await locked(readCatalog);
      return servers.map(record);
    },
    async setEnabled(id, enabled) {
      const result = await mutate((servers) => {
        const config = servers.find((entry) => entry.id === id);
        if (!config) throw notFound();
        const updated = mcpServerConfigSchema.parse({ ...config, enabled });
        return Promise.resolve({
          servers: servers.map((entry) => (entry.id === id ? updated : entry)),
          result: updated,
        });
      });
      // The persisted status is authoritative immediately; close our live
      // connection on disable so no stale instance keeps a revoked server alive.
      if (!enabled) await closeConnection(id);
      return record(result);
    },
    async remove(id) {
      await mutate((servers) => {
        if (!servers.some((entry) => entry.id === id)) throw notFound();
        return Promise.resolve({
          servers: servers.filter((entry) => entry.id !== id),
          result: undefined,
        });
      });
      await closeConnection(id);
    },
    async revoke(id) {
      await closeConnection(id);
    },
    async health(id): Promise<McpHealth> {
      const config = await authoritative(id);
      if (!config)
        return {
          id,
          enabled: false,
          connected: false,
          negotiatedProtocolVersion: undefined,
          lastError: undefined,
        };
      if (!config.enabled) {
        await closeConnection(id);
        return {
          id,
          enabled: false,
          connected: false,
          negotiatedProtocolVersion: undefined,
          lastError: undefined,
        };
      }
      try {
        const open = await connection(config);
        return {
          id,
          enabled: true,
          connected: true,
          negotiatedProtocolVersion: open.negotiatedProtocolVersion,
          lastError: undefined,
        };
      } catch (error) {
        return {
          id,
          enabled: true,
          connected: false,
          negotiatedProtocolVersion: undefined,
          lastError:
            error instanceof ForgeError ? error.message : "Connection failed.",
        };
      }
    },
    async listTools(id, callOptions) {
      return effect(id, callOptions, async (open, values) => {
        const tools = await open.listTools(callOptions?.signal);
        const clean = sanitize(tools, values) as readonly McpToolInfo[];
        checkDiscovery(clean);
        return clean;
      });
    },
    async callTool(id, tool, args, callOptions) {
      return effect(id, callOptions, async (open, values) => {
        const outcome = await open.callTool(
          tool,
          args,
          callOptions?.signal,
          values,
        );
        return outcome;
      });
    },
    async dispose() {
      const open = [...connections.values()];
      connections.clear();
      await Promise.all(open.map((entry) => entry.connection.close()));
    },
  };
}

/**
 * Normalize an accepted registration into a stored config. Legacy stdio input
 * (no `transport`, or `transport: "stdio"`) keeps its exact shape; remote
 * input must carry an explicit `http`/`sse` transport and a URL.
 */
function normalizeRegistration(input: McpRegisterAnyInput): McpServerConfig {
  if (input.transport === "http" || input.transport === "sse") {
    return mcpRemoteServerConfigSchema.parse({
      id: input.id,
      label: input.label,
      transport: input.transport,
      url: input.url,
      headers: input.headers ?? {},
      enabled: input.enabled ?? false,
      requestTimeoutMs: input.requestTimeoutMs ?? 15000,
    });
  }
  return mcpStdioServerConfigSchema.parse({
    ...input,
    transport: "stdio",
    enabled: input.enabled ?? false,
    requestTimeoutMs: input.requestTimeoutMs ?? 15000,
  });
}

/** Private values that must never surface in remote errors or results. */
function secretValues(config: McpServerConfig): string[] {
  if (isRemote(config)) return Object.values(config.headers);
  return [
    ...Object.values(config.env),
    ...Object.values(config.envNames).map((name) => process.env[name] ?? ""),
  ];
}

/**
 * Identity of a server definition that affects effectful behavior. Enabled
 * state, transport, endpoint, env shape and header values are included so a
 * status or definition change is observed as a revocation.
 */
function signature(config: McpServerConfig): string {
  if (isRemote(config)) {
    return [
      "remote",
      config.transport,
      config.url,
      JSON.stringify(config.headers),
      String(config.requestTimeoutMs),
    ].join("\u0001");
  }
  return [
    "stdio",
    config.command,
    config.args.join("\u0000"),
    JSON.stringify(config.envNames),
    JSON.stringify(config.env),
    String(config.requestTimeoutMs),
  ].join("\u0001");
}

function sanitize(value: unknown, values: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, values);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, values));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, values),
        sanitize(item, values),
      ]),
    );
  return value;
}
