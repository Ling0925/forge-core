import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { ForgeError } from "../../src/shared/errors";
import type { HarnessService, ModelProvider, ProviderFactory } from "../../src/shared/contracts";
import { ProviderError } from "../../src/provider/errors";
import { openSessionStore } from "../../src/store/sessions";

const roots: string[] = [];
const services: HarnessService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.unstubAllGlobals(); });
const source = (id = "local") => ({ id, label: id, baseUrl: `http://${id}.test/v1`, apiMode: "chat-completions" as const, model: "org/model/v1" });
const response = { message: { role: "assistant" as const, content: "OK" } };
const provider = (complete: ModelProvider["complete"] = async () => response): ModelProvider => ({ listModels: async () => ["org/model/v1", "other"], listModelCatalog: async () => [{ id: "org/model/v1", contextWindowTokens: 8192, vision: false }, { id: "other", contextWindowTokens: null }], complete });
async function fixture(factory: ProviderFactory = () => provider()) {
  const root = await mkdtemp(join(tmpdir(), "forge-access-service-")); roots.push(root);
  const service = await createHarness({ stateDir: join(root, "home"), providerFactory: factory, toolFactory: async () => ({ definitions: [], execute: async () => ({ content: "", isError: false }), dispose: async () => {} }) });
  services.push(service);
  await service.updateSettings({ source: { type: "save", source: source(), apiKey: "" } });
  return { service, root };
}
it("compacts routed history with an available exact member without changing the logical binding", async () => {
  const seen: string[] = [];
  const { service, root } = await fixture(config => provider(async (_messages, _tools, options) => {
    seen.push(`${config.sourceId}:${options.model}`);
    return response;
  }));
  await service.updateSettings({ sources: [
    { type: "save", source: { ...source("offline"), model: "offline-model" }, credentials: [{ id: "off", label: "Off", type: "api-key", enabled: false, apiKey: "" }] },
    { type: "save", source: { ...source("live"), model: "live-model" }, apiKey: "" },
  ], route: { type: "save", group: { id: "compact-group", label: "Compact", strategy: "order", members: [
    { sourceId: "offline", model: "offline-model" }, { sourceId: "live", model: "live-model" },
  ] } } });
  const session = await service.createSession({ workspace: root, title: "Manual", routeGroupId: "compact-group" });
  const store = await openSessionStore(join(root, "home"));
  await store.save({ ...session, messages: Array.from({ length: 12 }, (_, index) => index % 2
    ? { role: "assistant" as const, content: `Completed task ${index}.` }
    : { role: "user" as const, content: `Remember task ${index}.` }) });
  const compacted = await service.compactSession(session.id);
  expect(seen).toEqual(["live:live-model"]);
  expect(compacted.contextSummary).toBeDefined();
  expect(compacted.model).toBe("offline-model");
  expect(compacted.routeGroupId).toBe("compact-group");
});
it("shares exact IDs and overrides with old discovery while preserving all/none/selected", async () => {
  const { service } = await fixture();
  await service.updateSettings({ source: { type: "save", source: { ...source(), modelSelection: { mode: "selected", models: ["org/model/v1", "manual/a"], manual: [{ id: "manual/a", contextWindowTokens: null }], overrides: { "org/model/v1": { vision: true, contextWindowTokens: 12000 } } } } } });
  expect(await service.listModels(undefined, "local")).toEqual(["org/model/v1", "manual/a"]);
  const catalog = await service.modelAccess!({ type: "catalog", sourceId: "local" });
  expect(catalog).toMatchObject({ type: "catalog", models: [{ id: "org/model/v1", contextWindowTokens: 12000, vision: true, provenance: { vision: "user" } }, { id: "manual/a" }] });
  expect(await service.getModelContextWindow!("org/model/v1", undefined, "local")).toBe(12000);
  await service.updateSettings({ source: { type: "save", source: { ...source(), modelSelection: { mode: "none" } } } });
  expect(await service.listModels(undefined, "local", true)).toEqual([]);
});
it("does not infer during setup, separates catalog tests from inference and hides upstream errors", async () => {
  const complete = vi.fn<ModelProvider["complete"]>(async () => { throw new Error("fixture-private-key-and-body"); });
  const { service } = await fixture(() => provider(complete));
  await service.modelAccess!({ type: "presets" });
  const catalog = await service.modelAccess!({ type: "test", sourceId: "local", kind: "catalog" });
  expect(catalog).toMatchObject({ type: "test", ok: true, kind: "catalog" });
  expect(complete).not.toHaveBeenCalled();
  const inference = await service.modelAccess!({ type: "test", sourceId: "local", kind: "inference" });
  expect(inference).toMatchObject({ type: "test", ok: false, kind: "inference" });
  expect(JSON.stringify(inference)).not.toContain("fixture-private");
  expect(complete).toHaveBeenCalledTimes(1);
});
it("cancels only the named explicit inference test without retry", async () => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  const complete = vi.fn<ModelProvider["complete"]>(async (_messages, _tools, { signal }) => new Promise((_resolve, reject) => {
    entered(); signal.addEventListener("abort", () => reject(new ForgeError("cancelled", "cancelled")), { once: true });
  }));
  const { service } = await fixture(() => provider(complete));
  const requestId = "test-cancel";
  const pending = service.modelAccess!({ type: "test", sourceId: "local", kind: "inference", requestId });
  const rejection = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await ready;
  expect(await service.modelAccess!({ type: "cancel", requestId })).toEqual({ type: "cancel", cancelled: true });
  await rejection;
  expect(complete).toHaveBeenCalledTimes(1);
});
it("keeps imported secrets host-side and writes only after an explicit selected apply", async () => {
  const { service } = await fixture();
  const preview = await service.modelAccess!({ type: "import-preview", text: JSON.stringify({ id: "imported", name: "Imported", chat: "http://imported.test/v1", keys: ["fixture-import-private"], models: ["org/imported"] }) });
  expect(preview.type).toBe("import-preview");
  if (preview.type !== "import-preview") throw new Error("wrong result");
  expect(preview.sources.map(item => item.id)).toEqual(["imported"]);
  expect(JSON.stringify(preview)).not.toContain("fixture-import-private");
  expect((await service.getSettings()).providerSources).toHaveLength(1);
  expect(await service.modelAccess!({ type: "import-apply", previewId: preview.previewId, sourceIds: ["imported"] })).toEqual({ type: "import-apply", applied: ["imported"] });
  expect((await service.getSettings()).providerSources).toHaveLength(2);
  await expect(service.modelAccess!({ type: "import-apply", previewId: preview.previewId, sourceIds: ["imported"] })).rejects.toMatchObject({ code: "not_found" });
});
it("persists explicit groups, reports real candidates and clears a group on a direct selection", async () => {
  const calls: string[] = [];
  const { service, root } = await fixture(config => provider(async (_messages, _tools, options) => {
    calls.push(`${config.sourceId}:${options.model}`);
    if (config.sourceId === "first") throw new ProviderError("http", "rate limited", true, 429);
    return response;
  }));
  await service.updateSettings({ sources: ["first", "second"].map(id => ({ type: "save" as const, source: source(id), apiKey: "" })), route: { type: "save", group: { id: "fallback", label: "Fallback", strategy: "order", members: [{ sourceId: "first", model: "org/model/v1" }, { sourceId: "second", model: "other" }] } } });
  const session = await service.createSession({ workspace: root, title: "Fixture", routeGroupId: "fallback" });
  expect(session.routeGroupId).toBe("fallback");
  const result = await service.run({ sessionId: session.id, prompt: "go", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(calls).toEqual(["first:org/model/v1", "second:other"]);
  expect(result.routeGroupId).toBe("fallback");
  expect(result.events.filter(event => event.type === "provider_attempt" && event.selection.outcome === "succeeded")).toMatchObject([{ selection: { sourceId: "second", model: "other", groupId: "fallback" } }]);
  const direct = await service.run({ sessionId: session.id, prompt: "direct", model: "org/model/v1", providerSourceId: "second", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
  expect(direct.routeGroupId).toBeUndefined();
  expect(calls.at(-1)).toBe("second:org/model/v1");
});
it("keeps the last catalog with an explicit stale error when a refresh fails", async () => {
  let fail = false;
  const { service } = await fixture(() => ({ ...provider(), listModelCatalog: async () => {
    if (fail) throw new Error("private-upstream-body");
    return [{ id: "org/model/v1", contextWindowTokens: 4096 }];
  } }));
  await service.modelAccess!({ type: "catalog", sourceId: "local" });
  fail = true;
  const result = await service.modelAccess!({ type: "catalog", sourceId: "local", refresh: true });
  expect(result).toMatchObject({ type: "catalog", stale: true, models: [{ id: "org/model/v1", contextWindowTokens: 4096 }], error: expect.any(String), fetchedAt: expect.any(String) });
  expect(JSON.stringify(result)).not.toContain("private-upstream-body");
});

it("skips a disabled first credential before preparing the explicit group", async () => {
  const calls: string[] = [];
  const { service, root } = await fixture(config => provider(async () => { calls.push(config.credentialId!); return response; }));
  await service.updateSettings({ source: { type: "save", source: source(), credentials: [
    { id: "disabled", label: "Disabled", enabled: false, type: "api-key", apiKey: "fixture-disabled" },
    { id: "enabled", label: "Enabled", enabled: true, type: "api-key", apiKey: "fixture-enabled" },
  ] }, route: { type: "save", group: { id: "pool", label: "Pool", strategy: "order", members: [
    { sourceId: "local", model: "org/model/v1", credentialId: "disabled" },
    { sourceId: "local", model: "org/model/v1", credentialId: "enabled" },
  ] } } });
  const session = await service.createSession({ workspace: root, title: "Fixture", routeGroupId: "pool" });
  const result = await service.run({ sessionId: session.id, prompt: "go", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(calls).toEqual(["enabled"]);
});

it("records the real aliased wire model and selected default credential", async () => {
  const calls: string[] = [];
  const { service, root } = await fixture(() => provider(async (_messages, _tools, request) => { calls.push(request.model); return response; }));
  await service.updateSettings({ source: { type: "save", source: { ...source(), modelAliases: { alias: "org/wire/model" } }, credentials: [{ id: "key-one", label: "Key", type: "api-key", enabled: true, apiKey: "fixture-key" }] }, route: { type: "save", group: { id: "alias-pool", label: "Alias", strategy: "order", members: [{ sourceId: "local", model: "alias" }] } } });
  const session = await service.createSession({ workspace: root, title: "Fixture", routeGroupId: "alias-pool" });
  const result = await service.run({ sessionId: session.id, prompt: "go", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(calls).toEqual(["org/wire/model"]);
  expect(result.events.filter(event => event.type === "provider_attempt" && event.selection.outcome === "succeeded")).toMatchObject([{ selection: { sourceId: "local", model: "org/wire/model", credentialId: "key-one", groupId: "alias-pool" } }]);
  const usage = await service.getUsageStats!();
  expect(usage.routes).toMatchObject([{ model: "org/wire/model", credentialId: "key-one", attempts: 1, succeeded: 1, unknownUsage: 1 }]);
});
it.each([false, true])("persists attempt-time reasoning effort across setting changes (routed=%s)", async routed => {
  let fail = false;
  const configured: (string | undefined)[] = [];
  const { service, root } = await fixture(config => provider(async () => {
    configured.push(config.reasoningEffort);
    if (fail) throw new ProviderError("http", "fixture rejected", false, 400);
    return response;
  }));
  if (routed) await service.updateSettings({ route: { type: "save", group: {
    id: "effort-pool", label: "Effort", strategy: "order", members: [{ sourceId: "local", model: "org/model/v1" }],
  } } });
  const session = await service.createSession({ workspace: root, title: "Effort fixture",
    ...(routed ? { routeGroupId: "effort-pool" } : { providerSourceId: "local" }),
  });
  for (const effort of [undefined, "xhigh", "none"] as const) {
    if (effort !== undefined) await service.updateSettings({ settings: { reasoningEffort: effort } });
    fail = effort === "none";
    const result = await service.run({ sessionId: session.id, prompt: "go", permission: "readonly" },
      () => {}, async () => false, new AbortController().signal);
    expect(result.status).toBe(fail ? "failed" : "completed");
    const attempts = result.events.filter(event => event.type === "provider_attempt");
    expect(attempts.slice(-2).map(event => event.selection.reasoningEffort)).toEqual([effort ?? "default", effort ?? "default"]);
  }
  expect(configured).toEqual([undefined, "xhigh", "none"]);
  const store = await openSessionStore(join(root, "home"));
  const persisted = await store.get(session.id);
  expect(persisted.events.filter(event => event.type === "provider_attempt").map(event => event.selection.reasoningEffort))
    .toEqual(["default", "default", "xhigh", "xhigh", "none", "none"]);
  const stats = await service.getUsageStats!();
  expect(stats.requests).toHaveLength(3);
  expect(stats.requests?.map(request => request.reasoningEffort).sort()).toEqual(["default", "none", "xhigh"]);
});

it("keeps Vertex discovery offline and mints a cached bearer token only for explicit inference", async () => {
  const tokenFetch = vi.fn<typeof fetch>(async () => Response.json({ access_token: "fixture-cloud-token", expires_in: 3600 }));
  vi.stubGlobal("fetch", tokenFetch);
  const configurations: Parameters<ProviderFactory>[0][] = [];
  const { service } = await fixture(config => { configurations.push(config); return provider(); });
  await service.updateSettings({ source: { type: "save", source: { ...source(), apiMode: "gemini", model: "gemini-2.5-flash", preset: "google-vertex" }, connection: { vertex: { project: "fixture-project", location: "global", credentials: { type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-private-client", refresh_token: "fixture-private-refresh" } } } } });
  configurations.length = 0;
  const catalog = await service.modelAccess!({ type: "catalog", sourceId: "local" });
  expect(catalog).toMatchObject({ type: "catalog", models: expect.arrayContaining([{ id: "gemini-2.5-flash", contextWindowTokens: null, provenance: { id: "reference" } }]) });
  expect(tokenFetch).not.toHaveBeenCalled();
  expect(configurations).toHaveLength(0);
  for (let i = 0; i < 2; i++) expect(await service.modelAccess!({ type: "test", sourceId: "local", kind: "inference" })).toMatchObject({ ok: true });
  expect(tokenFetch).toHaveBeenCalledTimes(1);
  expect(configurations).toHaveLength(2);
  expect(configurations[0]).toMatchObject({ apiMode: "gemini", apiKey: "fixture-cloud-token", auth: { type: "bearer" }, maxOutputTokens: 64, baseUrl: "https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google" });
  expect(JSON.stringify(await service.getSettings())).not.toMatch(/fixture-(cloud-token|private)/);
});

it("uses Azure v1 deployment names and Bedrock bearer auth with an offline reference catalog", async () => {
  const configurations: Parameters<ProviderFactory>[0][] = [];
  const listed = vi.fn(async () => []);
  const { service } = await fixture(config => { configurations.push(config); return { ...provider(), listModelCatalog: listed }; });
  await service.updateSettings({ source: { type: "save", source: { ...source(), preset: "azure", baseUrl: "https://fixture.openai.azure.com", apiMode: "responses", model: "Exact/Deployment" }, apiKey: "fixture-key" } });
  expect(await service.modelAccess!({ type: "test", sourceId: "local", kind: "inference" })).toMatchObject({ ok: true });
  expect(configurations.at(-1)).toMatchObject({ baseUrl: "https://fixture.openai.azure.com/openai/v1", auth: { type: "header", header: "api-key" } });
  await service.updateSettings({ source: { type: "save", source: { ...source(), preset: "bedrock", apiMode: "anthropic", model: "global.anthropic.claude-sonnet-5" }, apiKey: "fixture-bedrock-key" } });
  const catalog = await service.modelAccess!({ type: "catalog", sourceId: "local", refresh: true });
  expect(catalog).toMatchObject({ type: "catalog", models: expect.arrayContaining([expect.objectContaining({ id: "global.anthropic.claude-sonnet-5", protocols: ["anthropic"], provenance: { id: "reference", protocols: "reference" } })]) });
  expect(listed).not.toHaveBeenCalled();
  expect(configurations.at(-1)).toMatchObject({ auth: { type: "bearer" } });
});

it("excludes an explicitly incompatible protocol even when the model is hidden from discovery", async () => {
  const calls: string[] = [];
  const { service, root } = await fixture(config => provider(async () => { calls.push(config.sourceId!); return response; }));
  await service.updateSettings({ sources: [
    { type: "save", source: { ...source(), modelSelection: { mode: "none", overrides: { "org/model/v1": { protocols: ["anthropic"] } } } } },
    { type: "save", source: source("other"), apiKey: "" },
  ], route: { type: "save", group: { id: "protocol-pool", label: "Pool", strategy: "order", members: [{ sourceId: "local", model: "org/model/v1" }, { sourceId: "other", model: "org/model/v1" }] } } });
  const session = await service.createSession({ workspace: root, title: "Fixture", routeGroupId: "protocol-pool" });
  const result = await service.run({ sessionId: session.id, prompt: "go", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(calls).toEqual(["other"]);
});
