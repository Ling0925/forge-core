import { describe, expect, it, vi } from "vitest";
import {
  MODEL_PRICES_URL,
  createModelPricingService,
  estimateRequestCostUsd,
  findModelPrice,
  normalizePricingModelId,
  parseModelPrices,
} from "../../src/core/model-pricing";

const catalog = {
  relay: { models: {
    "lab/model-v1": { id: "lab/model-v1", canonical_model_id: "lab/model-v1", cost: { input: 99, output: 99 } },
    "lab/model-v1:free": { id: "lab/model-v1:free", cost: { input: 0, output: 0 } },
    "vendor/relay-only": { id: "vendor/relay-only", cost: { input: 2, output: 4 } },
  } },
  subscription: { models: { "model-v1": { id: "model-v1", canonical_model_id: "lab/model-v1", cost: { input: 0, output: 0 } } } },
  lab: { id: "lab", models: {
    "model-v1": { id: "model-v1", canonical_model_id: "lab/model-v1", cost: { input: 3, output: 15, cache_read: 0.3 } },
  } },
};
const usage = { promptTokens: 1000, completionTokens: 200, cachedPromptTokens: 400, totalTokens: 1200 };

describe("models.dev request pricing", () => {
  it.each([
    ["model-v1", "model-v1"],
    ["source:model-v1", "model-v1"],
    ["source/model-v1", "model-v1"],
    ["source:vendor/model-v1", "model-v1"],
    ["source/vendor:model-v1", "model-v1"],
    ["  Source:Vendor/MODEL-v1  ", "model-v1"],
    ["cn:deepseek-v4.1-flash", "deepseek-v4.1-flash"],
    ["", ""],
  ])("normalizes %s to %s", (model, expected) => {
    expect(normalizePricingModelId(model)).toBe(expected);
  });

  it("matches IDs, prefers first-party duplicates, and is independent of catalog order", () => {
    const prices = parseModelPrices(catalog);
    const reversed = parseModelPrices(Object.fromEntries(Object.entries(catalog).reverse()));
    for (const model of ["model-v1", "lab/model-v1", "source:model-v1", "source/model-v1", "source:vendor/MODEL-v1"]) {
      expect(findModelPrice(prices, model)).toMatchObject({ providerId: "lab", rates: { input: 3, output: 15, cacheRead: 0.3 } });
      expect(findModelPrice(reversed, model)).toEqual(findModelPrice(prices, model));
    }
    expect(findModelPrice(prices, "other:relay-only")).toMatchObject({ rates: { input: 2, output: 4 } });
    // Explicit zero pricing stays zero, rather than being treated as missing.
    expect(findModelPrice(prices, "lab/model-v1:free")?.rates).toEqual({ input: 0, output: 0 });
    for (const model of ["model", "model-v1-latest", "model-v2", "", "Model Display Name"]) {
      expect(findModelPrice(prices, model)).toBeUndefined();
    }
  });

  it("uses keyed IDs, keeps real zero prices and skips invalid metadata", () => {
    const prices = parseModelPrices({
      ignored: null,
      vendor: { models: {
        "free": { cost: { input: 0, output: 0 } },
        "partial": { cost: { output: 2 } },
        "missing": { name: "Missing" },
        "bad": { cost: { input: -1, output: "20", cache_read: Number.NaN } },
        "infinite": { cost: { input: Number.POSITIVE_INFINITY } },
        "": { cost: { input: 1, output: 2 } },
      } },
    });
    expect(findModelPrice(prices, "prefix:free")?.rates).toEqual({ input: 0, output: 0 });
    expect(findModelPrice(prices, "partial")?.rates).toEqual({ output: 2 });
    for (const id of ["missing", "bad", "infinite", ""]) expect(findModelPrice(prices, id)).toBeUndefined();
    expect(parseModelPrices(null).size).toBe(0);
    expect(parseModelPrices([]).size).toBe(0);
  });

  it("calculates USD per million, subtracts cache hits from normal input and never invents usage", () => {
    const prices = parseModelPrices(catalog);
    const price = findModelPrice(prices, "model-v1");
    expect(estimateRequestCostUsd(usage, price)).toBeCloseTo(0.00492, 10);
    expect(estimateRequestCostUsd({ ...usage, cachedPromptTokens: 0 }, price)).toBeCloseTo(0.006, 10);
    expect(estimateRequestCostUsd({ ...usage, cachedPromptTokens: 2000 }, price)).toBeCloseTo(0.0033, 10);
    expect(estimateRequestCostUsd(usage, findModelPrice(prices, "relay-only"))).toBeCloseTo(0.0028, 10);
    expect(estimateRequestCostUsd(usage, findModelPrice(prices, "lab/model-v1:free"))).toBe(0);
    expect(estimateRequestCostUsd({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, price)).toBe(0);
    expect(estimateRequestCostUsd(undefined, price)).toBeUndefined();
    expect(estimateRequestCostUsd(usage, undefined)).toBeUndefined();
    expect(estimateRequestCostUsd({ ...usage, completionTokens: -1 }, price)).toBeUndefined();
    expect(estimateRequestCostUsd({ ...usage, promptTokens: Number.NaN }, price)).toBeUndefined();
  });

  it("leaves estimates unknown when a needed rate is absent", () => {
    const price = findModelPrice(parseModelPrices({ vendor: { models: { partial: { cost: { output: 2 } } } } }), "partial");
    expect(estimateRequestCostUsd(usage, price)).toBeUndefined();
    expect(estimateRequestCostUsd({ promptTokens: 0, completionTokens: 200, totalTokens: 200 }, price)).toBeCloseTo(0.0004, 10);
  });

  it("uses context-tier prices without mixing in other pricing dimensions", () => {
    const prices = parseModelPrices({ google: { models: {
      tiered: { cost: { input: 1, output: 2, cache_read: 0.1, tiers: [
        { input: 8, output: 16, tier: { type: "context", size: 400000 } },
        { input: 2, output: 4, cache_read: 0.2, tier: { type: "context", size: 200000 } },
        { input: 99, output: 99, tier: { type: "batch", size: 0 } },
      ], context_over_200k: { input: 999, output: 999 } } },
      legacy: { cost: { input: 1, output: 2, cache_read: 0.1, context_over_200k: { input: 2, output: 4 } } },
    } } });
    const price = findModelPrice(prices, "tiered");
    const costFor = (input: number) => estimateRequestCostUsd({ promptTokens: input, completionTokens: 1000, totalTokens: input + 1000 }, price);
    expect(costFor(200000)).toBeCloseTo(0.202, 10);
    expect(costFor(200001)).toBeCloseTo(0.404002, 10);
    expect(costFor(500000)).toBeCloseTo(4.016, 10);
    expect(estimateRequestCostUsd({ promptTokens: 300000, completionTokens: 1000, cachedPromptTokens: 100000, totalTokens: 301000 }, price)).toBeCloseTo(0.424, 10);
    expect(estimateRequestCostUsd({ promptTokens: 300000, completionTokens: 1000, totalTokens: 301000 }, findModelPrice(prices, "legacy"))).toBeCloseTo(0.604, 10);
  });
});

describe("automatic price catalog cache", () => {
  it("fetches the public catalog lazily, coalesces concurrent reads and refreshes after a day", async () => {
    let now = 1000;
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValueOnce(Response.json({ lab: { models: { "model-v1": { cost: { input: 5, output: 20 } } } } }));
    const service = createModelPricingService({ fetch: fetcher, now: () => now });
    expect(fetcher).not.toHaveBeenCalled();
    const first = service.getPrices();
    const second = service.getPrices();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(MODEL_PRICES_URL, { headers: { Accept: "application/json" }, signal: expect.any(AbortSignal) });
    release(Response.json(catalog));
    expect(await second).toBe(await first);
    expect(await service.getPrices()).toBe(await first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 24 * 3600000;
    expect(findModelPrice(await service.getPrices(), "model-v1")?.rates.input).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains last good prices on a failed refresh and retries later", async () => {
    let now = 1000;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(catalog))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ lab: { models: { "model-v1": { cost: { input: 8, output: 20 } } } } }));
    const service = createModelPricingService({ fetch: fetcher, now: () => now });
    const original = await service.getPrices();
    now += 24 * 3600000;
    expect(await service.getPrices()).toBe(original);
    expect(await service.getPrices()).toBe(original);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 5 * 60000;
    expect(findModelPrice(await service.getPrices(), "model-v1")?.rates.input).toBe(8);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["network", "json", "empty"])("keeps initial %s failures non-fatal and unknown, with a later recovery", async failure => {
    let now = 1000;
    const fetcher = vi.fn<typeof fetch>();
    if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
    else fetcher.mockResolvedValueOnce(new Response(failure === "json" ? "not JSON" : "{}"));
    fetcher.mockResolvedValueOnce(Response.json(catalog));
    const service = createModelPricingService({ fetch: fetcher, now: () => now });
    const unavailable = await service.getPrices();
    expect(unavailable.size).toBe(0);
    expect(estimateRequestCostUsd(usage, findModelPrice(unavailable, "model-v1"))).toBeUndefined();
    await service.getPrices();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 5 * 60000;
    expect(findModelPrice(await service.getPrices(), "model-v1")).toBeDefined();
  });
});
