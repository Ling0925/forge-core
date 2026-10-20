import { z } from "zod";

/** MCP protocol version this client advertises (latest published revision). */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/**
 * Published MCP revisions this client can interoperate with. A server may
 * negotiate any of these; arbitrary version strings fail closed.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
] as const;

export function isSupportedProtocolVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value)
  );
}

export const MCP_MAX_MESSAGE_BYTES = 1024 * 1024;
export const MCP_MAX_PENDING = 32;
export const MCP_MAX_SERVERS = 32;
export const MCP_MAX_TOOLS_PER_SERVER = 256;
export const MCP_MAX_PAGES = 16;
export const MCP_CALL_ARGUMENT_LIMIT = 64 * 1024;
export const MCP_DISCOVERY_LIMIT = 256 * 1024;
export const MCP_RESULT_LIMIT = 64 * 1024;
export const MCP_NAME_LIMIT = 64;
export const MCP_MAX_ARGS = 64;
export const MCP_MAX_HEADERS = 32;
export const MCP_HEADER_VALUE_LIMIT = 8192;
export const MCP_MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

const noBreaks = (value: string) => !/[\r\n\0]/.test(value);

const forbiddenName =
  /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|GEMINI_API_KEY|GOOGLE_API_KEY|FORGE_API_KEY)$/i;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const secretName =
  /(?:api[_-]?key|secret|password|token|credential|private[_ -]?key)/i;

/**
 * Remote transports. `stdio` remains the default for every legacy config and
 * registration that omits `transport`; remote transports are opt-in.
 */
export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** Child env variable NAME -> host env variable NAME. Values are never stored. */
export const mcpEnvNameMapSchema = z
  .record(z.string().min(1).max(128))
  .refine(
    (map) => {
      for (const [child, host] of Object.entries(map)) {
        if (
          !envName.test(child) ||
          !envName.test(host) ||
          forbiddenName.test(child) ||
          forbiddenName.test(host)
        )
          return false;
        // Reject forwarding host variables that look like credentials; the
        // development API key can never be mapped into a server environment.
        if (secretName.test(host)) return false;
      }
      return true;
    },
    {
      message:
        "Host environment variable names that look like credentials cannot be forwarded to MCP servers.",
    },
  )
  .readonly();

/** Private literal env values (child NAME -> VALUE), stored only under FORGE_HOME. */
export const mcpEnvValueSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .refine((v) => envName.test(v) && !forbiddenName.test(v)),
    z.string().max(8192),
  )
  .readonly();

/**
 * An absolute, credential-free HTTP(S) endpoint. User registration explicitly
 * authorizes this origin; redirects and negotiated SSE POST endpoints may
 * never move to another origin. Userinfo, fragments and control characters
 * are rejected so credentials cannot be smuggled into a public URL.
 */
export const mcpRemoteUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(noBreaks)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname.length > 0 &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "MCP remote URL must be an absolute credential-free HTTP(S) URL.");

const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Hop-by-hop, framing and protocol-managed headers are controlled by the
// transport and can never be overridden by user headers.
const reservedHeader =
  /^(?:host|content-length|content-type|accept|accept-encoding|connection|transfer-encoding|upgrade|te|trailer|keep-alive|proxy-authorization|proxy-authenticate|mcp-session-id|mcp-protocol-version)$/i;

const headerValue = z
  .string()
  .max(MCP_HEADER_VALUE_LIMIT)
  .refine((value) => !/[\r\n\0]/.test(value));

/** Optional private headers (e.g. Authorization), stored only under FORGE_HOME. */
export const mcpPrivateHeadersSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .refine(
        (name) => headerName.test(name) && !reservedHeader.test(name),
        "MCP header names must be valid and cannot override transport headers.",
      ),
    headerValue,
  )
  .refine(
    (headers) => Object.keys(headers).length <= MCP_MAX_HEADERS,
    `At most ${MCP_MAX_HEADERS} MCP headers are allowed.`,
  )
  .readonly();

const configFields = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .refine((value) => !value.includes("__")),
  label: z.string().min(1).max(64).refine(noBreaks),
  command: z.string().min(1).max(4096).refine(noBreaks),
  args: z
    .array(z.string().max(8192).refine(noBreaks))
    .max(MCP_MAX_ARGS)
    .readonly(),
  envNames: mcpEnvNameMapSchema.default({}),
  env: mcpEnvValueSchema.default({}),
  enabled: z.boolean(),
  requestTimeoutMs: z.number().int().min(1000).max(60000).default(15000),
} as const;

