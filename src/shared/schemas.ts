import { z } from "zod";
import { createDiffPatch, unavailablePatch } from "./diff";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema).readonly(),
    z.record(jsonValueSchema).readonly(),
  ]),
);
export const jsonObjectSchema = z.record(jsonValueSchema).readonly();
export const sessionIdSchema = z.string().uuid().brand<"SessionId">();
export type SessionId = z.infer<typeof sessionIdSchema>;
export const parseSessionId = (value: unknown): SessionId =>
  sessionIdSchema.parse(value);
export const timestampSchema = z.string().datetime({ offset: true });
export const permissionSchema = z.enum([
  "readonly",
  "workspace",
  "unrestricted",
]);
export type Permission = z.infer<typeof permissionSchema>;
const browserOriginSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.host.includes("*") &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }, "Expected an exact canonical HTTP(S) origin (scheme, host and optional port only; no credentials, path, query, fragment or wildcard)");
export const lspServerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  command: z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]/.test(value)),
  args: z.array(z.string().max(1024).refine(value => !value.includes("\0"))).max(32).readonly(),
  extensions: z.array(z.string().regex(/^\.[a-zA-Z0-9_-]{1,16}$/)).min(1).max(32).readonly(),
}).strict().readonly();
export const lspServersSchema = z.array(lspServerSchema).max(8).readonly().refine(servers =>
  new Set(servers.map(server => server.id)).size === servers.length
  && new Set(servers.flatMap(server => server.extensions.map(ext => ext.toLowerCase()))).size === servers.reduce((sum, server) => sum + server.extensions.length, 0),
  "LSP server IDs and file extensions must be unique",
).refine(servers => JSON.stringify(servers).length <= 24000, "LSP configuration is too large");
export const settingsFields = {
  apiMode: z.enum(["chat-completions", "responses"]).optional(),
  reasoningEffort: z
    .enum(["default", "none", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
  baseUrl: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "Expected an HTTP(S) base URL without credentials, query or fragment"),
  model: z.string().trim().min(1).max(256),
  theme: z.enum(["system", "light", "dark"]),
  defaultPermission: permissionSchema,
  maxTurns: z.number().int().min(1).max(1000),
  maxToolCalls: z.number().int().min(1).max(10000),
  requestTimeoutMs: z.number().int().min(1000).max(600000),
  // Legacy fallback for unknown model windows, not a cap on known windows.
  contextBudgetChars: z.number().int().min(4096).max(2000000),
  contextBudgetTokens: z.number().int().min(4096).max(10000000).nullable().optional(),
  // Per-model overrides: gateways/aliases need not have the upstream window.
  modelContextWindows: z.record(z.string().min(1).max(256), z.number().int().positive().max(10000000).nullable()).optional(),
  lspServers: lspServersSchema.optional(),
  browserAllowedOrigins: z.array(browserOriginSchema).max(32).readonly(),
  browserExecutablePath: z
    .string()
    .max(4096)
    .refine(
      (value) => !/[\r\n]/.test(value),
      "Browser executable path must not contain line breaks",
    ),
};
const configurableSettingsFields = {
  ...settingsFields,
  baseUrl: z.union([z.literal(""), settingsFields.baseUrl]),
  model: z.union([z.literal(""), settingsFields.model]),
};
// Provider sources: a stored endpoint/model/key set selectable at runtime. The
// public projection never carries credentials, only whether a key exists.
export const providerSourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const providerSourceFields = {
  id: providerSourceIdSchema,
  label: z.string().trim().min(1).max(80),
  baseUrl: settingsFields.baseUrl,
  // An empty model means "not chosen yet" so a catalog can be listed first.
  model: z.union([z.literal(""), settingsFields.model]),
  apiMode: settingsFields.apiMode,
};
export const providerSourceSchema = z
  .object(providerSourceFields)
  .strict()
  .readonly();
export type ProviderSource = z.infer<typeof providerSourceSchema>;
export const publicProviderSourceSchema = z
  .object({
    ...providerSourceFields,
    hasApiKey: z.boolean(),
  })
  .strict()
  .readonly();
export type PublicProviderSource = z.infer<typeof publicProviderSourceSchema>;
export const publicSettingsSchema = z
  .object({
    ...configurableSettingsFields,
    hasApiKey: z.boolean(),
    isConfigured: z.boolean(),
    providerSources: z.array(publicProviderSourceSchema).max(20).readonly().optional(),
    activeSourceId: providerSourceIdSchema.optional(),
    // FORGE_* variables keep priority: the UI must be able to warn about it.
    environmentOverride: z.boolean().optional(),
  })
  .strict()
  .refine(
    (settings) =>
      settings.isConfigured ===
      (settings.baseUrl !== "" && settings.model !== ""),
    "Configuration status must match endpoint and model availability",
  )
  .readonly();
export type PublicSettings = z.infer<typeof publicSettingsSchema>;
export const defaultPublicSettings: PublicSettings = publicSettingsSchema.parse(
  {
    baseUrl: "",
    model: "",
    theme: "system",
    defaultPermission: "workspace",
    maxTurns: 20,
    maxToolCalls: 100,
    requestTimeoutMs: 60000,
    contextBudgetChars: 100000,
    browserAllowedOrigins: [],
    browserExecutablePath: "",
    hasApiKey: false,
    isConfigured: false,
  },
);
const apiKeySchema = z
  .string()
  .max(16384)
  .refine(
    (value) => !/[\r\n]/.test(value),
    "API key must not contain line breaks",
  );
// Zod 3 reads `type` off each branch, so branches stay plain objects (no
// `.readonly()` wrapper); only the union itself is readonly. Nested `source`
// keeps its own readonly wrapper.
export const providerSourceOperationSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("save"),
        source: z.object(providerSourceFields).strict().readonly(),
        apiKey: apiKeySchema.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("activate"), id: providerSourceIdSchema })
      .strict(),
    z
      .object({ type: z.literal("remove"), id: providerSourceIdSchema })
      .strict(),
  ])
  .readonly();
