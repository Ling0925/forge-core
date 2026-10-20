import { z } from "zod";

// Normalized, public metadata only. Missing capability is unknown, not false.
export const modelCatalogEntrySchema = z.object({
  id: z.string().min(1).max(256),
  contextWindowTokens: z.number().int().positive().nullable(),
  displayName: z.string().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  inputModalities: z.array(z.string()).readonly().optional(),
  outputModalities: z.array(z.string()).readonly().optional(),
  reasoningEfforts: z.array(z.string()).readonly().optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  protocols: z.array(z.enum(["chat-completions", "responses", "anthropic", "gemini"])).readonly().optional(),
  pricing: z.object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    currency: z.string().optional(),
    source: z.string().optional(),
    updatedAt: z.string().optional(),
  }).strict().readonly().optional(),
  provenance: z.record(z.enum(["upstream", "reference", "user"])).readonly().optional(),
}).strip().readonly();
export const modelCatalogSchema = z.array(modelCatalogEntrySchema).max(10000).readonly();
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
