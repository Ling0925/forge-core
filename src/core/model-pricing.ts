import { join } from "node:path";
import { withCancellation } from "../shared/cancellation";
import type { UsagePricingStatus } from "../shared/ipc";
import {
  type ModelPrice,
  type ModelPrices,
  type TokenRates,
  estimateAggregateCostUsd,
  estimateRequestCostUsd,
  findModelPrice,
  modelCatalogPricingToPrice,
  normalizePricingModelId,
  parseModelPrices,
  resolveRequestRates,
} from "../shared/model-pricing";
import { atomicJson, privateDirectory, readJson } from "../store/io";

export {
  estimateAggregateCostUsd,
  estimateRequestCostUsd,
  findModelPrice,
  modelCatalogPricingToPrice,
  normalizePricingModelId,
  parseModelPrices,
  resolveRequestRates,
  type ModelPrice,
  type ModelPrices,
  type TokenRates,
};

export const MODEL_PRICES_URL = "https://models.dev/api.json";
const refreshIntervalMs = 24 * 60 * 60 * 1000;
const retryIntervalMs = 5 * 60 * 1000;

export interface ModelPricingService {
  getPrices(refresh?: boolean): Promise<ModelPrices>;
  getStatus?(): UsagePricingStatus;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** Lazy public catalog fetch; no session/model IDs or provider credentials leave the host. */
export function createModelPricingService(
  options: {
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    /** Only the public price catalog is persisted here, never provider configuration. */
    readonly cacheDirectory?: string;
    readonly signal?: AbortSignal;
  } = {},
): ModelPricingService & { dispose(): Promise<void> } {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cachePath =
    options.cacheDirectory && join(options.cacheDirectory, "model-prices.json");
  const maxCacheBytes = 16 * 1024 * 1024;
  let prices: ModelPrices = new Map();
  let status: UsagePricingStatus = { state: "unavailable" };
  let cacheLoaded = false;
  let refreshAt = 0;
  let pending: Promise<ModelPrices> | undefined;
  let cacheWrite: Promise<void> | undefined;
  return {
    async dispose() {
      await cacheWrite;
    },
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
              if (
                cached?.version === 1 &&
                cached.source === MODEL_PRICES_URL &&
                fetchedAt !== undefined &&
                fetchedAt <= now()
              ) {
                const restored = parseModelPrices(cached.catalog);
                if (restored.size > 0) {
                  prices = restored;
                  refreshAt = fetchedAt + refreshIntervalMs;
                  status = {
                    state: now() < refreshAt ? "ready" : "stale",
                    fetchedAt: new Date(fetchedAt).toISOString(),
                  };
                }
              }
            } catch {
              // Missing/corrupt cache does not prevent a fresh public download.
            }
          }
        }
        if (!refresh && now() < refreshAt) return prices;
        try {
          const signal = AbortSignal.any([
            AbortSignal.timeout(60_000),
            ...(options.signal ? [options.signal] : []),
          ]);
          const catalog: unknown = await withCancellation(
            fetcher(MODEL_PRICES_URL, {
              headers: { Accept: "application/json" },
              // The full catalog is several MB; the deadline includes the body,
              // not just response headers. A 10s cap discarded healthy slow loads.
              signal,
            }).then((response) => {
              if (!response.ok)
                throw new Error(`Model prices HTTP ${response.status}`);
              return response.json();
            }),
            signal,
          );
          const updated = parseModelPrices(catalog);
          if (updated.size === 0) throw new Error("No model prices in catalog");
          const fetchedAt = now();
          prices = updated;
          refreshAt = fetchedAt + refreshIntervalMs;
          status = {
            state: "ready",
            fetchedAt: new Date(fetchedAt).toISOString(),
          };
          if (cachePath && options.cacheDirectory) {
            const directory = options.cacheDirectory;
            cacheWrite = (async () => {
              try {
                await privateDirectory(directory);
                options.signal?.throwIfAborted();
                await atomicJson(
                  cachePath,
                  { version: 1, source: MODEL_PRICES_URL, fetchedAt, catalog },
                  maxCacheBytes,
                );
              } catch {
                // A cache write failure must not discard usable downloaded prices.
              }
            })();
            await cacheWrite;
          }
        } catch (error) {
          if (options.signal?.aborted) throw error;
          // Preserve last known prices across outages AND process restarts.
          status = {
            ...status,
            state: prices.size > 0 ? "stale" : "unavailable",
          };
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
