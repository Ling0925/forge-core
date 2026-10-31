import { join } from "node:path";
import type { SettingsStore } from "../shared/contracts";
import { accountTokensSchema } from "../shared/model-access";
import { modelProtocol } from "../shared/model-protocol";
import { atomicJson, privateDirectory, readJson, storageError } from "./io";
import { createSettingsProvider } from "./settings-provider";
import {
  type StoredState,
  TRANSACTION_LIMIT,
  configSchema,
  credentialSchema,
  transactionSchema,
} from "./settings-schema";
import {
  hasExtendedState,
  invalid,
  optionalRecord,
  seedFromLegacy,
  selectedCredential,
  settingsLock,
  sourceCredentials,
  unknownSource,
  validateReferences,
} from "./settings-state";
import { createSettingsUpdates } from "./settings-updates";

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
    version: hasExtendedState(state) ? (2 as const) : (1 as const),
    settings: state.settings,
    apiKey: state.apiKey,
    sources: [...state.sources],
    ...(state.routeGroups === undefined
      ? {}
      : { routeGroups: state.routeGroups }),
    ...(state.agentProfiles === undefined
      ? {}
      : { agentProfiles: state.agentProfiles }),
    ...(state.agentProfilesRevision === undefined
      ? {}
      : { agentProfilesRevision: state.agentProfilesRevision }),
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
        if ((await optionalRecord(backup, TRANSACTION_LIMIT)) === undefined)
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
      ...(parsed.data.routeGroups === undefined
        ? {}
        : { routeGroups: parsed.data.routeGroups }),
      ...(parsed.data.agentProfiles === undefined
        ? {}
        : { agentProfiles: parsed.data.agentProfiles }),
      ...(parsed.data.agentProfilesRevision === undefined
        ? {}
        : { agentProfilesRevision: parsed.data.agentProfilesRevision }),
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
    try {
      validateReferences(state);
    } catch {
      throw storageError();
    }
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
      )
        await commitState(seedFromLegacy(stored));
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
  const provider = createSettingsProvider({ load });
  const { effective, providerSnapshot } = provider;
  await locked(initialize);
  const { update } = createSettingsUpdates({
    locked,
    load,
    commitAll,
    provider,
    options,
  });
  return {
    async getPublic() {
      return (await effective()).public;
    },
    getProviderSnapshot: providerSnapshot,
    async getProviderConfig(sourceId, credentialId, model) {
      const snapshot = await providerSnapshot(sourceId, credentialId, model);
      if (snapshot.source && !snapshot.source.credentials) {
        // Preserve the legacy private-config shape for older injected hosts.
        const {
          sourceId: _id,
          sourceRevision: _revision,
          credentialId: _credential,
          ...legacy
        } = snapshot.config;
        return legacy;
      }
      return snapshot.config;
    },
    async refreshAccount(sourceId, credentialId, refresh, model) {
      await locked(async () => {
        const state = await load();
        const source = state.sources.find((item) => item.id === sourceId);
        if (!source) throw unknownSource();
        const credential = selectedCredential(
          source,
          credentialId,
          modelProtocol(source, model),
        );
        if (!credential.account) throw invalid("未找到订阅账号。");
        if (
          credential.account.expiresAt === undefined ||
          credential.account.expiresAt > Date.now() + 30_000
        )
          return;
        // The same cross-process lock spans token rotation and commit. Another
        // reader rechecks expiry after acquiring it instead of reusing a stale token.
        const account = accountTokensSchema.parse(
          await refresh(credential.account),
        );
        const saved = {
          ...source,
          revision: source.revision + 1,
          credentials: sourceCredentials(source).map((item) =>
            item.id === credentialId ? { ...item, account } : item,
          ),
        };
        await commitAll({
          ...state,
          version: 2,
          sources: state.sources.map((item) =>
            item.id === sourceId ? saved : item,
          ),
        });
      });
      return (await providerSnapshot(sourceId, credentialId, model)).config;
    },
    update,
  };
}
