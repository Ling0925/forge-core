import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureInputSchema, type ProviderSource } from "../../src/shared/schemas";
import { openSettingsStore } from "../../src/store/settings";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const endpoints = {
  "chat-completions": "https://relay.test/chat",
  responses: "https://relay.test/responses",
  anthropic: "https://relay.test/anthropic",
  gemini: "https://relay.test/gemini",
};
const source = (id = "relay"): ProviderSource => ({
  id, label: id, baseUrl: "https://relay.test/v1", model: "chat-model", apiMode: "chat-completions",
  endpoints,
});
const keys = () => [{
  id: "chat", label: "Chat", enabled: true, type: "api-key" as const, apiKey: "fixture-chat", protocol: "chat-completions" as const,
}, {
  id: "anthropic", label: "Anthropic", enabled: true, type: "api-key" as const, apiKey: "fixture-anthropic", protocol: "anthropic" as const,
}, {
  id: "responses", label: "Responses", enabled: true, type: "api-key" as const, apiKey: "fixture-responses", protocol: "responses" as const,
}];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-model-protocol-store-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, store: await openSettingsStore(root) };
}

it("persists per-model protocol, uses its endpoint and protocol-bound credential, and clears back to inheritance", async () => {
  const { root, store } = await fixture();
  const base = source();
  await store.update({
    source: {
      type: "save",
      source: {
        ...base, modelAliases: { claude: "claude-wire" },
        modelSelection: { mode: "all", overrides: { "claude-wire": { apiMode: "anthropic", reasoningEffort: "low" } } },
      },
      credentials: keys(),
    },
  });
  expect((await store.getPublic()).providerSources?.[0]?.modelSelection?.overrides?.["claude-wire"])
    .toEqual({ apiMode: "anthropic", reasoningEffort: "low" });
  expect(await store.getProviderConfig("relay", undefined, "claude-wire")).toMatchObject({
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic", apiKey: "fixture-anthropic",
  });
  expect(await store.getProviderConfig("relay", undefined, "claude")).toMatchObject({
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic",
  });
  // The source default route is unchanged when no model is supplied.
  expect(await store.getProviderConfig("relay")).toMatchObject({
    apiMode: "chat-completions", baseUrl: endpoints["chat-completions"], credentialId: "chat", apiKey: "fixture-chat",
  });

  const reopened = await openSettingsStore(root);
  expect((await reopened.getPublic()).providerSources?.[0]?.modelSelection?.overrides?.["claude-wire"]?.apiMode).toBe("anthropic");
  expect(await reopened.getProviderConfig("relay", undefined, "claude-wire")).toMatchObject({
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic",
  });

  // Deleting only apiMode restores inheritance from the source.
  await reopened.update({ source: { type: "save", source: {
    ...base, modelAliases: { claude: "claude-wire" }, modelSelection: { mode: "all", overrides: { "claude-wire": { reasoningEffort: "low" } } },
  } } });
  expect(await reopened.getProviderConfig("relay", undefined, "claude-wire")).toMatchObject({
    apiMode: "chat-completions", baseUrl: endpoints["chat-completions"], credentialId: "chat",
  });
});

it("rejects explicit and active credential mismatches instead of silently switching credentials", async () => {
  const { store } = await fixture();
  await store.update({ source: { type: "save", source: {
    ...source(), activeCredentialId: "chat",
    modelSelection: { mode: "all", overrides: { "claude-wire": { apiMode: "anthropic" }, "resp-wire": { apiMode: "responses" } } },
  }, credentials: keys() } });
  // activeCredentialId wins before auto-selection, and a protocol mismatch fails.
  await expect(store.getProviderConfig("relay", undefined, "claude-wire")).rejects.toThrow("凭据与所选协议不匹配");
  await expect(store.getProviderConfig("relay", "chat", "claude-wire")).rejects.toThrow("凭据与所选协议不匹配");
  await store.update({ source: { type: "save", source: {
    ...source(), activeCredentialId: undefined,
    modelSelection: { mode: "all", overrides: { "claude-wire": { apiMode: "anthropic" }, "resp-wire": { apiMode: "responses" } } },
  } } });
  expect(await store.getProviderConfig("relay", undefined, "claude-wire")).toMatchObject({ credentialId: "anthropic" });
  expect(await store.getProviderConfig("relay", undefined, "resp-wire")).toMatchObject({ credentialId: "responses" });
});

