import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createModelAccessService } from "../../src/core/model-access";
import { ProviderError } from "../../src/provider/errors";
import { createModelProvider } from "../../src/provider/openai";
import type { ModelProvider, ProviderFactory } from "../../src/shared/contracts";
import type { ProviderAttempt } from "../../src/shared/model-access";
import type { ModelCatalog } from "../../src/shared/model-catalog";
import { configureInputSchema, type ProviderConfig, type ProviderSource } from "../../src/shared/schemas";
import { openModelCatalogStore } from "../../src/store/model-catalog";
import { openSessionStore } from "../../src/store/sessions";
import { openSettingsStore } from "../../src/store/settings";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
const source = (id = "local"): ProviderSource => ({ id, label: id, baseUrl: `http://${id}.test/v1`, model: "org/model/v1", apiMode: "chat-completions" });
const response = { message: { role: "assistant" as const, content: "OK" } };
const upstream: ModelCatalog = [{ id: "org/model/v1", contextWindowTokens: 128000, maxOutputTokens: 4096, reasoningEfforts: ["low", "high"] }];
const stub = (complete: ModelProvider["complete"] = async () => response): ModelProvider => ({
  listModels: async () => upstream.map(entry => entry.id), listModelCatalog: async () => upstream, complete,
});
async function fixture(providerFactory: ProviderFactory = () => stub()) {
  const root = await mkdtemp(join(tmpdir(), "forge-model-overrides-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const settingsStore = await openSettingsStore(home);
  const access = createModelAccessService({ settingsStore, catalogStore: await openModelCatalogStore(home), providerFactory, signal: signal() });
  cleanups.push(() => access.dispose());
  await settingsStore.update({ source: { type: "save", source: source(), apiKey: "" } });
  return { root, home, access, settingsStore, providerFactory };
}
const complete = (provider: ModelProvider, model = "org/model/v1", onAttempt?: (attempt: ProviderAttempt) => void) =>
  provider.complete([{ role: "user", content: "hello" }], [], { model, signal: signal(), onText: () => {}, ...(onAttempt ? { onAttempt } : {}) });

it("round-trips all four Web overrides through validation, persistence and public catalogs, including reset", async () => {
  const { home, settingsStore, access } = await fixture();
  const override = { reasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"], contextWindowTokens: 256000, maxOutputTokens: 16384 };
  await settingsStore.update(configureInputSchema.parse({ source: { type: "save", source: {
    ...source(), modelSelection: { mode: "all", overrides: { "org/model/v1": override } },
  } } }));
  const reopened = await openSettingsStore(home);
  expect((await reopened.getPublic()).providerSources?.[0]?.modelSelection?.overrides?.["org/model/v1"]).toEqual(override);
  expect(await access.request({ type: "catalog", sourceId: "local" })).toMatchObject({ models: [{
    id: "org/model/v1", ...override, provenance: {
      reasoningEffort: "user", reasoningEfforts: "user", contextWindowTokens: "user", maxOutputTokens: "user",
    },
  }] });
  await reopened.update({ source: { type: "save", source: {
    ...source(), modelSelection: { mode: "all", overrides: { "org/model/v1": { contextWindowTokens: null, maxOutputTokens: null, reasoningEfforts: [] } } },
  } } });
  const catalog = await access.request({ type: "catalog", sourceId: "local" });
  expect(catalog).toMatchObject({ models: [{ ...upstream[0], provenance: {
    contextWindowTokens: "upstream", maxOutputTokens: "upstream", reasoningEfforts: "upstream",
  } }] });
  if (catalog.type !== "catalog") throw new Error("wrong result");
  expect(catalog.models[0]).not.toHaveProperty("reasoningEffort");
});

it.each(["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const)("applies model effort %s and output cap without mutating globals or treating capabilities as request defaults", async reasoningEffort => {
  const seen: ProviderConfig[] = [];
  const { settingsStore, access } = await fixture(config => stub(async () => { seen.push(config); return response; }));
  await settingsStore.update({ settings: { reasoningEffort: "high", maxOutputTokens: 32768 } });
  await settingsStore.update({ source: { type: "save", source: {
    ...source(), modelSelection: { mode: "all", overrides: { "org/model/v1": { reasoningEffort, maxOutputTokens: 16384, reasoningEfforts: ["low", "medium"] } } },
  } } });
  const resolved = await access.resolveProvider("local", undefined, signal(), "org/model/v1");
  expect(resolved.config).toMatchObject({ reasoningEffort, maxOutputTokens: 16384 });
  const attempts: ProviderAttempt[] = [];
  await complete(resolved.provider, undefined, attempt => attempts.push(attempt));
  expect(seen[0]).toMatchObject({ reasoningEffort, maxOutputTokens: 16384 });
  expect(attempts.map(attempt => [attempt.outcome, attempt.reasoningEffort])).toEqual([["started", reasoningEffort], ["succeeded", reasoningEffort]]);
  expect(seen[0]).not.toHaveProperty("reasoningEfforts");
  expect((await settingsStore.getProviderConfig("local"))).toMatchObject({ reasoningEffort: "high", maxOutputTokens: 32768 });
  await settingsStore.update({ source: { type: "save", source: {
    ...source(), modelSelection: { mode: "all", overrides: { "org/model/v1": { maxOutputTokens: null, reasoningEfforts: ["low"] } } },
  } } });
  await complete((await access.resolveProvider("local", undefined, signal(), "org/model/v1")).provider);
  expect(seen[1]).toMatchObject({ reasoningEffort: "high", maxOutputTokens: 32768 });
});

it("resolves an unbound provider per request and does not leak overrides across models", async () => {
  const seen: { model: string; effort: unknown; output: unknown }[] = [];
  const listed = vi.fn(async () => { throw new Error("catalog unavailable"); });
  const { settingsStore, access } = await fixture(config => ({ ...stub(async (_messages, _tools, request) => {
    seen.push({ model: request.model, effort: config.reasoningEffort, output: config.maxOutputTokens }); return response;
  }), listModelCatalog: listed }));
  await settingsStore.update({ settings: { reasoningEffort: "high" } });
  await settingsStore.update({ source: { type: "save", source: {
    ...source(), modelAliases: { alias: "wire" }, modelSelection: { mode: "none", overrides: { wire: { reasoningEffort: "none", maxOutputTokens: 16384 }, other: { reasoningEffort: "default" } } },
  } } });
  const { provider, config } = await access.resolveProvider("local");
  const attempts: ProviderAttempt[] = [];
  for (const model of ["alias", "other", "unconfigured", "alias"]) await complete(provider, model, attempt => attempts.push(attempt));
  expect(seen).toEqual([
    { model: "wire", effort: "none", output: 16384 }, { model: "other", effort: "default", output: undefined },
    { model: "unconfigured", effort: "high", output: undefined }, { model: "wire", effort: "none", output: 16384 },
  ]);
  expect(attempts.filter(attempt => attempt.outcome === "succeeded").map(attempt => attempt.reasoningEffort)).toEqual(["none", "default", "high", "none"]);
  expect(config.reasoningEffort).toBe("high");
  expect(listed).not.toHaveBeenCalled();
});

it.each(["all", "none", "selected"] as const)("uses offline alias/window overrides independently of discovery mode %s", async mode => {
  const listed = vi.fn(async () => { throw new Error("catalog unavailable"); });
  const { settingsStore, access } = await fixture(() => ({ ...stub(), listModelCatalog: listed }));
  await settingsStore.update({ source: { type: "save", source: {
    ...source(), modelAliases: { alias: "org/model/v1", inherited: "org/model/v1" }, modelSelection: { mode, models: [], overrides: {
      "org/model/v1": { contextWindowTokens: 256000, maxOutputTokens: 16384, reasoningEffort: "low" },
      alias: { contextWindowTokens: 200000, reasoningEffort: "default" }, inherited: { reasoningEfforts: ["low"] },
    } },
  } } });
  const alias = await access.resolveProvider("local", undefined, signal(), "alias");
  expect(alias.actualModel).toBe("org/model/v1");
  expect(alias.config).toMatchObject({ reasoningEffort: "default", maxOutputTokens: 16384 });
  expect(await alias.provider.getModelContextWindow!("alias")).toBe(200000);
  expect(await alias.provider.getModelContextWindow!("org/model/v1")).toBe(200000);
  const inherited = await access.resolveProvider("local", undefined, signal(), "inherited");
  expect(inherited.config).toMatchObject({ reasoningEffort: "low", maxOutputTokens: 16384 });
  expect(await inherited.provider.getModelContextWindow!("inherited")).toBe(256000);
  expect(listed).not.toHaveBeenCalled();
  const prepared = await access.prepareRoute({ id: "pool", label: "Pool", strategy: "order", members: [{ sourceId: "local", model: "alias" }] }, signal());
  expect(prepared.contextWindow).toBe(200000);
});

it("resolves an alias's upstream window and preserves independent host lookups with partial overrides", async () => {
  const { settingsStore, access, home } = await fixture();
  await settingsStore.update({ source: { type: "save", source: {
    ...source(), modelAliases: { alias: "org/model/v1" }, modelSelection: { mode: "none", overrides: { alias: { reasoningEffort: "low", contextWindowTokens: null } } },
  } } });
  const { provider } = await access.resolveProvider("local", undefined, signal(), "alias");
  expect(await provider.listModels()).toEqual([]);
  expect(await provider.getModelContextWindow!("alias")).toBe(128000);
  const getWindow = vi.fn(async () => 512000);
  const injected = createModelAccessService({ settingsStore, catalogStore: await openModelCatalogStore(home), signal: signal(),
    providerFactory: () => ({ listModels: async () => [], getModelContextWindow: getWindow, complete: async () => response }),
  });
  cleanups.push(() => injected.dispose());
  const resolved = await injected.resolveProvider("local", undefined, signal(), "alias");
  expect(await resolved.provider.getModelContextWindow!("alias")).toBe(512000);
  expect(getWindow).toHaveBeenCalledWith("org/model/v1", undefined);
});

it.each([false, true])("uses source-specific overrides and records effective attempts through the harness (routed=%s)", async routed => {
  const seen: { source: unknown; effort: unknown; output: unknown }[] = [];
  const f = await fixture(config => stub(async () => {
    seen.push({ source: config.sourceId, effort: config.reasoningEffort, output: config.maxOutputTokens });
    if (routed && config.sourceId === "local") throw new ProviderError("http", "rate limited", true, 429);
    return response;
  }));
  const service = await createHarness({ stateDir: f.home, providerFactory: f.providerFactory,
    toolFactory: () => ({ definitions: [], execute: async () => ({ content: "", isError: false }), dispose: async () => {} }),
  });
  cleanups.push(() => service.dispose());
  await service.updateSettings({ settings: { reasoningEffort: "max", maxOutputTokens: 32768 } });
  await service.updateSettings({ sources: [
    { type: "save", source: { ...source(), modelSelection: { mode: "none", overrides: { "org/model/v1": { reasoningEffort: "low", maxOutputTokens: 16384, contextWindowTokens: 256000 } } } } },
    { type: "save", source: { ...source("other"), modelSelection: { mode: "none", overrides: { "org/model/v1": { reasoningEffort: "none", maxOutputTokens: 8192, contextWindowTokens: 128000 } } } }, apiKey: "" },
  ], route: { type: "save", group: { id: "pool", label: "Pool", strategy: "order", members: [{ sourceId: "local", model: "org/model/v1" }, { sourceId: "other", model: "org/model/v1" }] } } });
  const session = await service.createSession({ workspace: f.root, title: "Override fixture", ...(routed ? { routeGroupId: "pool" } : { providerSourceId: "local" }) });
  const result = await service.run({ sessionId: session.id, prompt: "hello", permission: "readonly" }, () => {}, async () => false, signal());
  expect(result.status).toBe("completed");
  expect(seen).toEqual([{ source: "local", effort: "low", output: 16384 }, ...(routed ? [{ source: "other", effort: "none", output: 8192 }] : [])]);
  const persisted = await (await openSessionStore(f.home)).get(session.id);
  expect(persisted.events.filter(event => event.type === "provider_attempt").map(event => event.selection.reasoningEffort))
    .toEqual(routed ? ["low", "low", "none", "none"] : ["low", "low"]);
  expect(persisted.events.some(event => event.type === "context_usage" && event.usage.windowTokens === (routed ? 128000 : 256000))).toBe(true);
});

it("keeps an alias's request settings and context window during manual compaction", async () => {
  const seen: { model: string; config: ProviderConfig }[] = [];
  const f = await fixture(config => stub(async (_messages, _tools, request) => { seen.push({ model: request.model, config }); return response; }));
  const service = await createHarness({ stateDir: f.home, providerFactory: f.providerFactory });
  cleanups.push(() => service.dispose());
  await service.updateSettings({ source: { type: "save", source: {
    ...source(), model: "alias", modelAliases: { alias: "org/model/v1" }, modelSelection: { mode: "none", overrides: {
      "org/model/v1": { reasoningEffort: "low", maxOutputTokens: 16384, contextWindowTokens: 128000 },
      alias: { reasoningEffort: "default", contextWindowTokens: 256000 },
    } },
  } } });
  const session = await service.createSession({ workspace: f.root, title: "Compaction fixture", providerSourceId: "local" });
  const store = await openSessionStore(f.home);
  await store.save({ ...session, messages: Array.from({ length: 12 }, (_, index) => index % 2
    ? { role: "assistant" as const, content: `Completed ${index}.` }
    : { role: "user" as const, content: `Remember ${index}.` }) });
  const compacted = await service.compactSession(session.id);
  expect(compacted.contextSummary).toBeDefined();
  expect(compacted.model).toBe("alias");
  expect(seen).toMatchObject([{ model: "org/model/v1", config: { reasoningEffort: "default", maxOutputTokens: 16384 } }]);
  expect(compacted.events.some(event => event.type === "context_usage" && event.usage.windowTokens === 256000)).toBe(true);
});

it.each([undefined, "other"])("tests the configured model parameters, including source-default selection (%s)", async model => {
  const seen: { model: string; config: ProviderConfig }[] = [];
  const { settingsStore, access } = await fixture(config => stub(async (_messages, _tools, request) => { seen.push({ model: request.model, config }); return response; }));
  await settingsStore.update({ settings: { reasoningEffort: "high", maxOutputTokens: 32768 } });
  await settingsStore.update({ source: { type: "save", source: {
    ...source(), modelAliases: { "org/model/v1": "wire" }, modelSelection: { mode: "all", overrides: {
      wire: { reasoningEffort: "default", maxOutputTokens: 16384 }, other: { reasoningEffort: "none", maxOutputTokens: 8 },
    } },
  } } });
  expect(await access.request({ type: "test", sourceId: "local", kind: "catalog" })).toMatchObject({ ok: true });
  expect(seen).toEqual([]);
  expect(await access.request({ type: "test", sourceId: "local", kind: "inference", ...(model ? { model } : {}) })).toMatchObject({ ok: true });
  expect(seen).toMatchObject([{ model: model ?? "wire", config: { reasoningEffort: model ? "none" : "default", maxOutputTokens: model ? 8 : 16384 } }]);
});

it.each(["default", "low"] as const)("keeps inference tests small without breaking Anthropic %s thinking", async reasoningEffort => {
  const seen: ProviderConfig[] = [];
  const { settingsStore, access } = await fixture(config => stub(async () => { seen.push(config); return response; }));
  await settingsStore.update({ source: { type: "save", source: { ...source(), apiMode: "anthropic", modelSelection: { mode: "all", overrides: { "org/model/v1": { reasoningEffort } } } } } });
  expect(await access.request({ type: "test", sourceId: "local", kind: "inference" })).toMatchObject({ ok: true });
  expect(seen).toMatchObject([{ reasoningEffort, maxOutputTokens: reasoningEffort === "low" ? 8192 : 64 }]);
});

const event = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
function wireResponse(apiMode: NonNullable<ProviderConfig["apiMode"]>, model: string) {
  if (apiMode === "chat-completions") return {
    type: "application/json", body: JSON.stringify({ choices: [{ message: response.message, finish_reason: "stop" }] }),
  };
  if (apiMode === "gemini") return {
    type: "text/event-stream", body: `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`,
  };
  if (apiMode === "anthropic") return {
    type: "text/event-stream", body: [
      event("message_start", { message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } }),
      event("content_block_stop", { index: 0 }),
      event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      event("message_stop", {}),
    ].join(""),
  };
  const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] };
  return {
    type: "text/event-stream", body: [
      event("response.created", { response: { id: "resp_fixture", status: "in_progress" } }),
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }),
      event("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: "OK" }),
      event("response.output_text.done", { output_index: 0, content_index: 0, item_id: item.id, text: "OK" }),
      event("response.output_item.done", { output_index: 0, item }),
      event("response.completed", { response: { id: "resp_fixture", status: "completed", output: [item] } }),
    ].join(""),
  };
}

