import { createHash } from "node:crypto";
import type { ModelProvider } from "../shared/contracts";
import type { ProviderConfig } from "../shared/schemas";

/** Bind opaque signatures/encrypted items to the actual authenticated principal. */
export function providerStateScope(config: ProviderConfig): string {
  const identity = config.vertex ? ["vertex", config.vertex]
    : config.account?.accountId ? [config.account.platform, config.account.accountId]
    : [config.account?.platform ?? "api-key", config.apiKey];
  const headers = Object.entries(config.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a!.localeCompare(b!));
  return createHash("sha256").update(JSON.stringify([config.baseUrl, config.apiMode, config.sourceId, config.credentialId, identity, config.auth, headers, config.extraBody])).digest("hex");
}

export function scopeProviderState(provider: ModelProvider, config: ProviderConfig): ModelProvider {
  const scope = providerStateScope(config);
  return {
    ...provider,
    async complete(messages, definitions, options) {
      const scoped = messages.map(message => {
        if (message.role !== "assistant" || !message.providerState || message.providerState.credentialScope === scope) return message;
        // Preserve semantic history and tool IDs, not another principal's opaque state.
        const { providerState: _state, ...semantic } = message;
        return semantic;
      });
      const result = await provider.complete(scoped, definitions, options);
      const state = result.message.providerState;
      return state ? { ...result, message: { ...result.message, providerState: { ...state, credentialScope: scope } } } : result;
    },
  };
}