export type ProviderSourceOperation = z.infer<
  typeof providerSourceOperationSchema
>;
export const configureInputSchema = z
  .object({
    apiKey: apiKeySchema.optional(),
    source: providerSourceOperationSchema.optional(),
    settings: z
      .object(configurableSettingsFields)
      .partial()
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type ConfigureInput = z.infer<typeof configureInputSchema>;
// Private schema: never use for renderer responses or persisted sessions.
export const providerConfigSchema = z
  .object({
    baseUrl: settingsFields.baseUrl,
    apiKey: apiKeySchema,
    apiMode: settingsFields.apiMode,
    reasoningEffort: settingsFields.reasoningEffort,
    requestTimeoutMs: settingsFields.requestTimeoutMs,
  })
  .strict()
  .readonly();
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const toolCallSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        arguments: z.string().max(1000000),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type ToolCall = z.infer<typeof toolCallSchema>;
export const toolDefinitionSchema = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: toolCallSchema.unwrap().shape.function.unwrap().shape.name,
        description: z.string().max(8192),
        parameters: jsonObjectSchema,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export const providerStateSchema = z
  .object({
    version: z.literal(1),
    apiMode: z.literal("responses"),
    baseUrl: settingsFields.baseUrl,
    model: settingsFields.model,
    output: z.array(jsonObjectSchema).max(256).readonly(),
  })
  .strict()
  .refine(
    (state) =>
      new TextEncoder().encode(JSON.stringify(state)).byteLength <= 262144,
    "Provider continuation exceeds 256 KiB",
  )
  .readonly();
export type ProviderState = z.infer<typeof providerStateSchema>;
export const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().max(2000000).nullable(),
    // Display-only reasoning persisted so a resumed session can show it again.
    // Bounded, never sent back to the provider, and not part of assistant content.
    reasoning: z.string().max(131072).optional(),
    providerState: providerStateSchema.optional(),
    tool_calls: z.array(toolCallSchema).max(256).readonly().optional(),
  })
  .strict()
  .readonly();
export const messageSchema = z
  .discriminatedUnion("role", [
    z
      .object({ role: z.literal("system"), content: z.string().max(2000000) })
      .strict(),
    z
      .object({
        role: z.literal("user"),
        content: z.string().max(2000000),
        origin: z.literal("agent_reconciliation").optional(),
      })
      .strict(),
    // Discriminated union needs the underlying object, before readonly wrapping.
    assistantMessageSchema.unwrap(),
    z
      .object({
        role: z.literal("tool"),
        content: z.string().max(2000000),
        tool_call_id: z.string().min(1).max(256),
      })
      .strict(),
  ])
  .readonly();
export type Message = z.infer<typeof messageSchema>;
export const usageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    // Provider-reported only: a gateway cache hit count. Zero is a known value;
    // absence means the gateway did not report it and must stay absent.
    cachedPromptTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .readonly();
export type Usage = z.infer<typeof usageSchema>;
export const providerResponseSchema = z
  .object({
    message: assistantMessageSchema,
    usage: usageSchema.optional(),
  })
  .strict()
  .readonly();
