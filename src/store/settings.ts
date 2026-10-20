import { join } from "node:path";
import { z } from "zod";
import type { SettingsStore } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import {
  configureInputSchema,
  defaultPublicSettings,
  providerConfigSchema,
  providerSourceIdSchema,
  providerSourceRevisionSchema,
  providerSourceSchema,
  publicSettingsSchema,
} from "../shared/schemas";
import type { ProviderSourceOperation, PublicSettings } from "../shared/schemas";
import { atomicJson, privateDirectory, readJson, storageError } from "./io";
import { fileLock } from "./lock";
import { accountTokensSchema, credentialInputSchema, connectionInputSchema, routeGroupSchema, sourceAccessFields, type CredentialInput, type RouteGroup } from "../shared/model-access";

async function settingsLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      return await fileLock(path);
    } catch (error) {
      if (!(error instanceof ForgeError && error.code === "busy")) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new ForgeError("busy", "Settings are currently locked.", true);
}

// One authoritative transaction holds sources, private credentials and routes.
const TRANSACTION_LIMIT = 16 * 1024 * 1024;
const NEW_SOURCE_ID = "default";
const NEW_SOURCE_LABEL = "Default";

const fieldsSchema = configureInputSchema.unwrap().shape.settings.unwrap();
const credentialValueSchema = configureInputSchema.unwrap().shape.apiKey.unwrap();
const configSchema = z
  .object({ version: z.literal(1), settings: fieldsSchema })
  .strict();
const credentialSchema = z
  .object({
    version: z.literal(1),
    apiKey: credentialValueSchema,
  })
  .strict();
const storedSourceSchema = providerSourceSchema
  .unwrap()
  .extend({
    apiKey: credentialValueSchema,
    credentials: z.array(credentialInputSchema).readonly().optional(),
    connection: connectionInputSchema.optional(),
    // Every committed edit bumps this; UI writes must echo the revision they saw.
    revision: providerSourceRevisionSchema.optional(),
  })
  .strict()
  .readonly();
type StoredSettings = z.infer<typeof fieldsSchema>;
type StoredSource = z.infer<typeof storedSourceSchema> & {
  readonly revision: number;
};
type StoredState = Readonly<{
  version?: 1 | 2;
  routeGroups?: readonly RouteGroup[];
  settings: StoredSettings;
  apiKey: string;
  sources: readonly StoredSource[];
  activeSourceId?: string;
}>;
// One lock, one file: endpoint, credential and every provider source commit
// together, so an interruption can never expose a mixed provider pair.
const transactionSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    settings: fieldsSchema,
    apiKey: credentialValueSchema,
    sources: z.array(storedSourceSchema).optional(),
    routeGroups: z.array(routeGroupSchema).readonly().optional(),
    activeSourceId: providerSourceIdSchema.optional(),
  })
  .strict()
  .refine(
    (state) =>
      new Set((state.sources ?? []).map((source) => source.id)).size ===
        (state.sources ?? []).length &&
      (state.activeSourceId === undefined ||
        (state.sources ?? []).some(
          (source) => source.id === state.activeSourceId,
        )),
    "Provider source IDs must be unique and the active source must exist",
  );

async function optionalRecord(
  path: string,
  limit = 65536,
): Promise<unknown | undefined> {
  try {
    return await readJson(path, limit);
  } catch (error) {
    if (error instanceof ForgeError && error.code === "not_found")
      return undefined;
    throw error;
  }
}

const invalid = (message: string): ForgeError =>
  new ForgeError("invalid_input", message);
const unknownSource = (): ForgeError =>
  new ForgeError("not_found", "未找到该模型来源，可能已在别处删除。");

