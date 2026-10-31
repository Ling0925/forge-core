import { z } from "zod";
import { imageAttachmentsSchema } from "../images";
import { webCitationSchema, webSearchRecordSchema } from "../web-search";
import { jsonObjectSchema } from "./base";
import { settingsFields } from "./settings";

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
/** Display-only generation metadata. Partial arguments never cross the UI boundary. */
export const toolCallPreviewSchema = z
  .object({
    index: z.number().int().min(0).max(255),
    name: z
      .string()
      .max(64)
      .regex(/^[a-zA-Z0-9_-]*$/),
    argumentsChars: z.number().int().min(0).max(1000000),
    // Coarse live line estimate for write/edit arguments. Absent for tools that
    // cannot be estimated, and never a diff: only bounded counters cross the
    // boundary, never raw argument fragments.
    linesAdded: z.number().int().min(0).max(1000000).optional(),
    linesRemoved: z.number().int().min(0).max(1000000).optional(),
  })
  .strict()
  .readonly();
export type ToolCallPreview = z.infer<typeof toolCallPreviewSchema>;
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
    apiMode: z.enum(["responses", "anthropic", "gemini"]),
    credentialId: z.string().optional(),
    credentialScope: z.string().optional(),
    baseUrl: settingsFields.baseUrl,
    model: settingsFields.model,
    output: z.array(jsonObjectSchema).max(256).readonly(),
  })
  .strict()
  .readonly();
export type ProviderState = z.infer<typeof providerStateSchema>;
export const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().max(2000000).nullable(),
    // Display-only reasoning persisted so a resumed session can show it again.
    // Bounded, never sent back to the provider, and not part of assistant content.
    reasoning: z.string().max(131072).optional(),
    // Local attempt identity, never serialized into provider requests.
    generationId: z.string().uuid().optional(),
    providerState: providerStateSchema.optional(),
    citations: z.array(webCitationSchema).max(256).readonly().optional(),
    webSearches: z.array(webSearchRecordSchema).max(128).readonly().optional(),
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
        images: imageAttachmentsSchema.optional(),
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