export type ProviderResponse = z.infer<typeof providerResponseSchema>;
export const diffPatchSchema = z.object({
  version: z.literal(1),
  status: z.enum(["complete", "truncated", "unavailable"]),
  reason: z.literal("budget").optional(),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  omittedLines: z.number().int().nonnegative(),
  omittedHunks: z.number().int().nonnegative(),
  hunks: z.array(z.object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.object({
      op: z.enum(["equal", "delete", "insert"]),
      text: z.string().max(8192),
    }).strict().readonly()).max(400).readonly(),
  }).strict().readonly()).max(64).readonly(),
}).strict().readonly();
export type DiffPatch = z.infer<typeof diffPatchSchema>;

/**
 * A file change carries only the exact hunk diff (`patch`). Older sessions
 * persisted bounded `before`/`after` display previews plus a `truncated` flag;
 * those are migrated into `patch` on read and never written again.
 */
const migrateFileChange = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (
    !("before" in record) &&
    !("after" in record) &&
    !("truncated" in record)
  )
    return value;
  const { before, after, truncated, ...rest } = record;
  if (rest.patch !== undefined) return rest;
  // Only explicitly complete previews can yield an exact diff. A missing side
  // is empty only for a creation/deletion, never for an unknown modification.
  const complete =
    truncated === false &&
    (typeof before === "string" || (rest.kind === "created" && before === null)) &&
    (typeof after === "string" || (rest.kind === "deleted" && after === null));
  const patch = complete
    ? createDiffPatch(
        typeof before === "string" ? before : "",
        typeof after === "string" ? after : "",
      )
    : unavailablePatch();
  return { ...rest, patch };
};

const fileChangeObjectSchema = z
  .object({
    path: z.string().min(1).max(4096),
    kind: z.enum(["created", "modified", "deleted"]),
    // Generated from the full originals; absent only when it could not be computed.
    patch: diffPatchSchema.optional(),
  })
  .strict()
  .readonly();

export const fileChangeSchema = z.preprocess(
  migrateFileChange,
  fileChangeObjectSchema,
);
export type FileChange = z.infer<typeof fileChangeSchema>;
export const toolResultSchema = z
  .object({
    content: z.string().max(131072),
    isError: z.boolean(),
    changes: z.array(fileChangeSchema).max(256).readonly().optional(),
  })
  .strict()
  .readonly();
