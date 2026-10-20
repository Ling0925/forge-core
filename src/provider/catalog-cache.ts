import type { ModelProvider, ProviderFactory } from "../shared/contracts";
import type { ProviderConfig } from "../shared/schemas";
import { modelCatalogCacheKey, type ModelCatalogStore } from "../store/model-catalog";

/** Shared by CLI, desktop, runtime metadata and the list_models agent tool. */
export function createCachedProviderFactory(store: ModelCatalogStore, factory: ProviderFactory) {
  return (config: ProviderConfig, sourceId?: string): ModelProvider => {
    const provider = factory(config);
    const key = modelCatalogCacheKey(config, sourceId);
    const load = (signal?: AbortSignal, refresh = false) => store.load(key,
      async requestSignal => provider.listModelCatalog
        ? provider.listModelCatalog(requestSignal)
        : (await provider.listModels(requestSignal)).map(id => ({ id, contextWindowTokens: null })),
      signal, refresh);
    return {
      ...(provider.apiMode ? { apiMode: provider.apiMode } : {}),
      listModels: async (signal, refresh) => (await load(signal, refresh)).map(model => model.id),
      ...(provider.listModelCatalog ? {
        listModelCatalog: (signal?: AbortSignal) => load(signal),
        getModelContextWindow: async (model: string, signal?: AbortSignal) =>
          (await load(signal)).find(entry => entry.id === model)?.contextWindowTokens ?? null,
      } : provider.getModelContextWindow ? {
        // Hosts can inject independent metadata lookup without a full catalog.
        getModelContextWindow: (model: string, signal?: AbortSignal) => provider.getModelContextWindow!(model, signal),
      } : {}),
      complete: (messages, definitions, options) => provider.complete(messages, definitions, options),
    };
  };
}
