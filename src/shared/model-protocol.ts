import type { ProviderProtocol } from "./model-access";

// Minimal provider-source shape shared by stored, public and legacy sources.
// Only request routing reads these fields; catalog capability metadata is not
// consulted here.
export type ModelProtocolSource = Readonly<{
  apiMode?: ProviderProtocol | undefined;
  endpoints?: Readonly<Partial<Record<ProviderProtocol, string | undefined>>> | undefined;
  baseUrl?: string | undefined;
  modelAliases?: Readonly<Record<string, string>> | undefined;
  modelSelection?: Readonly<{
    overrides?: Readonly<Record<string, Readonly<{ apiMode?: ProviderProtocol | undefined }>>> | undefined;
  }> | undefined;
}>;

/**
 * Explicit per-model protocol: selected alias override > wire model override.
 * Omission inherits the source protocol, so deleting only apiMode from an alias
 * override restores the wire/source route.
 */
export function modelProtocolOverride(
  source: ModelProtocolSource | undefined,
  model: string | undefined,
): ProviderProtocol | undefined {
  if (!source || model === undefined) return undefined;
  const overrides = source.modelSelection?.overrides;
  const selected = overrides?.[model]?.apiMode;
  if (selected !== undefined) return selected;
  const wire = source.modelAliases?.[model];
  return wire === undefined ? undefined : overrides?.[wire]?.apiMode;
}

/** Effective protocol for one request; omitted overrides inherit the source. */
export function modelProtocol(
  source: ModelProtocolSource | undefined,
  model: string | undefined,
): ProviderProtocol {
  return modelProtocolOverride(source, model) ?? source?.apiMode ?? "chat-completions";
}

/**
 * Per-protocol endpoint for plain gateway sources. Account and Vertex adapters
 * own their endpoint/protocol pair and must not use this result.
 */
export function modelProtocolEndpoint(
  source: Pick<ModelProtocolSource, "endpoints" | "baseUrl"> | undefined,
  protocol: ProviderProtocol,
): string | undefined {
  return source?.endpoints?.[protocol] ?? source?.baseUrl;
}

/**
 * Protocol fixed by an exclusive adapter. Copilot remains dynamic because its
 * account catalog decides the adapter per model; request-time compatibility is
 * checked against the account provider configuration instead.
 */
export function exclusiveModelProtocol(
  source: Readonly<{ vertex?: boolean }> | undefined,
  accountPlatform?: "codex" | "copilot",
): ProviderProtocol | undefined {
  if (source?.vertex) return "gemini";
  if (accountPlatform === "codex") return "responses";
  return undefined;
}

/**
 * Account platforms own the per-model adapter. Equality with the selected mode
 * is necessary, and when the account advertised this model's protocols the
 * override must be one of them (Copilot can use different adapters per model).
 */
export function accountProtocolCompatible(
  requested: ProviderProtocol | undefined,
  account: Readonly<{ apiMode: ProviderProtocol; protocols?: readonly ProviderProtocol[] | undefined }>,
): boolean {
  return requested === undefined
    || (requested === account.apiMode && (!account.protocols?.length || account.protocols.includes(requested)));
}
