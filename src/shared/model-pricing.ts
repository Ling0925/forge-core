import type { ModelCatalogEntry } from "./model-catalog";
import type { Usage } from "./schemas";

export type TokenRates = Pick<
  NonNullable<ModelCatalogEntry["pricing"]>,
  "input" | "output" | "cacheRead"
>;

export interface ModelPrice {
  readonly providerId: string;
  readonly modelId: string;
  /** USD per million tokens, as published by models.dev. */
  readonly rates: TokenRates;
  readonly contextTiers: readonly {
    readonly aboveTokens: number;
    readonly rates: TokenRates;
  }[];
}

export type ModelPrices = ReadonlyMap<string, ModelPrice>;

/** Match a configured source/model or source:model by its concrete model ID. */
export const normalizePricingModelId = (model: string): string =>
  (model.trim().split(/[/:]/).at(-1) ?? "").toLowerCase();

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

function tokenRates(value: unknown): TokenRates | undefined {
  const cost = record(value);
  if (!cost) return undefined;
  const input = amount(cost.input);
  const output = amount(cost.output);
  const cacheRead = amount(cost.cache_read ?? cost.cacheRead);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
  };
}

export function modelCatalogPricingToPrice(
  modelId: string,
  pricing: ModelCatalogEntry["pricing"] | undefined,
  fallback?: ModelPrice | undefined,
): ModelPrice | undefined {
  if (!pricing) return fallback;
  const currency = pricing.currency?.trim().toUpperCase();
  if (currency && currency !== "USD" && currency !== "$") return fallback;
  const input = amount(pricing.input) ?? fallback?.rates.input;
  const output = amount(pricing.output) ?? fallback?.rates.output;
  const cacheRead = amount(pricing.cacheRead) ?? fallback?.rates.cacheRead;
  if (input === undefined && output === undefined) return fallback;
  return {
    providerId: pricing.source ?? fallback?.providerId ?? "catalog",
    modelId: modelId || fallback?.modelId || "",
    rates: {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
    },
    contextTiers: fallback?.contextTiers ?? [],
  };
}

export function parseModelPrices(value: unknown): ModelPrices {
  const candidates: { price: ModelPrice; priority: number }[] = [];
  for (const [providerKey, rawProvider] of Object.entries(
    record(value) ?? {},
  )) {
    const provider = record(rawProvider);
    const providerId =
      typeof provider?.id === "string" ? provider.id : providerKey;
    for (const [modelKey, rawModel] of Object.entries(
      record(provider?.models) ?? {},
    )) {
      const model = record(rawModel);
      if (!model) continue;
      const modelId = typeof model.id === "string" ? model.id : modelKey;
      const normalized = normalizePricingModelId(modelId);
      const cost = record(model.cost);
      const rates = tokenRates(cost);
      if (!normalized || !rates) continue;
      const contextTiers: ModelPrice["contextTiers"][number][] = [];
      if (Array.isArray(cost?.tiers)) {
        for (const rawTier of cost.tiers) {
          const tier = record(rawTier);
          const condition = record(tier?.tier);
          const aboveTokens = amount(condition?.size);
          const tierRates = tokenRates(tier);
          if (
            condition?.type === "context" &&
            aboveTokens !== undefined &&
            tierRates
          ) {
            contextTiers.push({
              aboveTokens,
              rates: { ...rates, ...tierRates },
            });
          }
        }
      }
      // Older catalog versions expose this tier without the general tiers array.
      const over200k = tokenRates(cost?.context_over_200k);
      if (
        over200k &&
        !contextTiers.some((tier) => tier.aboveTokens === 200000)
      ) {
        contextTiers.push({
          aboveTokens: 200000,
          rates: { ...rates, ...over200k },
        });
      }
      const canonical =
        typeof model.canonical_model_id === "string"
          ? model.canonical_model_id
          : "";
      // Prefer the originating lab over relays/subscriptions with the same ID.
      // Then prefer a bare ID; sort ties so upstream JSON order never picks a price.
      const firstParty =
        canonical.split("/")[0]?.toLowerCase() === providerId.toLowerCase();
      candidates.push({
        price: {
          providerId,
          modelId,
          rates,
          contextTiers: contextTiers.sort(
            (a, b) => a.aboveTokens - b.aboveTokens,
          ),
        },
        priority: firstParty ? 0 : modelId.toLowerCase() === normalized ? 1 : 2,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.price.providerId.localeCompare(b.price.providerId) ||
      a.price.modelId.localeCompare(b.price.modelId),
  );
  const prices = new Map<string, ModelPrice>();
  for (const { price } of candidates) {
    const key = normalizePricingModelId(price.modelId);
    if (!prices.has(key)) prices.set(key, price);
  }
  return prices;
}

export function findModelPrice(
  prices: ModelPrices,
  model: string,
): ModelPrice | undefined {
  const key = normalizePricingModelId(model);
  // Historical IDs can include a 1M context-window annotation. Prefer an exact
  // catalog entry, then its base model; do not strip actual model variants.
  return (
    prices.get(key) ??
    (key.endsWith("[1m]") ? prices.get(key.slice(0, -4)) : undefined)
  );
}

export function resolveRequestRates(
  usage: Pick<Usage, "promptTokens"> | undefined,
  price: ModelPrice | undefined,
): TokenRates | undefined {
  if (!price) return undefined;
  const input = amount(usage?.promptTokens);
  let rates = price.rates;
  if (input !== undefined) {
    for (const tier of price.contextTiers) {
      if (input > tier.aboveTokens) rates = tier.rates;
    }
  }
  return rates;
}

export function estimateRequestCostUsd(
  usage: Usage | undefined,
  price: ModelPrice | undefined,
): number | undefined {
  if (!usage || !price) return undefined;
  const input = amount(usage.promptTokens);
  const output = amount(usage.completionTokens);
  if (input === undefined || output === undefined) return undefined;
  const rates = resolveRequestRates(usage, price) ?? price.rates;
  // promptTokens already includes cache hits in every provider adapter.
  const cached = Math.min(input, amount(usage.cachedPromptTokens) ?? 0);
  const inputTokens = input - cached;
  const cacheRate = rates.cacheRead ?? rates.input;
  if (
    (inputTokens > 0 && rates.input === undefined) ||
    (cached > 0 && cacheRate === undefined) ||
    (output > 0 && rates.output === undefined)
  )
    return undefined;
  const cost =
    (inputTokens * (rates.input ?? 0) +
      cached * (cacheRate ?? 0) +
      output * (rates.output ?? 0)) /
    1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}

/**
 * Legacy run totals have no per-request context size. Use explicitly labelled
 * base-rate estimates, never treat millions of accumulated tokens as one request.
 */
export function estimateAggregateCostUsd(
  usage: Usage | undefined,
  price: ModelPrice | undefined,
): number | undefined {
  return estimateRequestCostUsd(usage, price && { ...price, contextTiers: [] });
}
