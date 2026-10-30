import type { Usage } from "./schemas";

/**
 * Sum two provider usage reports. Cached prompt tokens are provider-reported
 * only: the sum carries them when either side reported a count (a missing
 * side counts as zero) and stays absent when neither did.
 */
export const addUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  ...(a.cachedPromptTokens === undefined && b.cachedPromptTokens === undefined
    ? {}
    : {
        cachedPromptTokens:
          (a.cachedPromptTokens ?? 0) + (b.cachedPromptTokens ?? 0),
      }),
});
