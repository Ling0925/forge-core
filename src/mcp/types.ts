import { z } from "zod";

/** MCP protocol version this client advertises (2025-11-25 stdio spec). */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

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

const noBreaks = (value: string) => !/[\r\n\0]/.test(value);

const forbiddenName =
  /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|GEMINI_API_KEY|GOOGLE_API_KEY|FORGE_API_KEY)$/i;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const secretName =
  /(?:api[_-]?key|secret|password|token|credential|private[_ -]?key)/i;

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

export const mcpServerConfigSchema = z.object(configFields).strict().readonly();
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/**
 * Registration input. Rebuilt from plain `configFields` (never `omit` on a
 * `ZodReadonly`) so `.shape` stays available and strictness is preserved.
 */
export const mcpRegisterInputSchema = z
  .object({
    ...configFields,
    enabled: configFields.enabled.optional(),
    requestTimeoutMs: configFields.requestTimeoutMs.optional(),
  })
  .strict()
  .readonly();
export type McpRegisterInput = z.infer<typeof mcpRegisterInputSchema>;

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

/** Connection health. Sanitized: never contains env values or raw errors. */
export interface McpHealth {
  readonly id: string;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly negotiatedProtocolVersion: string | undefined;
  readonly lastError: string | undefined;
}

/** Sanitized catalog record safe for IPC/renderer/CLI. */
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
}
