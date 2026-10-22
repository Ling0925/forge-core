import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createModelAccessService } from "../../src/core/model-access";
import { COPILOT_SESSION_URL } from "../../src/provider/accounts";
import type { ModelProvider, ProviderFactory } from "../../src/shared/contracts";
import type { ProviderAttempt } from "../../src/shared/model-access";
import { modelCatalogEntrySchema, type ModelCatalog } from "../../src/shared/model-catalog";
import { accountProtocolCompatible } from "../../src/shared/model-protocol";
import type { ProviderConfig, ProviderSource } from "../../src/shared/schemas";
import { openModelCatalogStore } from "../../src/store/model-catalog";
import { openSettingsStore } from "../../src/store/settings";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const response = { message: { role: "assistant" as const, content: "OK" } };
const endpoints = {
  "chat-completions": "https://relay.test/chat",
  responses: "https://relay.test/responses",
  anthropic: "https://relay.test/anthropic",
  gemini: "https://relay.test/gemini",
};
const upstream: ModelCatalog = [
  { id: "chat-model", contextWindowTokens: 128000 },
  { id: "claude-wire", contextWindowTokens: 256000, protocols: ["anthropic"] },
  { id: "resp-wire", contextWindowTokens: 256000, protocols: ["responses"] },
];
const source = (): ProviderSource => ({
  id: "relay", label: "Relay", baseUrl: "https://relay.test/v1", model: "chat-model", apiMode: "chat-completions", endpoints,
  modelAliases: { claude: "claude-wire", response: "resp-wire" },
  modelSelection: { mode: "all", overrides: {
    "claude-wire": { apiMode: "anthropic" },
    "resp-wire": { apiMode: "responses" },
    // The selected alias's own protocol wins over its wire model's protocol.
    claude: { apiMode: "responses" },
  } },
});
const credentials = [{
  id: "chat", label: "Chat", enabled: true, type: "api-key" as const, apiKey: "fixture-chat", protocol: "chat-completions" as const,
}, {
  id: "anthropic", label: "Anthropic", enabled: true, type: "api-key" as const, apiKey: "fixture-anthropic", protocol: "anthropic" as const,
}, {
  id: "responses", label: "Responses", enabled: true, type: "api-key" as const, apiKey: "fixture-responses", protocol: "responses" as const,
}];
type Seen = { config: ProviderConfig; model: string };
const capture = (seen: Seen[]): ProviderFactory => config => ({
  listModels: async () => upstream.map(entry => entry.id),
  listModelCatalog: async () => upstream,
  complete: async (_messages, _tools, request) => { seen.push({ config, model: request.model }); return response; },
});
const stub: ModelProvider = {
  listModels: async () => upstream.map(entry => entry.id),
  listModelCatalog: async () => upstream,
  complete: async () => response,
};
async function fixture(factory: ProviderFactory = () => stub) {
  const root = await mkdtemp(join(tmpdir(), "forge-model-protocol-core-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = await openSettingsStore(root);
  const access = createModelAccessService({
    settingsStore: store, catalogStore: await openModelCatalogStore(root), providerFactory: factory, signal: signal(),
  });
  cleanups.push(() => access.dispose());
  await store.update({ source: { type: "save", source: source(), credentials } });
  return { root, store, access, factory };
}
const complete = (provider: ModelProvider, model: string, onAttempt?: (attempt: ProviderAttempt) => void) =>
  provider.complete([{ role: "user", content: "hello" }], [], {
    model, signal: signal(), onText: () => {}, ...(onAttempt ? { onAttempt } : {}),
  });

it("routes direct, alias and inherited models through their own protocol, endpoint and credential", async () => {
  const seen: Seen[] = [];
  const { store, access } = await fixture(capture(seen));
  const attempts: ProviderAttempt[] = [];
  const wire = await access.resolveProvider("relay", undefined, signal(), "claude-wire");
  expect(wire.config).toMatchObject({
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic", apiKey: "fixture-anthropic",
  });
  await complete(wire.provider, "claude-wire", attempt => attempts.push(attempt));
  expect(seen.at(-1)).toMatchObject({ model: "claude-wire", config: {
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic",
  } });

  // Selected alias override wins over the wire model override.
  expect((await access.resolveProvider("relay", undefined, signal(), "claude")).config).toMatchObject({
    apiMode: "responses", baseUrl: endpoints.responses, credentialId: "responses", apiKey: "fixture-responses",
  });
  // Clearing the alias override inherits the wire model's anthropic route.
  await store.update({ source: { type: "save", source: { ...source(), modelSelection: {
    mode: "all", overrides: { "claude-wire": { apiMode: "anthropic" }, "resp-wire": { apiMode: "responses" }, claude: {} },
  } } } });
  expect((await access.resolveProvider("relay", undefined, signal(), "claude")).config).toMatchObject({
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic",
  });
  // Clearing the wire override too inherits the source protocol.
  await store.update({ source: { type: "save", source: { ...source(), modelSelection: {
    mode: "all", overrides: { "claude-wire": {}, "resp-wire": { apiMode: "responses" } },
  } } } });
  expect((await access.resolveProvider("relay", undefined, signal(), "claude")).config).toMatchObject({
    apiMode: "chat-completions", baseUrl: endpoints["chat-completions"], credentialId: "chat",
  });
  // A model without an override does not inherit another model's route.
  expect((await access.resolveProvider("relay", undefined, signal(), "chat-model")).config).toMatchObject({
    apiMode: "chat-completions", baseUrl: endpoints["chat-completions"], credentialId: "chat",
  });
  expect(attempts.map(attempt => [attempt.outcome, attempt.apiMode])).toEqual([["started", "anthropic"], ["succeeded", "anthropic"]]);
});

it("falls back to the source base URL, not the default protocol's resolved endpoint", async () => {
  const { store, access } = await fixture();
  await store.update({ source: { type: "save", source: {
    ...source(), endpoints: { "chat-completions": endpoints["chat-completions"] },
  } } });
  expect((await access.resolveProvider("relay", undefined, signal(), "claude-wire")).config).toMatchObject({
    apiMode: "anthropic", baseUrl: "https://relay.test/v1", credentialId: "anthropic",
  });
  expect((await access.resolveProvider("relay", undefined, signal(), "chat-model")).config.baseUrl).toBe(endpoints["chat-completions"]);
});

it("resolves an unbound provider per request, including protocol-bound credentials", async () => {
  const seen: Seen[] = [];
  const { access } = await fixture(capture(seen));
  const { provider, config } = await access.resolveProvider("relay");
  expect(config).toMatchObject({ apiMode: "chat-completions", baseUrl: endpoints["chat-completions"], credentialId: "chat" });
  const attempts: ProviderAttempt[] = [];
  await complete(provider, "claude-wire", attempt => attempts.push(attempt));
  await complete(provider, "resp-wire");
  await complete(provider, "chat-model");
  expect(seen).toEqual([
    { model: "claude-wire", config: expect.objectContaining({ apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic", apiKey: "fixture-anthropic" }) },
    { model: "resp-wire", config: expect.objectContaining({ apiMode: "responses", baseUrl: endpoints.responses, credentialId: "responses", apiKey: "fixture-responses" }) },
    { model: "chat-model", config: expect.objectContaining({ apiMode: "chat-completions", baseUrl: endpoints["chat-completions"], credentialId: "chat", apiKey: "fixture-chat" }) },
  ]);
  expect(attempts.map(attempt => [attempt.outcome, attempt.apiMode])).toEqual([["started", "anthropic"], ["succeeded", "anthropic"]]);
});

it("returns the full settings catalog only when includeUnselected is requested", async () => {
  const { store, access } = await fixture();
  await store.update({ source: { type: "save", source: { ...source(), modelSelection: {
    mode: "selected", models: ["chat-model"], overrides: {
      "claude-wire": { apiMode: "anthropic", contextWindowTokens: 999_000 }, "resp-wire": { apiMode: "responses" },
    },
  } } } });
  const normal = await access.request({ type: "catalog", sourceId: "relay" });
  if (normal.type !== "catalog") throw new Error("wrong result");
  expect(normal.models.map(entry => entry.id)).toEqual(["chat-model"]);
  const full = await access.request({ type: "catalog", sourceId: "relay", includeUnselected: true });
  if (full.type !== "catalog") throw new Error("wrong result");
  for (const model of upstream) expect(full.models.map(entry => entry.id)).toContain(model.id);
  expect(full.models.find(entry => entry.id === "claude-wire")).toMatchObject({ contextWindowTokens: 999_000 });
  expect(full.models.every(entry => !("apiMode" in entry))).toBe(true);
  // apiMode is request routing, not model-catalog capability metadata.
  expect(modelCatalogEntrySchema.parse({ id: "fixture", contextWindowTokens: 1, apiMode: "anthropic" })).not.toHaveProperty("apiMode");
});

it("keeps stale cache fallback behavior for filtered and unfiltered catalogs", async () => {
  const state = { fail: false };
  const factory: ProviderFactory = () => ({
    listModels: async () => upstream.map(entry => entry.id),
    listModelCatalog: async () => { if (state.fail) throw new Error("catalog unavailable"); return upstream; },
    complete: async () => response,
  });
  const { store, access } = await fixture(factory);
  await store.update({ source: { type: "save", source: { ...source(), modelSelection: {
    mode: "none", overrides: { "claude-wire": { apiMode: "anthropic" }, "resp-wire": { apiMode: "responses" } },
  } } } });
  const warm = await access.request({ type: "catalog", sourceId: "relay" });
  expect(warm).toMatchObject({ type: "catalog", models: [] });
  state.fail = true;
  const filtered = await access.request({ type: "catalog", sourceId: "relay", refresh: true });
  expect(filtered).toMatchObject({ type: "catalog", models: [], stale: true });
  const full = await access.request({ type: "catalog", sourceId: "relay", refresh: true, includeUnselected: true });
  if (full.type !== "catalog") throw new Error("wrong result");
  expect(full.stale).toBe(true);
  for (const model of upstream) expect(full.models.map(entry => entry.id)).toContain(model.id);
});

it("uses the source default model's protocol for inference tests", async () => {
  const seen: Seen[] = [];
  const { store, access } = await fixture(capture(seen));
  await store.update({ source: { type: "save", source: {
    ...source(), model: "claude", modelSelection: { mode: "all", overrides: {
      "claude-wire": { apiMode: "anthropic" }, "resp-wire": { apiMode: "responses" }, claude: {},
    } },
  } } });
  expect(await access.request({ type: "test", sourceId: "relay", kind: "inference" })).toMatchObject({ ok: true, model: "claude" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ model: "claude-wire", config: {
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic", apiKey: "fixture-anthropic",
  } });
  expect(await access.request({ type: "test", sourceId: "relay", kind: "inference", model: "resp-wire" })).toMatchObject({ ok: true });
  expect(seen.at(-1)).toMatchObject({ model: "resp-wire", config: {
    apiMode: "responses", baseUrl: endpoints.responses, credentialId: "responses",
  } });
});

it("catalog checks ignore a supplied model and always use the source protocol", async () => {
  const seen: ProviderConfig[] = [];
  const { access } = await fixture(config => {
    seen.push(config);
    return { listModels: async () => upstream.map(entry => entry.id), listModelCatalog: async () => upstream, complete: async () => response };
  });
  expect(await access.request({ type: "test", sourceId: "relay", kind: "catalog", model: "claude-wire" })).toMatchObject({ ok: true });
  expect(seen[0]).toMatchObject({
    apiMode: "chat-completions", baseUrl: endpoints["chat-completions"], credentialId: "chat", apiKey: "fixture-chat",
  });
});

it("propagates selection validation when an unbound request resolves a protocol model", async () => {
  const validated: (string | undefined)[] = [];
  const { access } = await fixture();
  const { provider } = await access.resolveProvider("relay", undefined, signal(), undefined,
    (_config, _source, model) => { validated.push(model); });
  await complete(provider, "claude-wire");
  expect(validated).toContain("claude-wire");
  expect(validated.at(-1)).toBe("claude-wire");
});

it("keeps the bound provider protocol metadata in sync for runtime permissions", async () => {
  const { access } = await fixture(config => ({
    ...(config.apiMode ? { apiMode: config.apiMode } : {}),
    listModels: async () => upstream.map(entry => entry.id),
    listModelCatalog: async () => upstream,
    complete: async () => response,
  }));
  const responses = await access.resolveProvider("relay", undefined, signal(), "resp-wire");
  expect(responses.config.apiMode).toBe("responses");
  expect(responses.provider.apiMode).toBe("responses");
  const anthropic = await access.resolveProvider("relay", undefined, signal(), "claude-wire");
  expect(anthropic.provider.apiMode).toBe("anthropic");
});

it("validates account model protocols even when an unbound override matches the default mode", async () => {
  const { root, store } = await fixture();
  await store.update({ source: { type: "save", source: {
    ...source(), model: "account-model", modelSelection: { mode: "all", overrides: { "account-model": { apiMode: "chat-completions" } } },
  }, credentials: [{ id: "account", label: "Account", enabled: true, type: "account", account: {
    platform: "copilot", accessToken: "fixture-account-model-protocol",
  } }] } });
  const seen: Seen[] = [];
  const access = createModelAccessService({ settingsStore: store, catalogStore: await openModelCatalogStore(root),
    providerFactory: capture(seen), signal: signal(), accountFetch: async input => {
      const url = String(input);
      const body = url === COPILOT_SESSION_URL
        ? { token: "fixture-session", expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: "https://account.test" } }
        : url === "https://account.test/models"
          ? { data: [{ id: "account-model", capabilities: { type: "chat" }, model_picker_enabled: true, supported_endpoints: ["/responses"] }] }
          : undefined;
      if (!body) throw new Error(`Unexpected fixture URL: ${url}`);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  cleanups.push(() => access.dispose());
  const { provider } = await access.resolveProvider("relay");
  await provider.listModelCatalog!(signal());
  await expect(complete(provider, "account-model")).rejects.toMatchObject({ code: "invalid_input" });
  expect(seen).toEqual([]);
});

it("requires account overrides to match the selected and advertised per-model adapter", () => {
  expect(accountProtocolCompatible(undefined, { apiMode: "chat-completions" })).toBe(true);
  expect(accountProtocolCompatible("chat-completions", { apiMode: "chat-completions" })).toBe(true);
  expect(accountProtocolCompatible("responses", { apiMode: "responses", protocols: ["responses"] })).toBe(true);
  // Same default mode is not enough when the account advertised another adapter for this model.
  expect(accountProtocolCompatible("chat-completions", { apiMode: "chat-completions", protocols: ["responses"] })).toBe(false);
  expect(accountProtocolCompatible("anthropic", { apiMode: "chat-completions" })).toBe(false);
});

it("prepares route members with their own effective protocols", async () => {
  const { access } = await fixture();
  const homogeneous = await access.prepareRoute({ id: "pool", label: "Pool", strategy: "order",
    members: [{ sourceId: "relay", model: "claude" }, { sourceId: "relay", model: "resp-wire" }] }, signal());
  expect(homogeneous.apiMode).toBe("responses");
  expect(homogeneous.mayUseWebSearch).toBe(true);
  const mixed = await access.prepareRoute({ id: "mixed", label: "Mixed", strategy: "order",
    members: [{ sourceId: "relay", model: "claude-wire" }, { sourceId: "relay", model: "resp-wire" }] }, signal());
  expect(mixed).not.toHaveProperty("apiMode");
  expect(mixed.base.config).toMatchObject({ apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic" });
  expect(mixed.mayUseWebSearch).toBe(true);
});
