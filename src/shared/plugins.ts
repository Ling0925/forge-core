import { z } from "zod";
import { jsonObjectSchema, sessionIdSchema } from "./schemas";

/** Versioned, browser-safe contracts. Manifests describe capabilities, never grant them. */
export const PLUGIN_API_VERSION = 1;
export const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const executable = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n\0]/.test(value));
export const browserPluginConfigSchema = z
  .object({
    executablePath: executable.default("agent-browser"),
    browserExecutablePath: z
      .string()
      .max(4096)
      .refine((value) => !/[\r\n\0]/.test(value))
      .default(""),
    // Hostnames, not origins. Only an explicit "*" grants all hosts; empty stays deny-all.
    // Retired global browser preferences never grant or configure plugin access.
    allowedDomains: z
      .array(
        z.union([
          z.literal("*"),
          z
            .string()
            .min(1)
            .max(253)
            .regex(
              /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
            ),
        ]),
      )
      .max(64)
      .readonly()
      .default([]),
  })
  .strict()
  .readonly();
export type BrowserPluginConfig = z.infer<typeof browserPluginConfigSchema>;

/** OfficeCLI is an explicitly configured host executable, not a project-loaded plugin. */
export const officecliPluginConfigSchema = z
  .object({
    executablePath: executable.default("officecli"),
    timeoutMs: z.number().int().min(1000).max(300000).default(120000),
  })
  .strict()
  .readonly();
export type OfficeCliPluginConfig = z.infer<typeof officecliPluginConfigSchema>;

export const pluginManifestSchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().min(1).max(100),
    version: z.string().min(1).max(32),
    apiVersion: z.literal(PLUGIN_API_VERSION),
    description: z.string().max(2000),
    builtin: z.boolean(),
    capabilities: z
      .array(z.enum(["tools", "instructions", "browser", "network", "process"]))
      .max(16)
      .readonly(),
    configSchema: jsonObjectSchema,
  })
  .strict()
  .readonly();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export const pluginRecordSchema = z
  .object({
    manifest: pluginManifestSchema,
    enabled: z.boolean(),
    config: jsonObjectSchema,
    status: z.enum(["disabled", "configured", "running"]),
    activeSessions: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type PluginRecord = z.infer<typeof pluginRecordSchema>;
export const pluginConfigureInputSchema = z
  .object({
    pluginId: pluginIdSchema,
    enabled: z.boolean().optional(),
    config: jsonObjectSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.enabled !== undefined || value.config !== undefined,
    "Supply enabled or config.",
  )
  .readonly();
export type PluginConfigureInput = z.infer<typeof pluginConfigureInputSchema>;
export const pluginHealthSchema = z
  .object({
    pluginId: pluginIdSchema,
    status: z.enum(["ready", "unavailable"]),
    message: z.string().max(2000),
  })
  .strict()
  .readonly();
export type PluginHealth = z.infer<typeof pluginHealthSchema>;

const selector = z.string().min(1).max(1000);
const navigationUrl = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Expected a credential-free HTTP(S) URL.");
export const browserCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: navigationUrl }).strict(),
  z.object({ action: z.literal("snapshot") }).strict(),
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("click"), selector }).strict(),
  z
    .object({ action: z.literal("fill"), selector, text: z.string().max(4000) })
    .strict(),
  z
    .object({ action: z.literal("press"), key: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      direction: z.enum(["up", "down", "left", "right"]),
      pixels: z.number().int().min(1).max(5000).default(500),
    })
    .strict(),
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("close") }).strict(),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export const browserImageSchema = z
  .object({
    mimeType: z.enum(["image/png", "image/jpeg"]),
    data: z
      .string()
      .min(4)
      .max(700_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((value) => value.length % 4 === 0, "Expected base64 bytes."),
  })
  .strict()
  .readonly();
export const browserCommandResultSchema = z
  .object({
    text: z.string().max(24000),
    isError: z.boolean(),
    image: browserImageSchema.optional(),
  })
  .strict()
  .readonly();
export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>;
export const browserRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ sessionId: sessionIdSchema, action: z.literal("status") })
    .strict(),
  z
    .object({
      sessionId: sessionIdSchema,
      action: z.literal("takeover"),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      sessionId: sessionIdSchema,
      action: z.literal("execute"),
      command: browserCommandSchema,
    })
    .strict(),
]);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;
export const browserResponseSchema = z
  .object({
    sessionId: sessionIdSchema,
    available: z.boolean(),
    takeover: z.boolean(),
    result: browserCommandResultSchema.optional(),
  })
  .strict()
  .readonly();
export type BrowserResponse = z.infer<typeof browserResponseSchema>;