// Migration rule: an older state (or legacy config) with a usable endpoint
// becomes the "default" source, keeping its model, protocol and credential.
function seedFromLegacy(state: StoredState): StoredState {
  if (state.sources.length > 0) return state;
  const baseUrl = state.settings.baseUrl;
  if (baseUrl === undefined || baseUrl === "") return state;
  const apiMode = state.settings.apiMode;
  return {
    ...state,
    sources: [
      {
        id: NEW_SOURCE_ID,
        label: NEW_SOURCE_LABEL,
        baseUrl,
        model: state.settings.model ?? "",
        ...(apiMode === undefined ? {} : { apiMode }),
        apiKey: state.apiKey,
        revision: 1,
      },
    ],
    activeSourceId: NEW_SOURCE_ID,
  };
}

// The active source is projected onto the legacy top-level pair so runtimes and
// the CLI keep working through the no-argument provider config path.
function projectActive(state: StoredState, source: StoredSource): StoredState {
  const settings: Record<string, unknown> = {
    ...state.settings,
    baseUrl: source.baseUrl,
    model: source.model,
  };
  if (source.apiMode === undefined) delete settings.apiMode;
  else settings.apiMode = source.apiMode;
  return { ...state, settings: settings as StoredSettings, apiKey: source.apiKey };
}

function sourceCredentials(source: StoredSource): readonly CredentialInput[] {
  return source.credentials ?? [{ id: "default", label: "Default", type: "api-key", enabled: true, apiKey: source.apiKey }];
}
function selectedCredential(source: StoredSource, id?: string): CredentialInput {
  const credentials = sourceCredentials(source);
  const requested = id ?? source.activeCredentialId;
  const credential = requested === undefined
    ? credentials.find(item => item.enabled && (!item.protocol || item.protocol === (source.apiMode ?? "chat-completions")))
    : credentials.find(item => item.id === requested);
  if (!credential || !credential.enabled) throw invalid("此来源没有可用的凭据。");
  if (credential.protocol && credential.protocol !== (source.apiMode ?? "chat-completions")) throw invalid("凭据与所选协议不匹配。");
  return credential;
}
function publicSource(source: StoredSource) {
  const { apiKey, credentials: _credentials, connection, ...fields } = source;
  return {
    ...fields,
    hasApiKey: sourceCredentials(source).some(item => !!item.apiKey || !!item.account?.accessToken),
    ...(source.credentials ? { credentials: source.credentials.map(item => ({
      id: item.id, label: item.label, type: item.type, enabled: item.enabled,
      ...(item.protocol ? { protocol: item.protocol } : {}),
      ...(item.account ? { platform: item.account.platform, ...(item.account.expiresAt === undefined ? {} : { expiresAt: item.account.expiresAt }) } : {}),
      status: !item.enabled ? "disabled" : item.type === "account" && !item.account ? "signed-out"
        : item.account?.expiresAt !== undefined && item.account.expiresAt <= Date.now() ? "expired" : "ready",
    })) } : {}),
    ...(connection ? { connection: {
      ...(connection.auth ? { auth: { type: connection.auth.type, ...(connection.auth.header ? { header: connection.auth.header } : {}) } } : {}),
      headerNames: Object.keys(connection.headers ?? {}), hasExtraBody: Object.keys(connection.extraBody ?? {}).length > 0, hasProxy: !!connection.proxyUrl,
      ...(connection.vertex ? { hasVertex: true } : {}),
    } } : {}),
  };
}
function validateReferences(state: StoredState): void {
  const groups = state.routeGroups ?? [];
  if (new Set(groups.map(group => group.id)).size !== groups.length) throw invalid("路由组 ID 重复。");
  for (const source of state.sources) {
    const credentials = sourceCredentials(source);
    if (new Set(credentials.map(item => item.id)).size !== credentials.length) throw invalid("凭据 ID 重复。");
    if (source.activeCredentialId && !credentials.some(item => item.id === source.activeCredentialId)) throw invalid("所选凭据不存在。");
  }
  for (const group of groups) for (const member of group.members) {
    const source = state.sources.find(item => item.id === member.sourceId);
    if (!source || (member.credentialId && !sourceCredentials(source).some(item => item.id === member.credentialId)))
      throw invalid("路由仍引用此来源或凭据，请先更新路由成员。");
  }
}
function hasExtendedState(state: StoredState): boolean {
  return state.version === 2 || state.routeGroups !== undefined || state.settings.apiMode === "gemini" || state.sources.some(source =>
    source.credentials !== undefined || source.connection !== undefined || source.apiMode === "gemini" ||
    Object.keys(sourceAccessFields).some(key => source[key as keyof StoredSource] !== undefined));
}