export type ToolResult = z.infer<typeof toolResultSchema>;
export const approvalRequestSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: sessionIdSchema,
    toolCallId: toolCallSchema.unwrap().shape.id,
    toolName: toolCallSchema.unwrap().shape.function.unwrap().shape.name,
    childSessionId: sessionIdSchema.optional(),
    description: z.string().max(8192),
    command: z.array(z.string().max(8192)).max(256).readonly().optional(),
  })
  .strict()
  .readonly();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export const sessionStatusSchema = z.enum([
  "idle",
  "running",
  "awaiting_approval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export const errorInfoSchema = z
  .object({
    code: z.enum([
      "invalid_input",
      "not_found",
      "busy",
      "provider",
      "tool",
      "storage",
      "cancelled",
      "budget",
      "internal",
    ]),
    message: z.string().max(4096),
    retryable: z.boolean(),
  })
  .strict()
  .readonly();
export type ErrorInfo = z.infer<typeof errorInfoSchema>;
export const taskPlanSchema = z
  .object({
    explanation: z.string().trim().min(1).max(4096),
    steps: z
      .array(
        z
          .object({
            step: z.string().trim().min(1).max(1024),
            status: z.enum(["pending", "in_progress", "completed"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (p) => p.steps.filter((s) => s.status === "in_progress").length <= 1,
    "At most one step may be in progress",
  );
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export const contextSummarySchema = z
  .object({
    content: z.string().max(8192),
    boundary: z.number().int().nonnegative(),
    fallback: z.boolean(),
  })
  .strict();
export const contextUsageSchema = z.object({
  windowTokens: z.number().int().positive().nullable(),
  budgetTokens: z.number().int().positive().optional(),
  budgetChars: z.number().int().positive().optional(),
  usedTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
  basis: z.enum(["projected", "request", "request-with-output"]),
  // Provider input count for this request, never the accumulated billing total.
  promptTokens: z.number().int().nonnegative().optional(),
  cachedPromptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  parts: z.object({
    instructions: z.number().int().nonnegative(),
    memory: z.number().int().nonnegative(),
    conversation: z.number().int().nonnegative(),
    tools: z.number().int().nonnegative(),
  }).strict(),
}).strict().readonly();
export type ContextUsage = z.infer<typeof contextUsageSchema>;
// Read existing sessions without reinterpreting their old character counts as tokens.
const persistedContextUsageSchema = z.union([
  contextUsageSchema,
  z.object({ budgetChars: z.number().int().positive(), usedChars: z.number().int().nonnegative(),
    parts: z.object({ instructions: z.number().int().nonnegative(), memory: z.number().int().nonnegative(),
      conversation: z.number().int().nonnegative(), tools: z.number().int().nonnegative() }).strict(),
  }).strict().transform((): ContextUsage => ({ windowTokens: null, usedTokens: 0, estimated: true,
    basis: "projected", parts: { instructions: 0, memory: 0, conversation: 0, tools: 0 } })),
]);
const eventBase = { sessionId: sessionIdSchema, timestamp: timestampSchema };
export const agentEventSchema = z
  .discriminatedUnion("type", [
    z.object({ ...eventBase, type: z.literal("permission_changed"), permission: permissionSchema }).strict(),
    z.object({
      ...eventBase,
      type: z.literal("context_usage"),
      usage: persistedContextUsageSchema,
    }).strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("plan_updated"),
        plan: taskPlanSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("agent_update"),
        childSessionId: sessionIdSchema,
        status: sessionStatusSchema,
        model: settingsFields.model,
        summary: z.string().max(4096),
        currentTool: z.object({ name: z.string().max(256), target: z.string().max(1024) }).strict().optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("text_delta"),
        text: z.string().max(131072),
      })
      .strict(),
    // Display-only reasoning preview. Ephemeral: emitted for live UI and never
    // persisted to the session transcript as assistant content.
    z
      .object({
        ...eventBase,
        type: z.literal("reasoning_delta"),
        text: z.string().max(131072),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("tool_started"),
        call: toolCallSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("tool_finished"),
        toolCallId: toolCallSchema.unwrap().shape.id,
        result: toolResultSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("approval_requested"),
        request: approvalRequestSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("state_changed"),
        status: sessionStatusSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("run_started"),
        model: settingsFields.model,
        permission: permissionSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("run_finished"),
        status: z.enum(["completed", "cancelled", "failed", "interrupted"]),
        turns: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        usage: usageSchema.optional(),
        usageComplete: z.boolean().optional(),
        // Own usage stays backward compatible; aggregate is provider-reported
        // usage across this run and its children, not a billing estimate.
        childUsage: usageSchema.optional(),
        totalUsage: usageSchema.optional(),
        childUsageComplete: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("error"),
        error: errorInfoSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("context_compacted"),
        removedMessages: z.number().int().nonnegative(),
        beforeChars: z.number().int().nonnegative(),
        afterChars: z.number().int().nonnegative(),
      })
      .strict(),
  ])
  .readonly();
export type AgentEvent = z.infer<typeof agentEventSchema>;
export const sessionTitleSchema = z.string().trim().min(1).max(256);
const summaryFields = {
  version: z.literal(1),
  id: sessionIdSchema,
  title: sessionTitleSchema,
  workspace: z.string().min(1).max(4096),
  model: settingsFields.model,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  status: sessionStatusSchema,
  parentSessionId: sessionIdSchema.optional(),
  archived: z.boolean().optional(),
};
export const sessionSummarySchema = z.object(summaryFields).strict().readonly();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const sessionSnapshotSchema = z
  .object({
    ...summaryFields,
    messages: z.array(messageSchema).max(100000).readonly(),
    events: z.array(agentEventSchema).max(1000000).readonly(),
    changes: z.array(fileChangeSchema).max(100000).readonly(),
    titleSource: z.enum(["default", "user", "auto"]).optional(),
    autoTitleAttempted: z.boolean().optional(),
    pendingTool: toolCallSchema.optional(),
    plan: taskPlanSchema.optional(),
    parentSessionId: sessionIdSchema.optional(),
    agentTask: z.string().max(16384).optional(),
    ownership: z.string().max(4096).optional(),
    writePaths: z.array(z.string().min(1).max(512)).max(32).readonly().optional(),
    agentResolutions: z.array(z.object({
      id: sessionIdSchema,
      childUpdatedAt: timestampSchema,
      resolution: z.string().min(1).max(4096),
    }).strict()).max(10000).readonly().optional(),
    permissionCeiling: permissionSchema.optional(),
    contextSummary: contextSummarySchema.optional(),
    archived: z.boolean().optional(),
    forkedFrom: sessionIdSchema.optional(),
  })
  .strict()
  .readonly();
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export const createSessionInputSchema = z
  .object({
    workspace: summaryFields.workspace,
    title: summaryFields.title.optional(),
    model: settingsFields.model.optional(),
  })
  .strict()
  .readonly();
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
export const runInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    prompt: z.string().trim().min(1).max(1000000),
    mode: z.enum(["build", "plan"]).optional(),
    permission: permissionSchema.optional(),
    model: settingsFields.model.optional(),
  })
  .strict()
  .readonly();
export type RunInput = z.infer<typeof runInputSchema>;
