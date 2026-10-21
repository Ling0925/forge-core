import { join } from "node:path";
import type { UsagePricingStatus } from "../shared/ipc";
import { atomicJson, privateDirectory, readJson } from "../store/io";
import type { ModelCatalogEntry } from "../shared/model-catalog";
import type { Usage } from "../shared/schemas";

export const MODEL_PRICES_URL = "https://models.dev/api.json";
const refreshIntervalMs = 24 * 60 * 60 * 1000;
const retryIntervalMs = 5 * 60 * 1000;

type TokenRates = Pick<NonNullable<ModelCatalogEntry["pricing"]>, "input" | "output" | "cacheRead">;
export interface ModelPrice {
  readonly providerId: string;
  readonly modelId: string;
  /** USD per million tokens, as published by models.dev. */
  readonly rates: TokenRates;
  readonly contextTiers: readonly { readonly aboveTokens: number; readonly rates: TokenRates }[];
}
export type ModelPrices = ReadonlyMap<string, ModelPrice>;
export interface ModelPricingService {
  getPrices(refresh?: boolean): Promise<ModelPrices>;
  getStatus?(): UsagePricingStatus;
}

/** Match a configured source/model or source:model by its concrete model ID. */
export const normalizePricingModelId = (model: string): string =>
  (model.trim().split(/[/:]/).at(-1) ?? "").toLowerCase();

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function tokenRates(value: unknown): TokenRates | undefined {
  const cost = record(value);
  if (!cost) return undefined;
  const input = amount(cost.input);
  const output = amount(cost.output);
  const cacheRead = amount(cost.cache_read);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
  };
}

export function parseModelPrices(value: unknown): ModelPrices {
  const candidates: { price: ModelPrice; priority: number }[] = [];
  for (const [providerKey, rawProvider] of Object.entries(record(value) ?? {})) {
    const provider = record(rawProvider);
    const providerId = typeof provider?.id === "string" ? provider.id : providerKey;
    for (const [modelKey, rawModel] of Object.entries(record(provider?.models) ?? {})) {
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
          if (condition?.type === "context" && aboveTokens !== undefined && tierRates) {
            contextTiers.push({ aboveTokens, rates: { ...rates, ...tierRates } });
          }
        }
      }
      // Older catalog versions expose this tier without the general tiers array.
      const over200k = tokenRates(cost?.context_over_200k);
      if (over200k && !contextTiers.some(tier => tier.aboveTokens === 200000)) {
        contextTiers.push({ aboveTokens: 200000, rates: { ...rates, ...over200k } });
      }
      const canonical = typeof model.canonical_model_id === "string" ? model.canonical_model_id : "";
      // Prefer the originating lab over relays/subscriptions with the same ID.
      // Then prefer a bare ID; sort ties so upstream JSON order never picks a price.
      const firstParty = canonical.split("/")[0]?.toLowerCase() === providerId.toLowerCase();
      candidates.push({
        price: { providerId, modelId, rates, contextTiers: contextTiers.sort((a, b) => a.aboveTokens - b.aboveTokens) },
        priority: firstParty ? 0 : modelId.toLowerCase() === normalized ? 1 : 2,
      });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority ||
    a.price.providerId.localeCompare(b.price.providerId) || a.price.modelId.localeCompare(b.price.modelId));
  const prices = new Map<string, ModelPrice>();
  for (const { price } of candidates) {
    const key = normalizePricingModelId(price.modelId);
    if (!prices.has(key)) prices.set(key, price);
  }
  return prices;
}

export function findModelPrice(prices: ModelPrices, model: string): ModelPrice | undefined {
  return prices.get(normalizePricingModelId(model));
}

export function estimateRequestCostUsd(usage: Usage | undefined, price: ModelPrice | undefined): number | undefined {
  if (!usage || !price) return undefined;
  const input = amount(usage.promptTokens);
  const output = amount(usage.completionTokens);
  if (input === undefined || output === undefined) return undefined;
  let rates = price.rates;
  for (const tier of price.contextTiers) {
    if (input > tier.aboveTokens) rates = tier.rates;
  }
  // promptTokens already includes cache hits in every provider adapter.
  const cached = Math.min(input, amount(usage.cachedPromptTokens) ?? 0);
  const inputTokens = input - cached;
  const cacheRate = rates.cacheRead ?? rates.input;
  if ((inputTokens > 0 && rates.input === undefined) ||
      (cached > 0 && cacheRate === undefined) || (output > 0 && rates.output === undefined)) return undefined;
  const cost = (inputTokens * (rates.input ?? 0) + cached * (cacheRate ?? 0) + output * (rates.output ?? 0)) / 1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}

/** Lazy public catalog fetch; no session/model IDs or provider credentials leave the host. */
export function createModelPricingService(options: {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Only the public price catalog is persisted here, never provider configuration. */
  readonly cacheDirectory?: string;
} = {}): ModelPricingService {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cachePath = options.cacheDirectory && join(options.cacheDirectory, "model-prices.json");
  const maxCacheBytes = 16 * 1024 * 1024;
  let prices: ModelPrices = new Map();
  let status: UsagePricingStatus = { state: "unavailable" };
  let cacheLoaded = false;
  let refreshAt = 0;
  let pending: Promise<ModelPrices> | undefined;
  return {
    getStatus: () => status,
    async getPrices(refresh = false) {
      if (pending) return pending;
      if (!refresh && now() < refreshAt) return prices;
      pending = (async () => {
        if (!cacheLoaded) {
          cacheLoaded = true;
          if (cachePath) {
            try {
              const cached = record(await readJson(cachePath, maxCacheBytes));
              const fetchedAt = amount(cached?.fetchedAt);
              if (cached?.version === 1 && cached.source === MODEL_PRICES_URL &&
                  fetchedAt !== undefined && fetchedAt <= now()) {
                const restored = parseModelPrices(cached.catalog);
                if (restored.size > 0) {
                  prices = restored;
                  refreshAt = fetchedAt + refreshIntervalMs;
                  status = { state: now() < refreshAt ? "ready" : "stale",
                    fetchedAt: new Date(fetchedAt).toISOString() };
                }
              }
            } catch {
              // Missing/corrupt cache does not prevent a fresh public download.
            }
          }
        }
        if (!refresh && now() < refreshAt) return prices;
        try {
          const response = await fetcher(MODEL_PRICES_URL, {
            headers: { Accept: "application/json" },
            // The full catalog is several MB; the deadline includes the body,
            // not just response headers. A 10s cap discarded healthy slow loads.
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) throw new Error(`Model prices HTTP ${response.status}`);
          const catalog: unknown = await response.json();
          const updated = parseModelPrices(catalog);
          if (updated.size === 0) throw new Error("No model prices in catalog");
          const fetchedAt = now();
          prices = updated;
          refreshAt = fetchedAt + refreshIntervalMs;
          status = { state: "ready", fetchedAt: new Date(fetchedAt).toISOString() };
          if (cachePath && options.cacheDirectory) {
            try {
              await privateDirectory(options.cacheDirectory);
              await atomicJson(cachePath, { version: 1, source: MODEL_PRICES_URL, fetchedAt, catalog }, maxCacheBytes);
            } catch {
              // A cache write failure must not discard usable downloaded prices.
            }
          }
        } catch {
          // Preserve last known prices across outages AND process restarts.
          status = { ...status, state: prices.size > 0 ? "stale" : "unavailable" };
          refreshAt = now() + retryIntervalMs;
        }
        return prices;
      })();
      try {
        return await pending;
      } finally {
        pending = undefined;
      }
    },
  };
}