it("uses the model protocol when refreshing an account credential", async () => {
  const { store } = await fixture();
  const expired = { platform: "copilot" as const, accessToken: "fixture-old", expiresAt: 1 };
  await store.update({ source: { type: "save", source: {
    ...source(),
    modelSelection: { mode: "all", overrides: { "claude-wire": { apiMode: "anthropic" } } },
  }, credentials: [
    { id: "chat", label: "Chat", enabled: true, type: "api-key", apiKey: "fixture-chat", protocol: "chat-completions" },
    { id: "acct", label: "Account", enabled: true, type: "account", protocol: "anthropic", account: expired },
  ], } });
  expect(await store.getProviderConfig("relay", "acct", "claude-wire")).toMatchObject({
    apiMode: "anthropic", credentialId: "acct", apiKey: "fixture-old",
  });
  await expect(store.getProviderConfig("relay", "acct")).rejects.toThrow("凭据与所选协议不匹配");
  const refreshed = await store.refreshAccount!("relay", "acct", async tokens => ({
    ...tokens, accessToken: "fixture-new", expiresAt: Date.now() + 3_600_000,
  }), "claude-wire");
  expect(refreshed).toMatchObject({ apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "acct", apiKey: "fixture-new" });
  await expect(store.refreshAccount!("relay", "acct", async tokens => tokens)).rejects.toThrow("凭据与所选协议不匹配");
});

it("keeps apiMode omitted for sources without an explicit protocol", async () => {
  const { store } = await fixture();
  const { apiMode: _apiMode, ...legacy } = source();
  await store.update({ source: { type: "save", source: { ...legacy, endpoints }, credentials: keys() } });
  const plain = await store.getProviderConfig("relay");
  expect(plain).not.toHaveProperty("apiMode");
  expect(plain).toMatchObject({ baseUrl: endpoints["chat-completions"], credentialId: "chat", apiKey: "fixture-chat" });
  expect((await store.getProviderSnapshot?.("relay"))?.config).not.toHaveProperty("apiMode");
  await store.update({ source: { type: "save", source: { ...legacy, endpoints, modelSelection: {
    mode: "all", overrides: { "claude-wire": { apiMode: "anthropic" } },
  } } } });
  expect(await store.getProviderConfig("relay", undefined, "claude-wire")).toMatchObject({
    apiMode: "anthropic", baseUrl: endpoints.anthropic, credentialId: "anthropic",
  });
  expect(await store.getProviderConfig("relay")).not.toHaveProperty("apiMode");
});

it("refuses to override Vertex and Codex-only protocols and validates the public schema", async () => {
  const { store } = await fixture();
  await store.update({ source: { type: "save", source: {
    ...source("vertex"), apiMode: "gemini",
    modelSelection: { mode: "all", overrides: { "claude-wire": { apiMode: "anthropic" } } },
  }, connection: { vertex: { project: "fixture-project", credentials: { type: "authorized_user" } } }, apiKey: "fixture-vertex" } });
  await expect(store.getProviderConfig("vertex", undefined, "claude-wire")).rejects.toThrow("Vertex 来源固定使用 gemini 协议");

  await store.update({ source: { type: "save", source: {
    ...source("codex"), apiMode: "responses",
    modelSelection: { mode: "all", overrides: { "claude-wire": { apiMode: "anthropic" } } },
  }, credentials: [{
    id: "acct", label: "Codex", enabled: true, type: "account",
    account: { platform: "codex", accessToken: "fixture-codex" },
  }], } });
  await expect(store.getProviderConfig("codex", undefined, "claude-wire")).rejects.toThrow("Codex 账号固定使用 responses 协议");

  expect(configureInputSchema.safeParse({ source: { type: "save", source: {
    ...source(), modelSelection: { mode: "all", overrides: { model: { apiMode: "not-a-protocol" } } },
  } } }).success).toBe(false);
});
