import { createHash, randomUUID } from "node:crypto";
import { createVertexAuth, normalizeAzureBase, type VertexAuth } from "../provider/cloud";
import { createRequestOptions } from "../provider/request-options";
import { createAccountService } from "../provider/accounts";
import type { AccountFetch } from "../provider/accounts/types";
import { createCachedProviderFactory } from "../provider/catalog-cache";
import { catalogFromIds, mergeCatalog } from "../provider/catalog";
import { parseMagpieImport, type MagpieImportResult } from "../provider/import-magpie";
import { bedrockReferenceCatalog, providerPresets } from "../provider/presets";
import type { ModelProvider, ProviderFactory, SettingsStore } from "../shared/contracts";
import type { RouteGroup, RouteMember } from "../shared/model-access";
import type { RouteQuota, RouteRequest } from "../provider/routing";
import { ForgeError } from "../shared/errors";
import { modelAccessRequestSchema, modelAccessResultSchema, type CredentialInput, type ModelAccessRequest, type ModelAccessResult } from "../shared/model-access";
import { modelCatalogSchema, type ModelCatalog } from "../shared/model-catalog";
import { providerConfigSchema, type ProviderConfig, type PublicProviderSource } from "../shared/schemas";
import { modelCatalogCacheKey, type ModelCatalogStore } from "../store/model-catalog";

const cancelled = () => new ForgeError("cancelled", "模型接入操作已取消。");
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw cancelled(); };
const publicFailure = (error: unknown) => error instanceof ForgeError
  ? `请求失败（${error.code}），请检查服务配置。` : "服务请求失败，请检查连接或账号状态。";
const credentialProjection = (source: PublicProviderSource): CredentialInput[] => source.credentials?.map(({ id, label, enabled, type, protocol }) => ({ id, label, enabled, type, ...(protocol ? { protocol } : {}) }))
  ?? [{ id: "default", label: "Default", enabled: true, type: "api-key" }];
const sourceFields = ({ hasApiKey: _key, credentials: _credentials, connection: _connection, revision: _revision, ...source }: PublicProviderSource) => source;
type SelectionValidator = (config: ProviderConfig, source: PublicProviderSource | undefined, model: string | undefined) => void;

export function applyModelSelection(upstream: ModelCatalog, source?: PublicProviderSource): ModelCatalog {
  const selection = source?.modelSelection;
  const user = new Map((selection?.manual ?? []).map(entry => [entry.id, entry]));
  for (const [id, override] of Object.entries(selection?.overrides ?? {})) {
    const entry = { ...user.get(id), ...override, id };
    user.set(id, { ...entry, contextWindowTokens: entry.contextWindowTokens ?? null });
  }
  const merged = mergeCatalog([], upstream, [...user.values()]);
  if (selection?.mode === "none") return [];
  if (selection?.mode === "selected") return merged.filter(entry => selection.models?.includes(entry.id));
  return merged;
}

