import { ForgeError } from "../shared/errors";
import {
  type CredentialInput,
  type ProviderProtocol,
  sourceAccessFields,
} from "../shared/model-access";
import { readJson } from "./io";
import { fileLock } from "./lock";
import {
  NEW_SOURCE_ID,
  NEW_SOURCE_LABEL,
  type StoredSettings,
  type StoredSource,
  type StoredState,
} from "./settings-schema";

export async function settingsLock(path: string): Promise<() => Promise<void>> {
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

export async function optionalRecord(
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

export const invalid = (message: string): ForgeError =>
  new ForgeError("invalid_input", message);
export const unknownSource = (): ForgeError =>
  new ForgeError("not_found", "未找到该模型来源，可能已在别处删除。");

// Migration rule: an older state (or legacy config) with a usable endpoint
// becomes the "default" source, keeping its model, protocol and credential.
export function seedFromLegacy(state: StoredState): StoredState {
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
export function projectActive(
  state: StoredState,
  source: StoredSource,
): StoredState {
  // Drop a stale top-level apiMode when the active source has none.
  const { apiMode: _staleApiMode, ...inherited } = state.settings;
  const settings: Record<string, unknown> = {
    ...inherited,
    baseUrl: source.baseUrl,
    model: source.model,
    ...(source.apiMode === undefined ? {} : { apiMode: source.apiMode }),
  };
  return {
    ...state,
    settings: settings as StoredSettings,
    apiKey: source.apiKey,
  };
}

export function sourceCredentials(
  source: StoredSource,
): readonly CredentialInput[] {
  return (
    source.credentials ?? [
      {
        id: "default",
        label: "Default",
        type: "api-key",
        enabled: true,
        apiKey: source.apiKey,
      },
    ]
  );
}
export function selectedCredential(
  source: StoredSource,
  id?: string,
  protocol: ProviderProtocol = source.apiMode ?? "chat-completions",
): CredentialInput {
  const credentials = sourceCredentials(source);
  const requested = id ?? source.activeCredentialId;
  const credential =
    requested === undefined
      ? credentials.find(
          (item) =>
            item.enabled && (!item.protocol || item.protocol === protocol),
        )
      : credentials.find((item) => item.id === requested);
  if (!credential || !credential.enabled)
    throw invalid("此来源没有可用的凭据。");
  if (credential.protocol && credential.protocol !== protocol)
    throw invalid("凭据与所选协议不匹配。");
  return credential;
}
export function publicSource(source: StoredSource) {
  const { apiKey, credentials: _credentials, connection, ...fields } = source;
  return {
    ...fields,
    hasApiKey: sourceCredentials(source).some(
      (item) => !!item.apiKey || !!item.account?.accessToken,
    ),
    ...(source.credentials
      ? {
          credentials: source.credentials.map((item) => ({
            id: item.id,
            label: item.label,
            type: item.type,
            enabled: item.enabled,
            ...(item.protocol ? { protocol: item.protocol } : {}),
            ...(item.account
              ? {
                  platform: item.account.platform,
                  ...(item.account.expiresAt === undefined
                    ? {}
                    : { expiresAt: item.account.expiresAt }),
                }
              : {}),
            status: !item.enabled
              ? "disabled"
              : item.type === "account" && !item.account
                ? "signed-out"
                : item.account?.expiresAt !== undefined &&
                    item.account.expiresAt <= Date.now()
                  ? "expired"
                  : "ready",
          })),
        }
      : {}),
    ...(connection
      ? {
          connection: {
            ...(connection.auth
              ? {
                  auth: {
                    type: connection.auth.type,
                    ...(connection.auth.header
                      ? { header: connection.auth.header }
                      : {}),
                  },
                }
              : {}),
            headerNames: Object.keys(connection.headers ?? {}),
            hasExtraBody: Object.keys(connection.extraBody ?? {}).length > 0,
            hasProxy: !!connection.proxyUrl,
            ...(connection.vertex ? { hasVertex: true } : {}),
          },
        }
      : {}),
  };
}
export function validateReferences(state: StoredState): void {
  const groups = state.routeGroups ?? [];
  if (new Set(groups.map((group) => group.id)).size !== groups.length)
    throw invalid("路由组 ID 重复。");
  for (const source of state.sources) {
    const credentials = sourceCredentials(source);
    if (new Set(credentials.map((item) => item.id)).size !== credentials.length)
      throw invalid("凭据 ID 重复。");
    if (
      source.activeCredentialId &&
      !credentials.some((item) => item.id === source.activeCredentialId)
    )
      throw invalid("所选凭据不存在。");
  }
  for (const group of groups)
    for (const member of group.members) {
      const source = state.sources.find((item) => item.id === member.sourceId);
      if (
        !source ||
        (member.credentialId &&
          !sourceCredentials(source).some(
            (item) => item.id === member.credentialId,
          ))
      )
        throw invalid("路由仍引用此来源或凭据，请先更新路由成员。");
    }
  // A stored fixed profile must always resolve: it is an explicit model choice,
  // never a hint to fall back to whatever source happens to be active.
  for (const profile of state.agentProfiles ?? []) {
    const selection = profile.model;
    if (selection.mode !== "fixed") continue;
    const sourceId = selection.providerSourceId;
    if (!state.sources.some((source) => source.id === sourceId))
      throw invalid(
        "智能体配置固定使用的模型来源不存在，请先修改或删除该智能体配置。",
      );
  }
}
export function hasExtendedState(state: StoredState): boolean {
  return (
    state.version === 2 ||
    state.routeGroups !== undefined ||
    state.agentProfiles !== undefined ||
    state.agentProfilesRevision !== undefined ||
    state.settings.apiMode === "gemini" ||
    state.sources.some(
      (source) =>
        source.credentials !== undefined ||
        source.connection !== undefined ||
        source.apiMode === "gemini" ||
        Object.keys(sourceAccessFields).some(
          (key) => source[key as keyof StoredSource] !== undefined,
        ),
    )
  );
}
