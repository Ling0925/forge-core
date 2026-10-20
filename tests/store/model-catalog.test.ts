import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { modelCatalogCacheKey, openModelCatalogStore } from "../../src/store/model-catalog";
import type { ModelCatalog } from "../../src/shared/model-catalog";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const config = { baseUrl: "https://fixture.test/v1", apiKey: "fixture-secret", requestTimeoutMs: 1000 };
const key = modelCatalogCacheKey(config, "a");
const catalog: ModelCatalog = [{ id: "model", contextWindowTokens: 1048576 }, { id: "unknown", contextWindowTokens: null }];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "forge-catalog-cache-"));
  homes.push(home);
  return { home, store: await openModelCatalogStore(home), path: join(home, "model-catalogs", `${key}.json`) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("persists only normalized metadata privately and reuses it after reopening", async () => {
  const { home, store, path } = await fixture();
  const loader = vi.fn(async () => catalog);
  expect(await store.load(key, loader)).toEqual(catalog);
  expect(await (await openModelCatalogStore(home)).load(key, loader)).toEqual(catalog);
  expect(loader).toHaveBeenCalledTimes(1);
  const text = await readFile(path, "utf8");
  expect(JSON.parse(text)).toMatchObject({ version: 1, key, models: catalog });
  expect(JSON.parse(text).fetchedAt).toMatch(/^\d{4}-/);
  expect(text).not.toContain(config.apiKey);
  expect(text).not.toContain(config.baseUrl);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(home, "model-catalogs"))).mode & 0o777).toBe(0o700);
});

it("keys include source, endpoint, protocol and credential, not model-generation settings", () => {
  const variants = [
    modelCatalogCacheKey(config, "b"),
    modelCatalogCacheKey({ ...config, baseUrl: "https://other.test/v1" }, "a"),
    modelCatalogCacheKey({ ...config, apiKey: "other-fixture" }, "a"),
    modelCatalogCacheKey({ ...config, apiMode: "anthropic" }, "a"),
  ];
  expect(new Set([key, ...variants]).size).toBe(5);
  expect(modelCatalogCacheKey({ ...config, baseUrl: `${config.baseUrl}/`, apiMode: "chat-completions", requestTimeoutMs: 2000, reasoningEffort: "high" }, "a")).toBe(key);
});

it("replaces the whole catalog on explicit refresh, including unknown limits and empty catalogs", async () => {
  const { home, store } = await fixture();
  await store.load(key, async () => catalog);
  const updated: ModelCatalog = [{ id: "model", contextWindowTokens: null }];
  expect(await store.load(key, async () => updated, undefined, true)).toEqual(updated);
  const reopened = await openModelCatalogStore(home);
  const unused = vi.fn(async () => catalog);
  expect(await reopened.load(key, unused)).toEqual(updated);
  await reopened.load(key, async () => [], undefined, true);
  expect(await (await openModelCatalogStore(home)).load(key, unused)).toEqual([]);
  expect(unused).not.toHaveBeenCalled();
});

it("reports failed refreshes without replacing the last successful snapshot", async () => {
  const { home, store, path } = await fixture();
  await store.load(key, async () => catalog);
  const before = await readFile(path, "utf8");
  await expect(store.load(key, async () => { throw Error("offline"); }, undefined, true)).rejects.toThrow("offline");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await (await openModelCatalogStore(home)).load(key, async () => { throw Error("must not fetch"); })).toEqual(catalog);
});

it("refetches missing/corrupt/wrong-version cache without trusting saved defaults", async () => {
  const { store, path } = await fixture();
  const loader = vi.fn(async () => catalog);
  for (const text of ["{broken", JSON.stringify({ version: 9, models: catalog }), JSON.stringify({ version: 1, key, requestedAt: 1, fetchedAt: new Date().toISOString(), models: [{ id: "m", contextWindowTokens: -1 }] })]) {
    await writeFile(path, text, { mode: 0o600 });
    expect(await store.load(key, loader)).toEqual(catalog);
  }
  expect(loader).toHaveBeenCalledTimes(3);
});

it("coalesces concurrent misses without one cancelled reader poisoning the other", async () => {
  const { store } = await fixture();
  const ready = deferred<void>();
  const result = deferred<ModelCatalog>();
  let upstream!: AbortSignal;
  const loader = vi.fn((signal: AbortSignal) => { upstream = signal; ready.resolve(); return result.promise; });
  const a = new AbortController();
  const b = new AbortController();
  const joined = vi.spyOn(b.signal, "addEventListener");
  // Refresh starts synchronously; the normal miss joins it after reading disk.
  const first = store.load(key, loader, a.signal, true);
  const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
  await ready.promise;
  const second = store.load(key, loader, b.signal);
  // Wait until the second reader subscribed, not for an arbitrary timer delay.
  await expect.poll(() => joined.mock.calls.some(([event]) => event === "abort")).toBe(true);
  a.abort();
  await rejected;
  expect(upstream.aborted).toBe(false);
  result.resolve(catalog);
  expect(await second).toEqual(catalog);
  expect(loader).toHaveBeenCalledTimes(1);
});

it("does not persist a cancelled request even if its loader ignores abort", async () => {
  const { home, store } = await fixture();
  const ready = deferred<void>();
  const result = deferred<ModelCatalog>();
  const controller = new AbortController();
  let upstream!: AbortSignal;
  const pending = store.load(key, signal => { upstream = signal; ready.resolve(); return result.promise; }, controller.signal, true);
  const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await ready.promise;
  controller.abort();
  await rejected;
  expect(upstream.aborted).toBe(true);
  result.resolve(catalog);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((await readdir(join(home, "model-catalogs"))).filter(name => name.endsWith(".json"))).toEqual([]);
  const loader = vi.fn(async () => catalog);
  await expect(store.load(key, loader, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(loader).not.toHaveBeenCalled();
});

it("does not let an older in-flight request overwrite an explicit refresh", async () => {
  const { home, store } = await fixture();
  const ready = deferred<void>();
  const old = deferred<ModelCatalog>();
  const first = store.load(key, () => { ready.resolve(); return old.promise; }, undefined, true);
  await ready.promise;
  const fresh: ModelCatalog = [{ id: "new", contextWindowTokens: 64000 }];
  expect(await store.load(key, async () => fresh, undefined, true)).toEqual(fresh);
  old.resolve(catalog);
  expect(await first).toEqual(catalog);
  expect(await (await openModelCatalogStore(home)).load(key, async () => [])).toEqual(fresh);
});
