import { createHash } from "node:crypto";
import type { RunControl } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import {
  modelProtocol,
  modelProtocolEndpoint,
  modelProtocolOverride,
} from "../shared/model-protocol";
import type { PublicSettings, SessionSnapshot } from "../shared/schemas";
import type { openSettingsStore } from "../store/settings";
import { inputProviderBinding } from "./input-queue";
import type { createModelAccessService } from "./model-access";

type SettingsStore = Awaited<ReturnType<typeof openSettingsStore>>;
type SelectionValidator = Parameters<
  ReturnType<typeof createModelAccessService>["resolveProvider"]
>[4];
type RouteGroup = NonNullable<PublicSettings["routeGroups"]>[number];

/**
 * A model name is the user's real choice, and each source publishes its own
 * models, so the source follows the model when it is unambiguous. Returns
 * undefined when nothing identifies a source; callers then fall back.
 */
export function inferSourceId(
  settings: PublicSettings,
  model: string | undefined,
): string | undefined {
  if (model === undefined || model === "") return undefined;
  const owners = (settings.providerSources ?? []).filter(
    (source) => source.model === model,
  );
  return owners.length === 1 ? owners[0]?.id : undefined;
}

/**
 * The one source-priority rule for runs, queued inputs and compaction. An
 * explicit selection (the picked model's source) wins; a session keeps the
 * source it was created with; only when neither exists does the model, and
 * finally the remembered active source, decide. A session's route group
 * applies only while the caller names neither a model nor a source.
 */
export function selectSessionSource(
  settings: PublicSettings,
  snapshot: Pick<SessionSnapshot, "providerSourceId" | "routeGroupId">,
  input: Readonly<{
    providerSourceId?: string | undefined;
    routeGroupId?: string | undefined;
    model?: string | undefined;
  }> = {},
): { providerSourceId: string | undefined; routeGroupId: string | undefined } {
  return {
    providerSourceId:
      input.providerSourceId ??
      snapshot.providerSourceId ??
      inferSourceId(settings, input.model) ??
      settings.activeSourceId,
    routeGroupId:
      input.routeGroupId ??
      (input.model !== undefined || input.providerSourceId !== undefined
        ? undefined
        : snapshot.routeGroupId),
  };
}

/** A configured route group by ID; a stale ID fails instead of falling back. */
export function findRouteGroup(
  settings: PublicSettings,
  routeGroupId: string | undefined,
): RouteGroup | undefined {
  if (!routeGroupId) return undefined;
  const group = settings.routeGroups?.find((item) => item.id === routeGroupId);
  if (!group)
    throw new ForgeError("not_found", "会话的路由组已不可用，请重新选择。");
  return group;
}

export const assertProviderEndpoint = (baseUrl: string): void => {
  if (!baseUrl)
    throw new ForgeError(
      "invalid_input",
      "Configure a provider endpoint before continuing.",
    );
};

