import type {
  AgentProfile,
  AgentProfileOperation,
} from "../shared/agent-profiles";
import { ForgeError } from "../shared/errors";
import { configureInputSchema } from "../shared/schemas";
import type {
  ConfigureInput,
  ProviderSourceOperation,
} from "../shared/schemas";
import type { createSettingsProvider } from "./settings-provider";
import {
  NEW_SOURCE_ID,
  NEW_SOURCE_LABEL,
  type StoredSettings,
  type StoredSource,
  type StoredState,
} from "./settings-schema";
import {
  invalid,
  projectActive,
  sourceCredentials,
  unknownSource,
} from "./settings-state";

export function createSettingsUpdates({
  locked,
  load,
  commitAll,
  provider,
  options,
}: Readonly<{
  locked: <T>(operation: () => Promise<T>) => Promise<T>;
  load: () => Promise<StoredState>;
  commitAll: (state: StoredState) => Promise<void>;
  provider: ReturnType<typeof createSettingsProvider>;
  options: Readonly<{
    referencedSessions?: (sourceId: string) => Promise<readonly string[]>;
  }>;
}>) {
  const { effective } = provider;
  let tail: Promise<void> = Promise.resolve();
  return {
    update(input: ConfigureInput) {
      const operation = tail.then(() =>
        locked(async () => {
          const parsed = configureInputSchema.safeParse(input);
          if (!parsed.success)
            throw new ForgeError(
              "invalid_input",
              "Settings failed validation.",
            );
          const {
            source,
            sources: batch,
            route,
            agent,
            settings,
            apiKey,
          } = parsed.data;
          if (
            (source || batch) &&
            (settings !== undefined || apiKey !== undefined)
          )
            throw invalid("来源操作不能与普通设置或密钥更新同时提交。");
          if (source && batch)
            throw invalid("不能同时提交单个来源和来源批次。");
          // Profile CRUD and source edits each validate cross-references against
          // the other, so combining them would make the outcome order-dependent.
          if (agent !== undefined && (source || batch))
            throw invalid("智能体配置操作不能与来源操作同时提交。");
          const stored = await load();
          // Profile CRUD merges into the loaded collection, so it never rewrites
          // unrelated roles, provider sources or ordinary settings.
          let next = agent === undefined ? stored : updateAgent(stored, agent);
          if (settings !== undefined || apiKey !== undefined)
            next = updateLegacy(next, parsed.data);
          for (const operation of batch ?? (source ? [source] : []))
            next = await updateSource(
              next,
              operation,
              options.referencedSessions ?? (async () => []),
            );
          if (route) {
            const groups = (next.routeGroups ?? []).filter(
              (group) =>
                group.id !==
                (route.type === "save" ? route.group.id : route.id),
            );
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

// A profile save/remove is one collection entry edit under the same lock and
// transaction as every other setting. Revisions come from a counter that also
// advances on removal, so deleting and re-creating an id cannot resurrect a
// revision an older window still holds.
function updateAgent(
  state: StoredState,
  operation: AgentProfileOperation,
): StoredState {
  const profiles = [...(state.agentProfiles ?? [])];
  const index = profiles.findIndex(
    (profile) =>
      profile.id ===
      (operation.type === "save" ? operation.profile.id : operation.id),
  );
  const existing = index === -1 ? undefined : profiles[index];
  if (operation.type === "remove" && existing === undefined)
    throw new ForgeError("not_found", "未找到该智能体配置，可能已在别处删除。");
  // New profiles must prove they expect "no existing profile" (0); updates must
  // echo the committed revision they were shown.
  if ((existing?.revision ?? 0) !== operation.expectedRevision)
    throw invalid(
      "该智能体配置已被其他窗口或 CLI 修改。请重新加载设置后再保存，避免覆盖对方的改动。",
    );
  const previousRevision = state.agentProfilesRevision ?? 0;
  const revision =
    Math.max(previousRevision, ...profiles.map((profile) => profile.revision)) +
    1;
  if (operation.type === "remove") profiles.splice(index, 1);
  else {
    const saved: AgentProfile = {
      ...operation.profile,
      revision,
    };
    // Only the source id is stored; credentials are never copied into a role.
    // A fixed profile must name an existing source so it can never silently
    // fall back to whatever provider happens to be active.
    const selection = saved.model;
    if (
      selection.mode === "fixed" &&
      !state.sources.some((source) => source.id === selection.providerSourceId)
    )
      throw invalid("智能体配置固定使用的模型来源不存在，请先配置该来源。");
    if (existing === undefined) {
      if (profiles.length >= 64) throw invalid("智能体配置最多 64 个。");
      profiles.push(saved);
    } else profiles[index] = saved;
  }
  return {
    ...state,
    version: 2,
    agentProfiles: profiles,
    agentProfilesRevision: revision,
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
    let credentials =
      operation.credentials?.map((item) => {
        const previous = previousCredentials.find(
          (value) => value.id === item.id && value.type === item.type,
        );
        return {
          ...item,
          ...(item.type === "api-key"
            ? { apiKey: item.apiKey ?? previous?.apiKey ?? "" }
            : { account: item.account ?? previous?.account }),
        };
      }) ?? existing?.credentials;
    const replacementApiKey = operation.apiKey;
    if (credentials && replacementApiKey !== undefined) {
      const id =
        operation.source.activeCredentialId ??
        existing?.activeCredentialId ??
        credentials[0]?.id ??
        "default";
      credentials = credentials.map((item) =>
        item.id === id
          ? {
              ...item,
              type: "api-key" as const,
              apiKey: replacementApiKey,
              account: undefined,
            }
          : item,
      );
    }
    let saved: StoredSource = {
      ...existing,
      ...operation.source,
      ...(credentials === undefined ? {} : { credentials }),
      ...(operation.connection === undefined
        ? {}
        : { connection: { ...existing?.connection, ...operation.connection } }),
      apiKey: operation.apiKey ?? existing?.apiKey ?? "",
      revision: (existing?.revision ?? 0) + 1,
    };
    if (saved.credentials) {
      const selected =
        saved.credentials.find(
          (item) => item.id === saved.activeCredentialId,
        ) ?? saved.credentials.find((item) => item.enabled);
      saved = {
        ...saved,
        apiKey: selected?.type === "api-key" ? (selected.apiKey ?? "") : "",
      };
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
  // A fixed profile names an explicit source. Removing it would silently move
  // that role to another provider, so refuse and let the user decide instead.
  const fixed = (state.agentProfiles ?? []).filter(
    (profile) =>
      profile.model.mode === "fixed" &&
      profile.model.providerSourceId === operation.id,
  );
  if (fixed.length > 0)
    throw invalid(
      `有 ${fixed.length} 个智能体配置固定使用此来源（${fixed
        .slice(0, 5)
        .map((profile) => profile.name)
        .join("、")}）。请先修改或删除这些智能体配置，再删除该模型来源。`,
    );
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
    const { apiMode: _apiMode, ...rest } = state.settings as Record<
      string,
      unknown
    >;
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
    // `apiMode` is optional: dropping it when unset keeps the source exact.
    const { apiMode: _currentApiMode, ...currentWithoutApiMode } = current;
    const synced: StoredSource = {
      ...currentWithoutApiMode,
      baseUrl: baseUrl as string,
      model: (settings.model as string | undefined) ?? "",
      ...(settings.apiMode === undefined
        ? {}
        : { apiMode: settings.apiMode as StoredSource["apiMode"] }),
    };
    const providerChanged =
      input.apiKey !== undefined ||
      ["baseUrl", "model", "apiMode"].some((key) => Object.hasOwn(patch, key));
    const credentials =
      current.credentials && input.apiKey !== undefined
        ? current.credentials.map((item) =>
            item.id ===
            (current.activeCredentialId ?? current.credentials?.[0]?.id)
              ? {
                  ...item,
                  type: "api-key" as const,
                  apiKey,
                  account: undefined,
                }
              : item,
          )
        : current.credentials;
    sources[index] = {
      ...synced,
      apiKey,
      ...(credentials ? { credentials } : {}),
      revision: current.revision + (providerChanged ? 1 : 0),
    };
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
    return {
      ...persistent,
      settings: settings as StoredSettings,
      apiKey,
      sources,
    };
  // A legacy CLI update that sets an endpoint where no source exists yet
  // creates the "default" source so both views stay describable.
  const existing = sources.findIndex((source) => source.id === NEW_SOURCE_ID);
  const created: StoredSource = {
    id: NEW_SOURCE_ID,
    label: sources[existing]?.label ?? NEW_SOURCE_LABEL,
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
