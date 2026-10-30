import type { LocalToolRegistry } from "../shared/contracts";
import type {
  BrowserRequest,
  BrowserResponse,
  PluginHealth,
  PluginManifest,
} from "../shared/plugins";
import type { JsonValue, SessionId } from "../shared/schemas";

export type PluginConfig = Readonly<Record<string, JsonValue>>;
export interface PluginScope extends LocalToolRegistry {
  readonly instructions: string;
  sessions(): readonly SessionId[];
  browser?(input: BrowserRequest): Promise<BrowserResponse>;
}
export interface PluginScopeOptions {
  readonly home: string;
  readonly workspace: string;
  readonly config: PluginConfig;
  readonly redactValues: readonly string[];
  /** Rechecked before effects, including after approval and manual-control waits. */
  readonly assertCurrent: () => Promise<void>;
}
/** First-party definitions are registered by the host, never imported from a project. */
export interface PluginDefinition {
  readonly manifest: PluginManifest;
  parseConfig(value: unknown, enabled: boolean): PluginConfig;
  createScope(options: PluginScopeOptions): Promise<PluginScope>;
  check(
    options: Pick<PluginScopeOptions, "home" | "config">,
    signal: AbortSignal,
  ): Promise<PluginHealth>;
}