/**
 * Legacy stdio server config. `transport` is optional so catalogs written by
 * older Forge versions (which never had the field) still parse; everything
 * else is unchanged.
 */
export const mcpStdioServerConfigSchema = z
  .object({ ...configFields, transport: z.literal("stdio").default("stdio") })
  .strict()
  .readonly();
export type McpStdioServerConfig = z.infer<typeof mcpStdioServerConfigSchema>;

/** Remote server config: explicit transport, credential-free URL, private headers. */
export const mcpRemoteServerConfigSchema = z
  .object({
    id: configFields.id,
    label: configFields.label,
    transport: z.enum(["http", "sse"]),
    url: mcpRemoteUrlSchema,
    headers: mcpPrivateHeadersSchema.default({}),
    enabled: configFields.enabled,
    requestTimeoutMs: configFields.requestTimeoutMs,
  })
  .strict()
  .readonly();
export type McpRemoteServerConfig = z.infer<typeof mcpRemoteServerConfigSchema>;

/** Stored catalog entries. Runtime values are always normalized to carry transport. */
export const mcpServerConfigSchema = z.union([
  mcpStdioServerConfigSchema,
  mcpRemoteServerConfigSchema,
]);
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/**
 * Legacy stdio registration input, unchanged for existing CLI/bridge callers.
 * The optional `transport` literal lets new callers be explicit without
 * changing any old property.
 */
export const mcpRegisterInputSchema = z
  .object({
    ...configFields,
    enabled: configFields.enabled.optional(),
    requestTimeoutMs: configFields.requestTimeoutMs.optional(),
    transport: z.literal("stdio").optional(),
  })
  .strict()
  .readonly();
export type McpRegisterInput = z.infer<typeof mcpRegisterInputSchema>;

/** Opt-in remote registration. Transport is explicit and required. */
export const mcpRemoteRegisterInputSchema = z
  .object({
    id: configFields.id,
    label: configFields.label,
    transport: z.enum(["http", "sse"]),
    url: mcpRemoteUrlSchema,
    headers: mcpPrivateHeadersSchema.optional(),
    enabled: configFields.enabled.optional(),
    requestTimeoutMs: configFields.requestTimeoutMs.optional(),
  })
  .strict()
  .readonly();
export type McpRemoteRegisterInput = z.infer<
  typeof mcpRemoteRegisterInputSchema
>;

/** Any accepted registration: stdio (legacy shape) or remote. */
export const mcpRegisterAnyInputSchema = z.union([
  mcpRemoteRegisterInputSchema,
  mcpRegisterInputSchema,
]);
export type McpRegisterAnyInput = z.infer<typeof mcpRegisterAnyInputSchema>;

/**
 * A server-declared tool. `inputSchema` is the server's real JSON schema.
 *
 * Extra protocol keys (e.g. `annotations`, `readOnlyHint`, `title`) are
 * tolerated but never used for authorization — annotations are server-supplied
 * hints, not permissions.
 */
export const mcpToolInfoSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MCP_NAME_LIMIT)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    description: z.string().max(8192).default(""),
    inputSchema: z
      .object({ type: z.literal("object") })
      .passthrough()
      .readonly(),
    annotations: z.record(z.unknown()).readonly().optional(),
  })
  .passthrough()
  .readonly();
export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;

/** Connection health. Sanitized: never contains env values, headers or raw errors. */
export interface McpHealth {
  readonly id: string;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly negotiatedProtocolVersion: string | undefined;
  readonly lastError: string | undefined;
  /** Additive: the configured transport. */
  readonly transport?: McpTransport;
}

/**
 * Sanitized catalog record safe for IPC/renderer/CLI.
 *
 * `command`/`args` remain present for every record (empty for remote servers)
 * so existing callers and DTOs keep working. Remote records set `transport`
 * to `http` or `sse` and expose only a credential-free `url`; `headers` values
 * are never included, only presence and header-name counts.
 */
export interface McpServerRecord {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly enabled: boolean;
  readonly requestTimeoutMs: number;
  /** Count of user-approved host env NAME mappings (never their values). */
  readonly envNameCount: number;
  /** Whether private env values exist; the values themselves are never exposed. */
  readonly hasPrivateEnv: boolean;
  /** Additive: `stdio` (default), `http` or `sse`. */
  readonly transport?: McpTransport;
  /** Additive: credential-free remote endpoint for http/sse, else undefined. */
  readonly url?: string;
  /** Additive: number of private headers configured (never names or values). */
  readonly headerCount?: number;
  /** Additive: whether private headers exist (values are never exposed). */
  readonly hasPrivateHeaders?: boolean;
}