/** Source defaults and queue bindings that read the harness settings store. */
export const createProviderSelection = (settingsStore: SettingsStore) => {
  // Without an explicit source, use the active one unless the environment
  // overrides the provider configuration.
  const defaultSourceId = async (requested: string | undefined) => {
    if (requested !== undefined) return requested;
    const settings = await settingsStore.getPublic();
    return settings.environmentOverride ? undefined : settings.activeSourceId;
  };
  /**
   * The "active" source is only the fallback for callers that name no source.
   * Whenever a caller does name one, remember it, so selecting a model in any
   * client automatically keeps that source for the next run.
   */
  const rememberSource = async (
    sourceId: string | undefined,
  ): Promise<void> => {
    if (!sourceId) return;
    const current = await settingsStore.getPublic();
    if (current.activeSourceId === sourceId) return;
    try {
      await settingsStore.update({
        source: { type: "activate", id: sourceId },
      });
    } catch {
      // Remembering the fallback is best-effort: the run already resolved its
      // own source explicitly and must not fail because of this.
    }
  };
  // Bind configured selection, not resolved account tokens or normalized cloud URLs.
  // Route members can be temporarily unavailable; admission must not turn a valid
  // fallback group into a direct request to its first member.
  const queueProviderBinding = async (
    settings: PublicSettings,
    model: string,
    sourceId?: string,
    routeGroupId?: string,
  ) => {
    const group = findRouteGroup(settings, routeGroupId);
    if (group) {
      const members = group.members.map((member) => {
        const source = settings.providerSources?.find(
          (item) => item.id === member.sourceId,
        );
        return [
          member.sourceId,
          member.credentialId ?? null,
          member.enabled ?? true,
          modelProtocolEndpoint(source, modelProtocol(source, member.model)) ??
            null,
          modelProtocolOverride(source, member.model) ??
            source?.apiMode ??
            null,
          source?.modelAliases?.[member.model] ?? member.model,
        ];
      });
      return createHash("sha256")
        .update(
          JSON.stringify([
            group.id,
            group.strategy,
            group.sticky ?? false,
            members,
          ]),
        )
        .digest("hex");
    }
    const config = await settingsStore.getProviderConfig(
      sourceId,
      undefined,
      model,
    );
    assertProviderEndpoint(config.baseUrl);
    const source = settings.providerSources?.find(
      (item) => item.id === sourceId,
    );
    return inputProviderBinding(
      config,
      source?.modelAliases?.[model] ?? model,
      sourceId,
    );
  };
  return { defaultSourceId, rememberSource, queueProviderBinding };
};

/**
 * The route a run actually uses: its explicit group, or a credential rotation
 * group when a direct source has several enabled credentials.
 */
export const selectRouteGroup = (
  settings: PublicSettings,
  providerSourceId: string | undefined,
  requestedModel: string,
  group: RouteGroup | undefined,
) => {
  const directSource = settings.providerSources?.find(
    (source) => source.id === providerSourceId,
  );
  const credentials = directSource?.credentials?.filter((item) => item.enabled);
  // Direct selections rotate only their explicitly configured credentials.
  return (
    group ??
    (credentials && credentials.length > 1 && directSource
      ? {
          id: `credentials:${directSource.id}`,
          label: directSource.label,
          strategy: directSource.credentialRouting ?? "order",
          sticky: directSource.sticky,
          members: credentials.map((credential) => ({
            sourceId: directSource.id,
            model: requestedModel,
            credentialId: credential.id,
          })),
        }
      : undefined)
  );
};

/**
 * A queued input replays only against the provider selection it was admitted
 * with; without a queue binding there is nothing to validate.
 */
export const queuedSelectionValidator = (
  control: RunControl | undefined,
  settings: PublicSettings,
  requestedModel: string,
  providerSourceId: string | undefined,
  routeGroupId: string | undefined,
): SelectionValidator => {
  return control?.providerBinding
    ? (config, source, model) => {
        const selectedModel = model ?? requestedModel;
        const actual = inputProviderBinding(
          config,
          source?.modelAliases?.[selectedModel] ?? selectedModel,
          config.sourceId ?? providerSourceId,
        );
        let expected = control.providerBinding;
        if (routeGroupId) {
          const acceptedSource = settings.providerSources?.find(
            (item) => item.id === config.sourceId,
          );
          if (!acceptedSource)
            throw new ForgeError(
              "invalid_input",
              "The queued route source is no longer available.",
            );
          expected = inputProviderBinding(
            {
              ...config,
              baseUrl:
                modelProtocolEndpoint(
                  acceptedSource,
                  modelProtocol(acceptedSource, selectedModel),
                ) ?? acceptedSource.baseUrl,
              apiMode:
                modelProtocolOverride(acceptedSource, selectedModel) ??
                acceptedSource.apiMode,
            },
            acceptedSource.modelAliases?.[selectedModel] ?? selectedModel,
            acceptedSource.id,
          );
        }
        if (actual !== expected)
          throw new ForgeError(
            "invalid_input",
            "The queued provider selection changed before execution. Nothing was replayed.",
          );
      }
    : undefined;
};
