import { z } from "zod";
import { modelCatalogSchema, modelCatalogEntrySchema } from "./model-catalog";

// Magpie provider identity/selection concepts, adapted to Forge's shared host.
// Source provenance and MIT license: THIRD_PARTY_NOTICES.md.
export const providerProtocolSchema = z.enum(["chat-completions", "responses", "anthropic", "gemini"]);
export type ProviderProtocol = z.infer<typeof providerProtocolSchema>;
export const reasoningEffortSchema = z.enum(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const accessIdSchema = z.string().min(1);
export const providerEndpointSchema = z.string().url().refine(value => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, "Expected an HTTP(S) base URL without credentials, query or fragment");
export const endpointMapSchema = z.object({
  "chat-completions": providerEndpointSchema.optional(),
  responses: providerEndpointSchema.optional(),
  anthropic: providerEndpointSchema.optional(),
  gemini: providerEndpointSchema.optional(),
}).strict().readonly();
// Per-model request routing may select a protocol for this source. It is a
// request parameter, not upstream catalog capability metadata, so the catalog
// entry schema above stays free of apiMode.
const modelOverrideSchema = modelCatalogEntrySchema.unwrap().omit({ id: true }).partial().extend({
  apiMode: providerProtocolSchema.optional(),
});
export const modelSelectionSchema = z.object({
  mode: z.enum(["all", "selected", "none"]),
  models: z.array(z.string().min(1)).readonly().optional(),
  manual: modelCatalogSchema.optional(),
  overrides: z.record(modelOverrideSchema).readonly().optional(),
}).strict().readonly();
export const routingStrategySchema = z.enum(["order", "rotate", "usage", "smart", "pace"]);
export const sourceAccessFields = {
  preset: z.string().optional(),
  endpoints: endpointMapSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  modelAliases: z.record(z.string().min(1)).readonly().optional(),
  credentialRouting: routingStrategySchema.optional(),
  sticky: z.boolean().optional(),
  activeCredentialId: accessIdSchema.optional(),
};
export const accountPlatformSchema = z.enum(["codex", "copilot"]);
export const accountTokensSchema = z.object({
  platform: accountPlatformSchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  accountId: z.string().optional(),
  endpoint: providerEndpointSchema.optional(),
  tokenType: z.string().optional(),
}).strict().readonly();
export type AccountTokens = z.infer<typeof accountTokensSchema>;
const keySchema = z.string().refine(value => !/[\r\n\0]/.test(value), "Credential must not contain line breaks");
export const credentialInputSchema = z.object({
  id: accessIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  type: z.enum(["api-key", "account"]).default("api-key"),
  apiKey: keySchema.optional(),
  account: accountTokensSchema.optional(),
  protocol: providerProtocolSchema.optional(),
}).strict().readonly();
export type CredentialInput = z.infer<typeof credentialInputSchema>;
export const publicCredentialSchema = z.object({
  id: accessIdSchema,
  label: z.string(),
  enabled: z.boolean(),
  type: z.enum(["api-key", "account"]),
  status: z.enum(["ready", "disabled", "expired", "signed-out"]),
  platform: accountPlatformSchema.optional(),
  expiresAt: z.number().optional(),
  protocol: providerProtocolSchema.optional(),
}).strict().readonly();
export const providerAuthSchema = z.object({
  type: z.enum(["auto", "bearer", "api-key", "none", "header"]),
  header: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).optional(),
  prefix: keySchema.optional(),
}).strict().readonly().refine(auth => auth.type !== "header" || !!auth.header, "Header authentication requires a header name");
const reservedHeaders = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "trailer", "te"]);
export const providerHeadersSchema = z.record(z.string(), keySchema).readonly().refine(headers =>
  Object.keys(headers).every(name => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !reservedHeaders.has(name.toLowerCase())),
  "Invalid or reserved transport header");
// Credentials are explicitly supplied by the user; no ambient ADC/keychain scan.
export const vertexConfigSchema = z.object({
  project: z.string().min(1), location: z.string().optional(),
  credentials: z.record(z.unknown()).readonly(), impersonate: z.string().optional(),
}).strict().readonly();
export type VertexConfig = z.infer<typeof vertexConfigSchema>;
// JSON values are validated by the containing request schema before persistence.
export const connectionInputSchema = z.object({
  vertex: vertexConfigSchema.nullable().optional(),
  auth: providerAuthSchema.optional(),
  headers: providerHeadersSchema.optional(),
  extraBody: z.record(z.unknown()).readonly().optional(),
  proxyUrl: z.string().refine(value => {
    if (!value) return true;
    try { return ["http:", "https:", "socks5:", "socks5h:"].includes(new URL(value).protocol); } catch { return false; }
  }, "Invalid proxy URL").optional(),
}).strict().readonly();
export type ConnectionInput = z.infer<typeof connectionInputSchema>;
export const publicConnectionSchema = z.object({
  auth: providerAuthSchema.optional(),
  headerNames: z.array(z.string()).readonly(),
  hasExtraBody: z.boolean(),
  hasProxy: z.boolean(), hasVertex: z.boolean().optional(),
}).strict().readonly();
export const routeMemberSchema = z.object({
  sourceId: z.string().min(1), model: z.string().min(1),
  credentialId: accessIdSchema.optional(), enabled: z.boolean().optional(),
}).strict().readonly();
export const routeGroupSchema = z.object({
  id: accessIdSchema, label: z.string(), strategy: routingStrategySchema,
  sticky: z.boolean().optional(), members: z.array(routeMemberSchema).min(1).readonly(),
}).strict().readonly();
export type RouteGroup = z.infer<typeof routeGroupSchema>;
export type RouteMember = z.infer<typeof routeMemberSchema>;
export const routeOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("save"), group: routeGroupSchema }).strict(),
  z.object({ type: z.literal("remove"), id: accessIdSchema }).strict(),
]).readonly();
export const providerAttemptSchema = z.object({
  sourceId: z.string(), model: z.string(), credentialId: z.string().optional(),
  apiMode: z.string(), groupId: z.string().optional(), attempt: z.number().int().nonnegative(),
  reason: z.string(), outcome: z.enum(["started", "succeeded", "failed"]), timestamp: z.string(),
  // Requested configuration at attempt time, not a provider-confirmed effort.
  // Missing on historical records; do not default those to the current setting.
  reasoningEffort: reasoningEffortSchema.optional(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number(), cachedPromptTokens: z.number().optional() }).strict().optional(),
  errorCode: z.string().optional(),
}).strict().readonly();
export type ProviderAttempt = z.infer<typeof providerAttemptSchema>;

