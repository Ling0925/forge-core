import { z } from "zod";
import {
  agentProfileOperationSchema,
  agentProfilesSchema,
} from "../agent-profiles";
import { C0_CONTROL } from "../control-characters";
import {
  accountTokensSchema,
  connectionInputSchema,
  credentialInputSchema,
  providerProtocolSchema,
  publicConnectionSchema,
  publicCredentialSchema,
  reasoningEffortSchema,
  routeGroupSchema,
  routeOperationSchema,
  sourceAccessFields,
} from "../model-access";
import { rootTimeoutSchema, rootToolLimitSchema } from "../run-budget";
import { jsonObjectSchema, permissionSchema } from "./base";

export const lspServerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    command: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !C0_CONTROL.test(value)),
    args: z
      .array(
        z
          .string()
          .max(1024)
          .refine((value) => !value.includes("\0")),
      )
      .max(32)
      .readonly(),
    extensions: z
      .array(z.string().regex(/^\.[a-zA-Z0-9_-]{1,16}$/))
      .min(1)
      .max(32)
      .readonly(),
  })
  .strict()
  .readonly();
export const lspServersSchema = z
  .array(lspServerSchema)
  .max(8)
  .readonly()
  .refine(
    (servers) =>
      new Set(servers.map((server) => server.id)).size === servers.length &&
      new Set(
        servers.flatMap((server) =>
          server.extensions.map((ext) => ext.toLowerCase()),
        ),
      ).size ===
        servers.reduce((sum, server) => sum + server.extensions.length, 0),
    "LSP server IDs and file extensions must be unique",
  )
  .refine(
    (servers) => JSON.stringify(servers).length <= 24000,
    "LSP configuration is too large",
  );
export const settingsFields = {
  apiMode: providerProtocolSchema.optional(),
  maxOutputTokens: z.number().int().min(1).max(1000000).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
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
  // Deprecated execution budgets: still accepted and round-tripped for saved
  // settings and older API clients, but optional with no default, so fresh
  // settings no longer advertise a limit. Neither these fields nor
  // maxRootToolCalls/rootTimeoutMs limit runs.
  maxTurns: z.number().int().min(1).max(1000).optional(),
  maxToolCalls: z.number().int().min(1).max(10000).optional(),
  maxRootToolCalls: rootToolLimitSchema.optional(),
  rootTimeoutMs: rootTimeoutSchema.optional(),
  requestTimeoutMs: z.number().int().min(1000).max(600000),
  // Legacy fallback for unknown model windows, not a cap on known windows.
  contextBudgetChars: z.number().int().min(4096).max(2000000),
  contextBudgetTokens: z
    .number()
    .int()
    .min(4096)
    .max(10000000)
    .nullable()
    .optional(),
  // Subagent limits. Defaults: 4 concurrently active children per parent run,
  // depth 1 (only the primary agent delegates).
  maxActiveAgents: z.number().int().min(1).max(32).optional(),
  maxAgentDepth: z.number().int().min(1).max(4).optional(),
  // Plans per session. The persisted session contract caps plans at 10000,
  // so this can only lower the limit.
  maxSessionPlans: z.number().int().min(1).max(10000).optional(),
  // One deadline for each git process behind git_status/git_diff/git_log.
  // Unset: 30s for status/diff, 10s for probes and log.
  gitInspectionTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  // Window assumed when neither settings, the source's model metadata
  // (modelSelection.overrides/manual) nor the provider reports one.
  defaultContextWindowTokens: z
    .number()
    .int()
    .min(4096)
    .max(10000000)
    .optional(),
  // Per-model overrides: gateways/aliases need not have the upstream window.
  modelContextWindows: z
    .record(
      z.string().min(1).max(256),
      z.number().int().positive().max(10000000).nullable(),
    )
    .optional(),
  lspServers: lspServersSchema.optional(),
};
const configurableSettingsFields = {
  ...settingsFields,
  baseUrl: z.union([z.literal(""), settingsFields.baseUrl]),
  model: z.union([z.literal(""), settingsFields.model]),
};
// Provider sources: a stored endpoint/model/key set selectable at runtime. The
// public projection never carries credentials, only whether a key exists.
export const providerSourceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/);
const providerSourceContentFields = {
  ...sourceAccessFields,
  label: z.string().trim().min(1).max(80),
  baseUrl: settingsFields.baseUrl,
  // An empty model means "not chosen yet" so a catalog can be listed first.
  model: z.union([z.literal(""), settingsFields.model]),
  apiMode: settingsFields.apiMode,
};
const providerSourceFields = {
  id: providerSourceIdSchema,
  ...providerSourceContentFields,
};
// A monotonically increasing revision lets a writer detect that someone else
// (desktop, LAN web or CLI) saved the same source in the meantime.
export const providerSourceRevisionSchema = z.number().int().nonnegative();
export const providerSourceSchema = z
  .object({
    ...providerSourceFields,
    revision: providerSourceRevisionSchema.optional(),
  })
  .strict()
  .readonly();
export type ProviderSource = z.infer<typeof providerSourceSchema>;
export const publicProviderSourceSchema = z
  .object({
    ...providerSourceFields,
    revision: providerSourceRevisionSchema,
    hasApiKey: z.boolean(),
    credentials: z.array(publicCredentialSchema).readonly().optional(),
    connection: publicConnectionSchema.optional(),
  })
  .strict()
  .readonly();
export type PublicProviderSource = z.infer<typeof publicProviderSourceSchema>;
export const publicSettingsSchema = z
  .object({
    ...configurableSettingsFields,
    hasApiKey: z.boolean(),
    isConfigured: z.boolean(),
    providerSources: z.array(publicProviderSourceSchema).readonly().optional(),
    routeGroups: z.array(routeGroupSchema).readonly().optional(),
    agentProfiles: agentProfilesSchema.optional(),
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
    requestTimeoutMs: 60000,
    contextBudgetChars: 100000,
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
        credentials: z.array(credentialInputSchema).readonly().optional(),
        connection: connectionInputSchema
          .unwrap()
          .extend({ extraBody: jsonObjectSchema.optional() })
          .strict()
          .readonly()
          .optional(),
        // Omitted for a brand-new source; required to overwrite a stored one.
        expectedRevision: providerSourceRevisionSchema.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal("activate"), id: providerSourceIdSchema })
      .strict(),
    z
      .object({
        type: z.literal("remove"),
        id: providerSourceIdSchema,
        // Session ids that still reference the source, acknowledged by the user.
        forgottenSessionIds: z
          .array(z.string())
          .max(100000)
          .readonly()
          .optional(),
      })
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
    sources: z.array(providerSourceOperationSchema).readonly().optional(),
    route: routeOperationSchema.optional(),
    agent: agentProfileOperationSchema.optional(),
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
    maxOutputTokens: settingsFields.maxOutputTokens,
    requestTimeoutMs: settingsFields.requestTimeoutMs,
    ...connectionInputSchema.unwrap().shape,
    extraBody: jsonObjectSchema.optional(),
    sourceId: z.string().optional(),
    sourceRevision: providerSourceRevisionSchema.optional(),
    credentialId: z.string().optional(),
    account: accountTokensSchema.optional(),
  })
  .strict()
  .readonly();
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
