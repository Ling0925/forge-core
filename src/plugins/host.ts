import type { LocalToolRegistry } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import {
  browserRequestSchema, browserResponseSchema, pluginConfigureInputSchema, pluginHealthSchema,
  pluginIdSchema, pluginManifestSchema, pluginRecordSchema,
  type BrowserRequest, type PluginConfigureInput, type PluginRecord,
} from "../shared/plugins";
import { openPluginStore, type PluginEntry } from "../store/plugins";
import { createCombinedToolRegistry } from "../tools/combined";
import { createBrowserPlugin, type BrowserPluginOptions } from "./browser";
import type { PluginDefinition, PluginScope } from "./types";

export async function createPluginHost(home: string, options: BrowserPluginOptions & {
  readonly definitions?: readonly PluginDefinition[];
} = {}) {
  const store = await openPluginStore(home);
  const definitions = options.definitions ?? [createBrowserPlugin(options)];
  if (definitions.length > 64) throw new ForgeError("invalid_input", "Too many registered plugins.");
  const catalog = new Map<string, PluginDefinition>();
  for (const definition of definitions) {
    const manifest = pluginManifestSchema.parse(definition.manifest);
    if (catalog.has(manifest.id)) throw new ForgeError("invalid_input", "Duplicate plugin id.");
    catalog.set(manifest.id, definition);
  }
  const active = new Set<{ id: string; revision: number; scope: PluginScope }>();
  const diagnostics = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  let closing: Promise<void> | undefined;
  const check = () => { if (shutdown.signal.aborted) throw new ForgeError("cancelled", "Plugin host is closed."); };
  const definitionFor = (id: string) => {
    const definition = catalog.get(pluginIdSchema.parse(id));
    if (!definition) throw new ForgeError("not_found", "Unknown plugin. Only host-registered plugins can be used.");
    return definition;
  };
  const entryFor = async (id: string): Promise<PluginEntry> => {
    const definition = definitionFor(id);
    return await store.get(id) ?? { enabled: false, revision: 0, config: definition.parseConfig({}, false) };
  };
  const record = (id: string, entry: PluginEntry): PluginRecord => {
    const definition = definitionFor(id);
    const activeSessions = [...active].filter(item => item.id === id).reduce((sum, item) => sum + item.scope.sessions().length, 0);
    return pluginRecordSchema.parse({ manifest: definition.manifest, enabled: entry.enabled,
      config: definition.parseConfig(entry.config, entry.enabled), activeSessions,
      status: !entry.enabled ? "disabled" : activeSessions ? "running" : "configured" });
  };
  const disposeScopes = async (items: readonly { scope: PluginScope }[]) => {
    const outcomes = await Promise.allSettled(items.map(item => item.scope.dispose()));
    if (outcomes.some(outcome => outcome.status === "rejected"))
      throw new ForgeError("tool", "Plugin cleanup failed; inspect owned browser processes before starting again.");
  };
  return {
    async list() {
      check();
      return Promise.all([...catalog.keys()].map(async id => record(id, await entryFor(id))));
    },
    async configure(raw: PluginConfigureInput) {
      check();
      const input = pluginConfigureInputSchema.parse(raw);
      const definition = definitionFor(input.pluginId);
      const entry = await store.update(input.pluginId, previous => {
        const enabled = input.enabled ?? previous?.enabled ?? false;
        return { enabled, config: definition.parseConfig(input.config ?? previous?.config ?? {}, enabled) };
      });
      // Revocation happens before returning. Other processes observe the revision on their next call.
      await disposeScopes([...active].filter(item => item.id === input.pluginId && item.revision !== entry.revision));
      return record(input.pluginId, entry);
    },
    async health(id: string) {
      check();
      const definition = definitionFor(id);
      const entry = await entryFor(id);
      check();
      if (diagnostics.size >= 4) throw new ForgeError("busy", "Too many concurrent plugin diagnostics.");
      const operation = definition.check({ home, config: definition.parseConfig(entry.config, false) }, shutdown.signal);
      diagnostics.add(operation);
      try { return pluginHealthSchema.parse(await operation); }
      finally { diagnostics.delete(operation); }
    },
    async createTools(workspace: string, redactValues: readonly string[] = []) {
      check();
      const owned: PluginScope[] = [];
      const enabledIds: string[] = [];
      try {
        for (const [id, definition] of catalog) {
          const entry = await entryFor(id);
          if (!entry.enabled) continue;
          check();
          if (active.size >= 64) throw new ForgeError("busy", "Too many active plugin scopes.");
          let invalid = false;
          const assertCurrent = async () => {
            check();
            const current = await store.get(id);
            if (invalid || !current?.enabled || current.revision !== entry.revision)
              throw new ForgeError("tool", "Plugin configuration changed. Start a new run before using it again.");
          };
          const implementation = await definition.createScope({ home, workspace,
            config: definition.parseConfig(entry.config, true), redactValues, assertCurrent });
          if (active.size >= 64) {
            await implementation.dispose();
            throw new ForgeError("busy", "Too many active plugin scopes.");
          }
          let disposed: Promise<void> | undefined;
          const scope: PluginScope = {
            ...implementation,
            dispose() {
              invalid = true;
              disposed ??= implementation.dispose().finally(() => active.delete(item));
              return disposed;
            },
          };
          const item = { id, revision: entry.revision, scope };
          active.add(item);
          owned.push(scope);
          enabledIds.push(id);
        }
        check();
        const registry: LocalToolRegistry = createCombinedToolRegistry(...owned);
        return { registry, enabledIds, instructions: owned.map(scope => scope.instructions).filter(Boolean).join("\n\n") };
      } catch (error) {
        await Promise.allSettled(owned.map(scope => scope.dispose()));
        throw error;
      }
    },
    async browser(raw: BrowserRequest) {
      check();
      const input = browserRequestSchema.parse(raw);
      const matches = [...active].filter(item => item.id === "browser" && item.scope.sessions().includes(input.sessionId));
      if (matches.length > 1) throw new ForgeError("busy", "Multiple browser owners for this session.");
      const scope = matches[0]?.scope;
      if (!scope?.browser) {
        if (input.action !== "status") throw new ForgeError("not_found", "No active browser for this session. The agent must open it in an active run first.");
        return browserResponseSchema.parse({ sessionId: input.sessionId, available: false, takeover: false });
      }
      return browserResponseSchema.parse(await scope.browser(input));
    },
    dispose() {
      if (closing) return closing;
      shutdown.abort();
      closing = (async () => {
        try { await disposeScopes([...active]); }
        finally { await Promise.allSettled([...diagnostics]); }
      })();
      return closing;
    },
  };
}
