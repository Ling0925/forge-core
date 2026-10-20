import { z } from "zod";

// Only provider-reported metadata belongs here; never persist a guessed/default
// window or the raw gateway response (which can contain unrelated private data).
export const modelCatalogSchema = z.array(z.object({
  id: z.string().trim().min(1).max(256),
  contextWindowTokens: z.number().int().positive().max(10000000).nullable(),
})).max(10000).readonly();
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