/** Host-owned setup operations. Private imports, tokens and request parameters never cross RPC. */
export function createModelAccessService(options: Readonly<{
  settingsStore: SettingsStore;
  catalogStore: ModelCatalogStore;
  providerFactory: ProviderFactory;
  signal: AbortSignal;
  accountFetch?: AccountFetch;
  cloudFetch?: typeof globalThis.fetch;
}>) {
  const { settingsStore, catalogStore } = options;
  const previews = new Map<string, MagpieImportResult>();
  const tests = new Map<string, AbortController>();
  const vertexHandles = new Map<string, { key: string; auth: VertexAuth }>();
  function vertexAuth(config: ProviderConfig): VertexAuth {
    const slot = JSON.stringify([config.sourceId, config.credentialId]);
    const key = createHash("sha256").update(JSON.stringify([config.vertex, config.requestTimeoutMs, config.proxyUrl])).digest("hex");
    const previous = vertexHandles.get(slot);
    if (previous?.key === key) return previous.auth;
    previous?.auth.dispose();
    const transport = createRequestOptions(config);
    const fetch = options.cloudFetch ?? transport.fetch;
    const auth = createVertexAuth(config.vertex!, { ...(fetch ? { fetch } : {}), requestTimeoutMs: config.requestTimeoutMs });
    vertexHandles.set(slot, { key, auth });
    return auth;
  }
  const accounts = createAccountService({
    ...(options.accountFetch ? { fetch: options.accountFetch } : {}),
    async loadTokens(sourceId, credentialId) {
      return (await loadConfig(sourceId, credentialId, options.signal)).account;
    },
    async saveLogin({ sourceId, label, tokens }) {
      checkSignal(options.signal);
      const source = await findSource(sourceId);
      const credentialId = `account-${randomUUID()}`;
      await settingsStore.update({ source: { type: "save", source: sourceFields(source), expectedRevision: source.revision,
        credentials: [...credentialProjection(source), { id: credentialId, label, type: "account", enabled: true, account: tokens }] } });
      return { credentialId };
    },
  });
  function createProvider(config: ProviderConfig, source?: PublicProviderSource): ModelProvider {
    if (config.vertex) {
      const auth = vertexAuth(config);
      return {
        apiMode: "gemini",
        listModelCatalog: signal => auth.listModelCatalog(signal),
        listModels: async signal => (await auth.listModelCatalog(signal)).map(model => model.id),
        async complete(messages, definitions, request) {
          const access = await auth.resolve(request.signal);
          const raw = options.providerFactory(providerConfigSchema.parse({ ...config, ...access }));
          return raw.complete(messages, definitions, request);
        },
      };
    }
    const raw = options.providerFactory(config);
    if (source?.preset === "bedrock") return { ...raw,
      listModelCatalog: async signal => { if (signal) checkSignal(signal); return bedrockReferenceCatalog; },
      listModels: async signal => { if (signal) checkSignal(signal); return bedrockReferenceCatalog.map(model => model.id); },
    };
    if (!config.account) return raw;
    const account = config.account;
    const listModelCatalog = async (signal?: AbortSignal) => modelCatalogSchema.parse((await accounts.listModels(account, { signal })).map(model => ({
      id: model.id, contextWindowTokens: model.contextWindowTokens ?? null,
      ...(model.displayName ? { displayName: model.displayName } : {}), protocols: model.protocols,
      ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
      ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
      ...(model.vision === undefined ? {} : { vision: model.vision }),
    })));
    return { ...raw, listModelCatalog, listModels: async signal => (await listModelCatalog(signal)).map(model => model.id) };
  }
  async function findSource(id: string): Promise<PublicProviderSource> {
    const source = (await settingsStore.getPublic()).providerSources?.find(item => item.id === id);
    if (!source) throw new ForgeError("not_found", "未找到该模型来源。");
    return source;
  }
  const snapshot = async (sourceId?: string, credentialId?: string) => settingsStore.getProviderSnapshot
    ? settingsStore.getProviderSnapshot(sourceId, credentialId)
    : { config: await settingsStore.getProviderConfig(sourceId, credentialId), ...(sourceId ? { source: await findSource(sourceId) } : {}) };
  async function loadSnapshot(sourceId: string | undefined, credentialId: string | undefined, signal: AbortSignal,
    validate?: (config: ProviderConfig, source: PublicProviderSource | undefined) => void) {
    checkSignal(signal);
    let current = await snapshot(sourceId, credentialId);
    validate?.(current.config, current.source);
    const config = current.config;
    if (config.account && config.sourceId && config.credentialId && settingsStore.refreshAccount) {
      await settingsStore.refreshAccount(config.sourceId, config.credentialId, tokens => accounts.refresh(tokens, signal));
      current = await snapshot(config.sourceId, config.credentialId);
      validate?.(current.config, current.source);
    }
    checkSignal(signal);
    return current;
  }
  async function loadConfig(sourceId: string | undefined, credentialId: string | undefined, signal: AbortSignal): Promise<ProviderConfig> {
    return (await loadSnapshot(sourceId, credentialId, signal)).config;
  }
  async function resolveProvider(sourceId?: string, credentialId?: string, signal = options.signal, model?: string, validate?: SelectionValidator) {
    const current = await loadSnapshot(sourceId, credentialId, signal, validate ? (config, source) => validate(config, source, model) : undefined);
    let { config } = current;
    const { source } = current;
    const selectedModel = model === undefined ? undefined : source?.modelAliases?.[model] ?? model;
    sourceId = source?.id ?? sourceId;
    if (config.vertex) {
      config = providerConfigSchema.parse({ ...config, baseUrl: vertexAuth(config).baseUrl, apiMode: "gemini", auth: { type: "bearer" } });
    } else if (source?.preset === "azure") {
      config = providerConfigSchema.parse({ ...config, baseUrl: normalizeAzureBase(config.baseUrl) ?? config.baseUrl,
        auth: config.auth && config.auth.type !== "auto" ? config.auth : { type: "header", header: "api-key" } });
    } else if (source?.preset === "bedrock" && (!config.auth || config.auth.type === "auto")) {
      config = providerConfigSchema.parse({ ...config, auth: { type: "bearer" } });
    }
    if (config.account && !config.vertex) {
      const account = await accounts.providerConfig(config.account, selectedModel, signal);
      config = providerConfigSchema.parse({ ...config, baseUrl: account.baseUrl, apiKey: account.apiKey, apiMode: account.apiMode,
        headers: { ...account.headers, ...config.headers }, extraBody: { ...account.extraBody, ...config.extraBody } });
    }
    checkSignal(signal);
    const cached = createCachedProviderFactory(catalogStore, current => createProvider(current, source))(config, sourceId);
    const catalog = async (requestSignal?: AbortSignal, refresh?: boolean) => applyModelSelection(cached.listModelCatalog
      ? await cached.listModelCatalog(requestSignal, refresh) : catalogFromIds(await cached.listModels(requestSignal, refresh)), source);
    const provider: ModelProvider = {
      ...cached,
      listModels: async (requestSignal, refresh) => (await catalog(requestSignal, refresh)).map(entry => entry.id),
      listModelCatalog: catalog,
      // Preserve an injected host's independent context-window lookup.
      getModelContextWindow: cached.listModelCatalog || source?.modelSelection ? async (id, requestSignal) => (await catalog(requestSignal)).find(entry => entry.id === id)?.contextWindowTokens ?? null
        : async (id, requestSignal) => await cached.getModelContextWindow?.(id, requestSignal) ?? null,
      async complete(messages, definitions, request) {
        const model = selectedModel ?? source?.modelAliases?.[request.model] ?? request.model;
        const selection = { sourceId: sourceId ?? "environment", model, apiMode: config.apiMode ?? "chat-completions" as const,
          reasoningEffort: config.reasoningEffort ?? "default" as const,
          ...(config.credentialId ? { credentialId: config.credentialId } : {}), attempt: request.attempt ?? 0, reason: "direct" };
        request.onAttempt?.({ ...selection, outcome: "started", timestamp: new Date().toISOString() });
        try {
          const response = await cached.complete(messages, definitions, { ...request, model });
          request.onAttempt?.({ ...selection, outcome: "succeeded", timestamp: new Date().toISOString(), ...(response.usage ? { usage: response.usage } : {}) });
          return response;
        } catch (error) {
          request.onAttempt?.({ ...selection, outcome: "failed", timestamp: new Date().toISOString(), ...(error instanceof ForgeError ? { errorCode: error.code } : {}) });
          throw error;
        }
      },
    };
    return { config, provider, source, ...(selectedModel ? { actualModel: selectedModel } : {}) };
  }
  async function prepareRoute(group: RouteGroup, signal: AbortSignal, validate?: SelectionValidator) {
    const key = (member: RouteMember) => JSON.stringify([member.sourceId, member.model, member.credentialId]);
    const resolved = new Map<string, Awaited<ReturnType<typeof resolveProvider>>>();
    const quotas = new Map<string, RouteQuota>();
    const metadata = new Map<string, ModelCatalog[number]>();
    let firstFailure: unknown;
    for (const member of group.members) {
      if (member.enabled === false) continue;
      try {
        const current = await resolveProvider(member.sourceId, member.credentialId, signal, member.model, validate);
        resolved.set(key(member), current);
        const cached = await catalogStore.inspect(modelCatalogCacheKey(current.config, member.sourceId));
        const reference = current.config.vertex ? await vertexAuth(current.config).listModelCatalog(signal) : current.source?.preset === "bedrock" ? bedrockReferenceCatalog : [];
        const source = current.source;
        const models = applyModelSelection(cached?.models ?? reference, source ? { ...source, modelSelection: { ...source.modelSelection, mode: "all" } } : undefined);
        const model = models.find(item => item.id === member.model) ?? models.find(item => item.id === current.actualModel);
        const overrides = source?.modelSelection?.overrides?.[member.model] ?? (current.actualModel ? source?.modelSelection?.overrides?.[current.actualModel] : undefined);
        if (model || overrides) metadata.set(key(member), { id: member.model, ...model, ...overrides, contextWindowTokens: overrides?.contextWindowTokens ?? model?.contextWindowTokens ?? null });
        if ((group.strategy === "smart" || group.strategy === "pace") && current.config.account && current.config.credentialId) {
          try {
            const quota = await accounts.readQuota(member.sourceId, current.config.credentialId, signal);
            const windows = quota.windows.filter(window => !window.unlimited && window.remaining !== null && window.limit !== null && window.limit > 0);
            windows.sort((a, b) => a.remaining! / a.limit! - b.remaining! / b.limit!);
            const window = windows[0];
            if (window) quotas.set(key(member), { remaining: window.remaining!, limit: window.limit!, ...(window.resetAt === null ? {} : { resetsAt: window.resetAt }) });
          } catch { checkSignal(signal); /* Unknown allowance stays unknown. */ }
        }
      } catch (error) {
        checkSignal(signal);
        firstFailure ??= error;
      }
    }
    const base = resolved.values().next().value;
    if (!base) throw firstFailure instanceof ForgeError ? firstFailure : new ForgeError("provider", publicFailure(firstFailure));
    const modes = [...resolved.values()].map(item => item.config.apiMode ?? "chat-completions");
    const windows = [...metadata.values()].flatMap(model => model.contextWindowTokens ? [model.contextWindowTokens] : []);
    return {
      base,
      ...(modes.every(mode => mode === modes[0]) ? { apiMode: modes[0] } : {}),
      contextWindow: windows.length ? Math.min(...windows) : null,
      quota: (member: RouteMember) => quotas.get(key(member)),
      exclude: (member: RouteMember, request: RouteRequest) => {
        if (!resolved.has(key(member))) return "credential-unavailable";
        const model = metadata.get(key(member));
        const mode = resolved.get(key(member))!.config.apiMode ?? "chat-completions";
        if (model?.protocols && !model.protocols.includes(mode)) return "protocol-unsupported";
        if (request.hasImages && model?.vision === false) return "vision-unsupported";
        if (request.hasTools && model?.tools === false) return "tools-unsupported";
        return undefined;
      },
    };
  }
  async function handle(raw: ModelAccessRequest, callerSignal?: AbortSignal): Promise<ModelAccessResult> {
    const input = modelAccessRequestSchema.parse(raw);
    const signal = callerSignal ? AbortSignal.any([callerSignal, options.signal]) : options.signal;
    checkSignal(signal);
    switch (input.type) {
      case "presets": return { type: input.type, presets: providerPresets };
      case "catalog": {
        const { config, provider, source } = await resolveProvider(input.sourceId, input.credentialId, signal);
        const key = modelCatalogCacheKey(config, input.sourceId);
        try {
          const models = await provider.listModelCatalog!(signal, input.refresh);
          const snapshot = await catalogStore.inspect(key);
          return { type: input.type, sourceId: input.sourceId, models, stale: false, ...(snapshot ? { fetchedAt: snapshot.fetchedAt } : {}) };
        } catch (error) {
          checkSignal(signal);
          const previous = await catalogStore.inspect(key);
          if (!previous) throw error;
          return { type: input.type, sourceId: input.sourceId, models: applyModelSelection(previous.models, source), stale: true, fetchedAt: previous.fetchedAt, error: publicFailure(error) };
        }
      }
      case "test": {
        const controller = new AbortController();
        const requestId = input.requestId ?? randomUUID();
        if (tests.has(requestId)) throw new ForgeError("busy", "此测试仍在进行。");
        tests.set(requestId, controller);
        const testSignal = AbortSignal.any([signal, controller.signal]);
        const started = Date.now();
        try {
          const { config, provider, source } = await resolveProvider(input.sourceId, input.credentialId, testSignal, input.model);
          const model = input.model ?? source?.model;
          if (input.kind === "catalog") await provider.listModelCatalog!(testSignal, true);
          else {
            if (!model) throw new ForgeError("invalid_input", "请选择测试模型。");
            const minimal = createProvider({ ...config, maxOutputTokens: 64 }, source);
            await minimal.complete([{ role: "user", content: "Reply with OK." }], [], { model: source?.modelAliases?.[model] ?? model, signal: testSignal, onText: () => {} });
          }
          checkSignal(testSignal);
          return { type: input.type, sourceId: input.sourceId, kind: input.kind, ok: true, latencyMs: Date.now() - started, ...(model ? { model } : {}) };
        } catch (error) {
          if (testSignal.aborted) throw cancelled();
          return { type: input.type, sourceId: input.sourceId, kind: input.kind, ok: false, latencyMs: Date.now() - started, error: publicFailure(error) };
        } finally { tests.delete(requestId); }
      }
      case "cancel": {
        const controller = tests.get(input.requestId); controller?.abort();
        return { type: input.type, cancelled: !!controller };
      }
      case "import-preview": {
        const parsed = parseMagpieImport(input.text);
        const previewId = randomUUID();
        const existing = (await settingsStore.getPublic()).providerSources ?? [];
        // Never infer permission to overwrite a source from an imported identifier.
        const candidates = parsed.candidates.filter(candidate => !existing.some(source => source.id === candidate.save.source.id));
        const warnings = [...parsed.warnings, ...(candidates.length === parsed.candidates.length ? [] : ["已有同 ID 的来源未加入导入列表。"] )];
        previews.set(previewId, { candidates, warnings });
        return { type: input.type, previewId, warnings, sources: candidates.map(({ save, warnings }) => ({
          id: save.source.id, label: save.source.label, baseUrl: save.source.baseUrl, model: save.source.model,
          ...(save.source.apiMode ? { apiMode: save.source.apiMode } : {}), credentialCount: save.credentials?.length ?? (save.apiKey ? 1 : 0), warnings,
        })) };
      }
      case "import-apply": {
        const preview = previews.get(input.previewId);
        if (!preview) throw new ForgeError("not_found", "导入预览已失效，请重新预览。");
        const ids = new Set(input.sourceIds);
        const selected = preview.candidates.filter(candidate => ids.has(candidate.save.source.id));
        if (selected.length !== ids.size) throw new ForgeError("invalid_input", "所选来源不在此预览中。");
        previews.delete(input.previewId);
        // expectedRevision:0 makes a concurrent create a conflict, not an overwrite.
        await settingsStore.update({ sources: selected.map(candidate => ({ ...candidate.save, expectedRevision: 0 })) });
        return { type: input.type, applied: selected.map(candidate => candidate.save.source.id) };
      }
      case "login-start":
        await findSource(input.sourceId);
        return { type: input.type, login: await accounts.startLogin({ platform: input.platform, sourceId: input.sourceId, ...(input.label ? { label: input.label } : {}), signal }) };
      case "login-poll": return { type: input.type, login: await accounts.pollLogin(input.loginId) };
      case "login-cancel": return { type: input.type, login: accounts.cancelLogin(input.loginId) };
      case "quota": return { type: input.type, quota: await accounts.readQuota(input.sourceId, input.credentialId, signal) };
    }
  }
  return {
    resolveProvider, prepareRoute,
    async request(input: ModelAccessRequest, signal?: AbortSignal): Promise<ModelAccessResult> {
      return modelAccessResultSchema.parse(await handle(input, signal));
    },
    async dispose() {
      for (const test of tests.values()) test.abort();
      previews.clear();
      for (const { auth } of vertexHandles.values()) auth.dispose();
      vertexHandles.clear();
      await accounts.dispose();
    },
  };
}