export async function openSettingsStore(
  directory: string,
  options: Readonly<{
    // Session ids pinned to a source; used to refuse a destructive removal.
    referencedSessions?: (sourceId: string) => Promise<readonly string[]>;
  }> = {},
): Promise<SettingsStore> {
  const root = await privateDirectory(directory);
  const folder = await privateDirectory(join(root, "settings"));
  const configPath = join(folder, "config.json");
  const keyPath = join(folder, "credential.json");
  const transactionPath = join(folder, "state.json");
  const locked = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = await settingsLock(join(folder, "state.lock"));
    try {
      return await operation();
    } finally {
      await release();
    }
  };
  const record = (state: StoredState) => ({
    version: hasExtendedState(state) ? 2 as const : 1 as const,
    settings: state.settings,
    apiKey: state.apiKey,
    sources: [...state.sources],
    ...(state.routeGroups === undefined ? {} : { routeGroups: state.routeGroups }),
    ...(state.activeSourceId === undefined
      ? {}
      : { activeSourceId: state.activeSourceId }),
  });
  const commitState = async (state: StoredState): Promise<void> => {
    validateReferences(state);
    const next = record(state);
    if (next.version === 2) {
      const previous = await optionalRecord(transactionPath, TRANSACTION_LIMIT);
      if (previous && (previous as { version?: unknown }).version === 1) {
        const backup = join(folder, "state.v1.backup.json");
        if (await optionalRecord(backup, TRANSACTION_LIMIT) === undefined)
          await atomicJson(backup, previous, TRANSACTION_LIMIT);
      }
    }
    await atomicJson(transactionPath, next, TRANSACTION_LIMIT);
  };
  const commitAll = async (state: StoredState): Promise<void> => {
    // Single authoritative commit includes endpoint and credential together.
    // Legacy files remain private compatibility projections, never read once
    // state.json exists; interruption cannot expose a mixed provider pair.
    await commitState(state);
    await atomicJson(keyPath, { version: 1, apiKey: state.apiKey }, 65536);
    await atomicJson(
      configPath,
      { version: 1, settings: state.settings },
      65536,
    );
  };
  const load = async (): Promise<StoredState> => {
    // After opening, absence is corruption, never a reason to combine projections.
    const parsed = transactionSchema.safeParse(
      await readJson(transactionPath, TRANSACTION_LIMIT),
    );
    if (!parsed.success) throw storageError();
    const state: StoredState = {
      version: parsed.data.version,
      ...(parsed.data.routeGroups === undefined ? {} : { routeGroups: parsed.data.routeGroups }),
      settings: parsed.data.settings,
      apiKey: parsed.data.apiKey,
      sources: (parsed.data.sources ?? []).map((source) => ({
        ...source,
        revision: source.revision ?? 1,
      })),
      ...(parsed.data.activeSourceId === undefined
        ? {}
        : { activeSourceId: parsed.data.activeSourceId }),
    };
    try { validateReferences(state); } catch { throw storageError(); }
    return state;
  };
  const initialize = async () => {
    const transaction = await optionalRecord(
      transactionPath,
      TRANSACTION_LIMIT,
    );
    if (transaction !== undefined) {
      const stored = await load();
      // Publish legacy source lists and missing revisions under the writer lock.
      const parsed = transactionSchema.safeParse(transaction);
      if (!parsed.success) throw storageError();
      if (
        parsed.data.sources === undefined ||
        parsed.data.sources.some((source) => source.revision === undefined)
      ) await commitState(seedFromLegacy(stored));
      return;
    }
    // Import legacy files only while holding the cross-process writer lock, and
    // publish one authoritative snapshot before exposing any unlocked readers.
    const config = await optionalRecord(configPath);
    const credential = await optionalRecord(keyPath);
    const parsed = configSchema.safeParse(
      config ?? { version: 1, settings: {} },
    );
    const key = credentialSchema.safeParse(
      credential ?? { version: 1, apiKey: "" },
    );
    if (!parsed.success || !key.success) throw storageError();
    await commitState(
      seedFromLegacy({
        settings: parsed.data.settings,
        apiKey: key.data.apiKey,
        sources: [],
      }),
    );
  };
  const effective = async (): Promise<
    Readonly<{
      stored: StoredState;
      public: PublicSettings;
      apiKey: string;
      environmentOverride: boolean;
    }>
  > => {
    const stored = await load();
    const overlay = configureInputSchema.safeParse({
      settings: {
        ...(process.env.FORGE_BASE_URL === undefined
          ? {}
          : { baseUrl: process.env.FORGE_BASE_URL }),
        ...(process.env.FORGE_MODEL === undefined
          ? {}
          : { model: process.env.FORGE_MODEL }),
      },
      ...(process.env.FORGE_API_KEY === undefined
        ? {}
        : { apiKey: process.env.FORGE_API_KEY }),
    });
    if (!overlay.success)
      throw new ForgeError(
        "invalid_input",
        "Environment configuration failed validation.",
      );
    const settings = {
      ...defaultPublicSettings,
      ...stored.settings,
      ...overlay.data.settings,
    };
    const active = stored.sources.find(
      (source) => source.id === stored.activeSourceId,
    );
    // FORGE_* keeps its original priority over the stored active source.
    const apiKey =
      overlay.data.apiKey ?? active?.apiKey ?? stored.apiKey;
    const environmentOverride =
      process.env.FORGE_BASE_URL !== undefined ||
      process.env.FORGE_MODEL !== undefined ||
      process.env.FORGE_API_KEY !== undefined;
    return {
      stored,
      apiKey,
      environmentOverride,
      public: publicSettingsSchema.parse({
        ...settings,
        hasApiKey: apiKey !== "",
        isConfigured: settings.baseUrl !== "" && settings.model !== "",
        providerSources: stored.sources.map(publicSource),
        ...(stored.routeGroups === undefined ? {} : { routeGroups: stored.routeGroups }),
        ...(stored.activeSourceId === undefined
          ? {}
          : { activeSourceId: stored.activeSourceId }),
        environmentOverride,
      }),
    };
  };
  const providerSnapshot = async (sourceId?: string, credentialId?: string) => {
    const state = await effective();
    if (sourceId === undefined && !state.environmentOverride) sourceId = state.stored.activeSourceId;
    if (sourceId !== undefined) {
      const source = state.stored.sources.find(candidate => candidate.id === sourceId);
      if (!source) throw unknownSource();
      const credential = selectedCredential(source, credentialId);
      if (credential.type === "account" && !credential.account) throw invalid("账号已退出，请重新登录。");
      return {
        source: state.public.providerSources!.find(candidate => candidate.id === source.id)!,
        config: providerConfigSchema.parse({
          ...source.connection,
          baseUrl: source.endpoints?.[source.apiMode ?? "chat-completions"] ?? source.baseUrl,
          apiKey: credential.apiKey ?? credential.account?.accessToken ?? "",
          credentialId: credential.id, sourceId: source.id, sourceRevision: source.revision,
          ...(credential.account ? { account: credential.account } : {}),
          requestTimeoutMs: state.public.requestTimeoutMs, apiMode: source.apiMode,
          reasoningEffort: state.public.reasoningEffort, maxOutputTokens: state.public.maxOutputTokens,
        }),
      };
    }
    const config = state.public;
    if (!config.baseUrl) throw new ForgeError("invalid_input", "Configure a provider endpoint before listing models.");
    return { config: providerConfigSchema.parse({
      baseUrl: config.baseUrl, apiKey: state.apiKey, requestTimeoutMs: config.requestTimeoutMs,
      apiMode: config.apiMode, reasoningEffort: config.reasoningEffort, maxOutputTokens: config.maxOutputTokens,
    }) };
  };
  await locked(initialize);
  let tail: Promise<void> = Promise.resolve();
  return {
    async getPublic() {
      return (await effective()).public;
    },
    getProviderSnapshot: providerSnapshot,
    async getProviderConfig(sourceId, credentialId) {
      const snapshot = await providerSnapshot(sourceId, credentialId);
      if (snapshot.source && !snapshot.source.credentials) {
        // Preserve the legacy private-config shape for older injected hosts.
        const { sourceId: _id, sourceRevision: _revision, credentialId: _credential, ...legacy } = snapshot.config;
        return legacy;
      }
      return snapshot.config;
    },
    async refreshAccount(sourceId, credentialId, refresh) {
      await locked(async () => {
        const state = await load();
        const source = state.sources.find(item => item.id === sourceId);
        if (!source) throw unknownSource();
        const credential = selectedCredential(source, credentialId);
        if (!credential.account) throw invalid("未找到订阅账号。");
        if (credential.account.expiresAt === undefined || credential.account.expiresAt > Date.now() + 30_000) return;
        // The same cross-process lock spans token rotation and commit. Another
        // reader rechecks expiry after acquiring it instead of reusing a stale token.
        const account = accountTokensSchema.parse(await refresh(credential.account));
        const saved = { ...source, revision: source.revision + 1, credentials: sourceCredentials(source).map(item =>
          item.id === credentialId ? { ...item, account } : item) };
        await commitAll({ ...state, version: 2, sources: state.sources.map(item => item.id === sourceId ? saved : item) });
      });
      return (await providerSnapshot(sourceId, credentialId)).config;
    },
    update(input) {
      const operation = tail.then(() =>
        locked(async () => {
          const parsed = configureInputSchema.safeParse(input);
          if (!parsed.success)
            throw new ForgeError(
              "invalid_input",
              "Settings failed validation.",
            );
          const { source, sources: batch, route, settings, apiKey } = parsed.data;
          if ((source || batch) && (settings !== undefined || apiKey !== undefined))
            throw invalid("来源操作不能与普通设置或密钥更新同时提交。");
          if (source && batch) throw invalid("不能同时提交单个来源和来源批次。");
          const stored = await load();
          let next = settings !== undefined || apiKey !== undefined ? updateLegacy(stored, parsed.data) : stored;
          for (const operation of batch ?? (source ? [source] : []))
            next = await updateSource(next, operation, options.referencedSessions ?? (async () => []));
          if (route) {
            const groups = (next.routeGroups ?? []).filter(group => group.id !== (route.type === "save" ? route.group.id : route.id));
            if (route.type === "save") groups.push(route.group);
            next = { ...next, version: 2, routeGroups: groups };
          }
          await commitAll(next);
          return (await effective()).public;
        }),
      );
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}

async function updateSource(
  state: StoredState,
  operation: ProviderSourceOperation,
  referencedSessions: (sourceId: string) => Promise<readonly string[]>,
): Promise<StoredState> {
  const sources = [...state.sources];
  if (operation.type === "save") {
    const index = sources.findIndex(
      (source) => source.id === operation.source.id,
    );
    const existing = index === -1 ? undefined : sources[index];
    // Optimistic lock: a renderer that opened the editor must prove it saw the
    // committed revision, so a concurrent desktop/CLI edit cannot be clobbered.
    if (
      operation.expectedRevision !== undefined &&
      (existing?.revision ?? 0) !== operation.expectedRevision
    )
      throw invalid(
        "该来源已被其他窗口或 CLI 修改。请重新加载设置后再保存，避免覆盖对方的改动。",
      );
    // Reusing a stored credential for a different endpoint would silently send
    // one server's key to another. Require an explicit key, or an empty one.
    if (
      existing !== undefined &&
      existing.apiKey !== "" &&
      existing.baseUrl !== operation.source.baseUrl &&
      operation.apiKey === undefined
    )
      throw invalid(
        "修改来源地址时必须重新提供新地址的密钥（或明确清除已保存的密钥），以免把旧密钥发往新地址。",
      );
    const previousCredentials = existing ? sourceCredentials(existing) : [];
    let credentials = operation.credentials?.map(item => {
      const previous = previousCredentials.find(value => value.id === item.id && value.type === item.type);
      return { ...item, ...(item.type === "api-key" ? { apiKey: item.apiKey ?? previous?.apiKey ?? "" }
        : { account: item.account ?? previous?.account }) };
    }) ?? existing?.credentials;
    if (credentials && operation.apiKey !== undefined) {
      const id = operation.source.activeCredentialId ?? existing?.activeCredentialId ?? credentials[0]?.id ?? "default";
      credentials = credentials.map(item => item.id === id ? { ...item, type: "api-key" as const, apiKey: operation.apiKey!, account: undefined } : item);
    }
    let saved: StoredSource = {
      ...existing,
      ...operation.source,
      ...(credentials === undefined ? {} : { credentials }),
      ...(operation.connection === undefined ? {} : { connection: { ...existing?.connection, ...operation.connection } }),
      apiKey: operation.apiKey ?? existing?.apiKey ?? "",
      revision: (existing?.revision ?? 0) + 1,
    };
    if (saved.credentials) {
      const selected = saved.credentials.find(item => item.id === saved.activeCredentialId) ?? saved.credentials.find(item => item.enabled);
      saved = { ...saved, apiKey: selected?.type === "api-key" ? selected.apiKey ?? "" : "" };
    }
    if (existing === undefined) sources.push(saved);
    else sources[index] = saved;
    // The active source is only a fallback for callers that name no source: it
    // follows the last source used instead of being a setting users must edit.
    const activeSourceId = state.activeSourceId ?? saved.id;
    const next: StoredState = {
      ...state,
      sources,
      ...(activeSourceId === undefined ? {} : { activeSourceId }),
    };
    return saved.id === activeSourceId ? projectActive(next, saved) : next;
  }
  const index = sources.findIndex((source) => source.id === operation.id);
  if (operation.type === "activate") {
    const source = index === -1 ? undefined : sources[index];
    if (source === undefined) throw unknownSource();
    // The active source is only the fallback for callers that name no source,
    // so the last used source is remembered without any manual switch step.
    return projectActive(
      { ...state, sources, activeSourceId: source.id },
      source,
    );
  }
  if (index === -1) throw unknownSource();
  // Sessions pin the source they were created with; removing it would strand
  // them with a source id that no longer resolves. Require an explicit ack.
  const pinned = await referencedSessions(operation.id);
  const acknowledged = new Set(operation.forgottenSessionIds ?? []);
  const unreleased = pinned.filter((id) => !acknowledged.has(id));
  if (unreleased.length > 0)
    throw invalid(
      `仍有 ${unreleased.length} 个会话绑定此来源（${unreleased.slice(0, 5).join(", ")}）。确认删除后这些会话将没有来源，无法继续运行。`,
    );
  sources.splice(index, 1);
  // "Active" is only the fallback for callers that name no source, so removing
  // it hands the fallback to the next remaining source instead of asking the
  // user to switch first.
  if (state.activeSourceId !== operation.id) return { ...state, sources };
  const next = sources[0];
  if (next === undefined) {
    // Nothing left: clear the legacy projection so no stale pair stays usable.
    const { apiMode: _apiMode, ...rest } = state.settings as Record<string, unknown>;
    const { activeSourceId: _active, ...persistent } = state;
    return {
      ...persistent,
      settings: { ...rest, baseUrl: "", model: "" } as StoredSettings,
      apiKey: "",
      sources,
    };
  }
  return projectActive({ ...state, sources, activeSourceId: next.id }, next);
}

function updateLegacy(
  state: StoredState,
  input: Readonly<{
    settings?: Readonly<Record<string, unknown>> | undefined;
    apiKey?: string | undefined;
  }>,
): StoredState {
  const { activeSourceId: _active, ...persistent } = state;
  const patch = input.settings ?? {};
  const settings: Record<string, unknown> = {
    ...state.settings,
    ...patch,
  };
  const apiKey = input.apiKey ?? state.apiKey;
  const sources = [...state.sources];
  const index =
    state.activeSourceId === undefined
      ? -1
      : sources.findIndex((source) => source.id === state.activeSourceId);
  const current = index === -1 ? undefined : sources[index];
  if (current !== undefined) {
    const baseUrl = settings.baseUrl;
    // A cleared endpoint cannot be represented by a stored source; keep the
    // source (and its key) but stop projecting it as the active one.
    if (baseUrl === undefined || baseUrl === "") {
      const next: StoredState = {
        ...persistent,
        settings: settings as StoredSettings,
        apiKey,
        sources,
      };
      return next;
    }
    const synced: StoredSource = {
      ...current,
      baseUrl: baseUrl as string,
      model: (settings.model as string | undefined) ?? "",
      ...(settings.apiMode === undefined
        ? {}
        : { apiMode: settings.apiMode as StoredSource["apiMode"] }),
    };
    // `apiMode` is optional: dropping it when unset keeps the source exact.
    if (settings.apiMode === undefined) delete (synced as { apiMode?: unknown }).apiMode;
    const providerChanged = input.apiKey !== undefined || ["baseUrl", "model", "apiMode"].some(key => Object.hasOwn(patch, key));
    const credentials = current.credentials && input.apiKey !== undefined ? current.credentials.map(item =>
      item.id === (current.activeCredentialId ?? current.credentials?.[0]?.id) ? { ...item, type: "api-key" as const, apiKey, account: undefined } : item) : current.credentials;
    sources[index] = { ...synced, apiKey, ...(credentials ? { credentials } : {}), revision: current.revision + (providerChanged ? 1 : 0) };
    return {
      ...persistent,
      settings: settings as StoredSettings,
      apiKey,
      sources,
      activeSourceId: current.id,
    };
  }
  const baseUrl = settings.baseUrl;
  if (baseUrl === undefined || baseUrl === "")
    return { ...persistent, settings: settings as StoredSettings, apiKey, sources };
  // A legacy CLI update that sets an endpoint where no source exists yet
  // creates the "default" source so both views stay describable.
  const existing = sources.findIndex((source) => source.id === NEW_SOURCE_ID);
  const created: StoredSource = {
    id: NEW_SOURCE_ID,
    label: existing === -1 ? NEW_SOURCE_LABEL : sources[existing]!.label,
    baseUrl: baseUrl as string,
    model: (settings.model as string | undefined) ?? "",
    ...(settings.apiMode === undefined
      ? {}
      : { apiMode: settings.apiMode as StoredSource["apiMode"] }),
    apiKey,
    revision: existing === -1 ? 1 : (sources[existing]?.revision ?? 0) + 1,
  };
  if (existing === -1) sources.push(created);
  else sources[existing] = created;
  return {
    ...persistent,
    settings: settings as StoredSettings,
    apiKey,
    sources,
    activeSourceId: created.id,
  };
}