for (const apiMode of ["chat-completions", "responses", "anthropic", "gemini"] as const) {
  it.each(["low", "default"] as const)(`sends effective Web overrides to the real ${apiMode} adapter (%s)`, async reasoningEffort => {
    const bodies: Record<string, unknown>[] = [];
    const paths: string[] = [];
    const model = apiMode === "gemini" ? "gemini-3-flash" : "wire-model";
    const server = createServer(async (request, response) => {
      paths.push(request.url!);
      let raw = "";
      for await (const chunk of request) raw += chunk;
      bodies.push(JSON.parse(raw));
      const wire = wireResponse(apiMode, model);
      response.setHeader("content-type", wire.type);
      response.end(wire.body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const { settingsStore, access } = await fixture(createModelProvider);
    await settingsStore.update({ settings: { reasoningEffort: "high", maxOutputTokens: 32768 } });
    await settingsStore.update({ source: { type: "save", source: {
      ...source(), apiMode, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "alias", modelAliases: { alias: model },
      modelSelection: { mode: "none", overrides: { [model]: { reasoningEffort, reasoningEfforts: ["low", "high"], maxOutputTokens: 16384, contextWindowTokens: 256000 } } },
    } } });
    const { provider } = await access.resolveProvider("local", undefined, signal(), "alias");
    expect(await provider.getModelContextWindow!("alias")).toBe(256000);
    expect((await complete(provider, "alias")).message.content).toBe("OK");
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body).not.toHaveProperty("contextWindowTokens");
    expect(body).not.toHaveProperty("reasoningEfforts");
    if (apiMode === "gemini") {
      expect(paths[0]).toBe(`/v1/models/${model}:streamGenerateContent?alt=sse`);
      expect(body.generationConfig).toEqual({ maxOutputTokens: 16384, ...(reasoningEffort === "default" ? {} : { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } }) });
    } else {
      expect(body.model).toBe(model);
      if (apiMode === "chat-completions") {
        expect(body.max_completion_tokens).toBe(16384);
        expect(body.reasoning_effort).toBe(reasoningEffort === "default" ? undefined : "low");
      } else if (apiMode === "responses") {
        expect(body.max_output_tokens).toBe(16384);
        expect(body.reasoning).toEqual(reasoningEffort === "default" ? undefined : { effort: "low" });
      } else {
        expect(body.max_tokens).toBe(16384);
        expect(body.thinking).toEqual(reasoningEffort === "default" ? undefined : { type: "enabled", budget_tokens: 1024 });
      }
    }
  });
}
