import { z } from "zod";

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
