import type { AgentRuntimeDependencies } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { PublicProviderSource, PublicSettings } from "../shared/schemas";

type Selection = { id: string; providerSourceId?: string };
const check = (signal: AbortSignal) => {
  if (signal.aborted)
    throw new ForgeError("cancelled", "Model discovery cancelled.");
};
function declaredModels(source: PublicProviderSource): string[] {
  return [
    ...new Set([
      source.model,
      ...(source.modelSelection?.models ?? []),
      ...(source.modelSelection?.manual ?? []).map((model) => model.id),
      ...Object.keys(source.modelSelection?.overrides ?? {}),
      ...Object.keys(source.modelAliases ?? {}),
    ]),
  ].filter(Boolean);
}
function visibleModels(
  source: PublicProviderSource,
  ids: readonly string[],
): string[] {
  const selection = source.modelSelection;
  if (selection?.mode === "none") return [];
  return [...new Set(ids)].filter(
    (id) => selection?.mode !== "selected" || selection.models?.includes(id),
  );
}

/** Model IDs are opaque. A colon/slash is not a source qualifier and is never stripped. */
export function createDelegationModels(options: {
  getSettings(): Promise<PublicSettings>;
  listModels(
    sourceId: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
}): NonNullable<AgentRuntimeDependencies["delegationModels"]> {
  async function discover(
    settings: PublicSettings,
    signal: AbortSignal,
    sourceId?: string,
  ) {
    check(signal);
    const sources = settings.providerSources ?? [];
    if (sourceId && !sources.some((source) => source.id === sourceId))
      throw new ForgeError(
        "invalid_input",
        "Unknown providerSourceId. Discover configured sources with list_models; no child was started.",
      );
    if (!sources.length)
      return {
        models: (await options.listModels(undefined, signal)).map(
          (id) => ({ id }) as Selection,
        ),
        unavailableSourceIds: [],
      };
    const selected = sourceId
      ? sources.filter((source) => source.id === sourceId)
      : sources;
    // Bound concurrent catalog reads; one unavailable source must not hide healthy ones.
    const pages: { models: Selection[]; unavailableSourceIds: string[] }[] =
      new Array(selected.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, selected.length) }, async () => {
        for (;;) {
          const index = next++;
          const source = selected[index];
          if (!source) return;
          check(signal);
          let ids = declaredModels(source);
          let unavailable = false;
          try {
            ids = [...ids, ...(await options.listModels(source.id, signal))];
          } catch {
            check(signal);
            unavailable = true;
          }
          check(signal);
          pages[index] = {
            models: visibleModels(source, ids).map((id) => ({
              id,
              providerSourceId: source.id,
            })),
            unavailableSourceIds: unavailable ? [source.id] : [],
          };
        }
      }),
    );
    return {
      models: pages.flatMap((page) => page.models),
      unavailableSourceIds: pages.flatMap((page) => page.unavailableSourceIds),
    };
  }
  const ambiguous = () =>
    new ForgeError(
      "invalid_input",
      "The model belongs to multiple configured sources. Use list_models and pass providerSourceId with the exact model ID; no child was started.",
    );
  return {
    async list(signal, sourceId) {
      return discover(await options.getSettings(), signal, sourceId);
    },
    async resolve(model, sourceId, signal) {
      check(signal);
      const settings = await options.getSettings();
      check(signal);
      const sources = settings.providerSources ?? [];
      if (sourceId) {
        if (!sources.some((source) => source.id === sourceId))
          throw new ForgeError(
            "invalid_input",
            "Unknown providerSourceId. Rediscover sources before spawning; no child was started.",
          );
        // An explicit source/model pair is usable even if discovery is unavailable or filtered.
        return sourceId;
      }
      if (!sources.length) return undefined; // Embedded/environment-only provider, no source registry.
      // User-configured model declarations are authoritative routing hints, not availability claims.
      const declared = sources.filter((source) =>
        declaredModels(source).includes(model),
      );
      if (declared.length > 1) throw ambiguous();
      if (declared.length === 1) return declared[0]?.id;
      const catalog = await discover(settings, signal);
      const owners = [
        ...new Set(
          catalog.models
            .filter((entry) => entry.id === model)
            .flatMap((entry) =>
              entry.providerSourceId ? [entry.providerSourceId] : [],
            ),
        ),
      ];
      if (owners.length > 1) throw ambiguous();
      if (catalog.unavailableSourceIds.length)
        throw new ForgeError(
          "invalid_input",
          "Model discovery is incomplete. Pass an explicitly known providerSourceId and exact model ID; the parent provider was not used as a fallback and no child was started.",
        );
      if (owners.length === 1) return owners[0];
      throw new ForgeError(
        "invalid_input",
        "The exact model ID was not found in configured sources. Use list_models, or pass an explicitly known providerSourceId for an unlisted model; no child was started.",
      );
    },
  };
}