export const modelAccessRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("presets") }).strict(),
  z.object({ type: z.literal("catalog"), sourceId: z.string(), refresh: z.boolean().optional(), credentialId: z.string().optional(), includeUnselected: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("test"), sourceId: z.string(), credentialId: z.string().optional(), model: z.string().optional(), kind: z.enum(["catalog", "inference"]), requestId: z.string().optional() }).strict(),
  z.object({ type: z.literal("cancel"), requestId: z.string() }).strict(),
  z.object({ type: z.literal("import-preview"), text: z.string() }).strict(),
  z.object({ type: z.literal("import-apply"), previewId: z.string(), sourceIds: z.array(z.string()).readonly() }).strict(),
  z.object({ type: z.literal("login-start"), platform: accountPlatformSchema, sourceId: z.string(), label: z.string().optional() }).strict(),
  z.object({ type: z.literal("login-poll"), loginId: z.string() }).strict(),
  z.object({ type: z.literal("login-cancel"), loginId: z.string() }).strict(),
  z.object({ type: z.literal("quota"), sourceId: z.string(), credentialId: z.string() }).strict(),
]);
export type ModelAccessRequest = z.infer<typeof modelAccessRequestSchema>;
// Every host transport validates this public-only result, not private config.
const presetRegionSchema = z.object({ id: z.string(), name: z.string(), endpoints: endpointMapSchema, website: z.string().url().optional(), keysUrl: z.string().url().optional() }).strict();
export const providerPresetSchema = z.object({
  id: z.string(), name: z.string(), kind: z.enum(["vendor", "relay", "local", "custom"]), endpoints: endpointMapSchema,
  regionLabel: z.string().optional(), regions: z.array(presetRegionSchema).readonly().optional(),
  website: z.string().url().optional(), keysUrl: z.string().url().optional(), noKey: z.boolean().optional(),
}).strict().readonly();
export type PublicProviderPreset = z.infer<typeof providerPresetSchema>;
export const accountLoginSchema = z.object({
  loginId: z.string(), platform: accountPlatformSchema, mode: z.enum(["device", "callback"]),
  status: z.enum(["waiting", "done", "failed", "canceled", "expired"]), expiresAt: z.number(),
  verificationUrl: z.string().url().optional(), userCode: z.string().optional(), credentialId: z.string().optional(),
  account: z.object({ platform: accountPlatformSchema, user: z.string().optional(), plan: z.string().optional(), accountId: z.string().optional(), host: z.string().optional() }).strict().optional(),
  error: z.string().optional(), errorCode: z.string().optional(),
}).strict().readonly();
export type PublicAccountLogin = z.infer<typeof accountLoginSchema>;
export const accountQuotaSchema = z.object({
  platform: accountPlatformSchema, plan: z.string().optional(), updatedAt: z.number(),
  windows: z.array(z.object({ id: z.string(), name: z.string(), remaining: z.number().nullable(), limit: z.number().nullable(), used: z.number().nullable(), usedPercent: z.number().nullable(), resetAt: z.number().nullable(), unlimited: z.boolean() }).strict()).readonly(),
}).strict().readonly();
export const modelAccessResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("presets"), presets: z.array(providerPresetSchema).readonly() }).strict(),
  z.object({ type: z.literal("catalog"), sourceId: z.string(), models: modelCatalogSchema, stale: z.boolean().optional(), fetchedAt: z.string().optional(), error: z.string().optional() }).strict(),
  z.object({ type: z.literal("test"), sourceId: z.string(), kind: z.enum(["catalog", "inference"]), ok: z.boolean(), latencyMs: z.number(), model: z.string().optional(), error: z.string().optional() }).strict(),
  z.object({ type: z.literal("cancel"), cancelled: z.boolean() }).strict(),
  z.object({ type: z.literal("import-preview"), previewId: z.string(), sources: z.array(z.object({ id: z.string(), label: z.string(), baseUrl: providerEndpointSchema, model: z.string(), apiMode: providerProtocolSchema.optional(), credentialCount: z.number(), warnings: z.array(z.string()).readonly() }).strict()).readonly(), warnings: z.array(z.string()).readonly() }).strict(),
  z.object({ type: z.literal("import-apply"), applied: z.array(z.string()).readonly() }).strict(),
  z.object({ type: z.literal("login-start"), login: accountLoginSchema }).strict(),
  z.object({ type: z.literal("login-poll"), login: accountLoginSchema }).strict(),
  z.object({ type: z.literal("login-cancel"), login: accountLoginSchema }).strict(),
  z.object({ type: z.literal("quota"), quota: accountQuotaSchema }).strict(),
]).readonly();
export type ModelAccessResult = z.infer<typeof modelAccessResultSchema>;
