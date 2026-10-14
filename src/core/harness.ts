import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createProjectContext } from "../context/index";
import { createMcpService } from "../mcp/registry";
import { createModelProvider } from "../provider/openai";
import type {
  HarnessOptions,
  HarnessService,
  LocalToolRegistry,
} from "../shared/contracts";
import { resolveContextWindow } from "../shared/context-usage";
import { ForgeError } from "../shared/errors";
import {
  configureInputSchema,
  createSessionInputSchema,
  providerConfigSchema,
  runInputSchema,
  sessionIdSchema,
  sessionTitleSchema,
  settingsFields,
} from "../shared/schemas";
import type {
  PublicSettings,
  SessionId,
  SessionSnapshot,
} from "../shared/schemas";
import { createCheckpointStore } from "../store/checkpoints";
import { openSessionStore } from "../store/sessions";
import { openSettingsStore } from "../store/settings";
import { createCombinedToolRegistry } from "../tools/combined";
import { createLocalToolRegistry } from "../tools/local";
import { createMcpToolRegistry } from "../tools/mcp";
import { createSkillTool } from "../tools/skills";
import { assertBoundary, projectSummary, summarize } from "./context";
import { autoTitle } from "./session-title";
import { createAgentRuntime, withCancellation } from "./runtime";

// Default per-run tools: local registry with configured-key redaction, plus a
// browser registry only when exact allowed origins are configured. Chromium is
// launched lazily by the browser registry on first actual browser tool use;
// the browser module itself is loaded lazily so local-only hosts work without
// Playwright installed. Custom injected tool factories keep exact behavior.
const createDefaultTools = async (
  workspace: string,
  settings: PublicSettings,
  apiKey: string,
  checkpointDirectory: string,
  stateDirectory: string,
  mcp: Awaited<ReturnType<typeof createMcpService>>,
): Promise<LocalToolRegistry> => {
  const registries: LocalToolRegistry[] = [];
  try {
    const local = await createLocalToolRegistry(workspace, {
      redactValues: [apiKey],
      protectedRoots: [stateDirectory],
      checkpointStore: await createCheckpointStore(
        workspace,
        checkpointDirectory,
        { protectedStateRoot: stateDirectory },
      ),
    });
    registries.push(local);
    registries.push(
      await createMcpToolRegistry(mcp, { redactValues: [apiKey] }),
    );
    if (settings.browserAllowedOrigins.length === 0)
      return createCombinedToolRegistry(...registries);
    const { createBrowserToolRegistry } = await import("../tools/browser");
    registries.push(
      await createBrowserToolRegistry({
        allowedOrigins: settings.browserAllowedOrigins,
        protectedRoots: [stateDirectory],
        ...(settings.browserExecutablePath !== ""
          ? { executablePath: settings.browserExecutablePath }
          : {}),
        headless: true,
        redactValues: [apiKey],
      }),
    );
    return createCombinedToolRegistry(...registries);
  } catch (error) {
    await Promise.allSettled(registries.map((registry) => registry.dispose()));
    throw error;
  }
};

export const createHarness = async (
  options: HarnessOptions = {},
): Promise<HarnessService> => {
  const directory = resolve(
    options.stateDir ??
      process.env.FORGE_HOME ??
      join(homedir(), ".local", "share", "forge"),
  );
  const [store, settingsStore] = await Promise.all([
    openSessionStore(directory),
    openSettingsStore(directory),
  ]);
  const mcp = await createMcpService({ home: directory });
  const liveMcp = new Set<Awaited<ReturnType<typeof createMcpService>>>();
  const buildTools = async (
    workspace: string,
    settings: PublicSettings,
    apiKey: string,
  ) => {
    let local: LocalToolRegistry | undefined;
    let context: Awaited<ReturnType<typeof createProjectContext>> | undefined;
    let service: Awaited<ReturnType<typeof createMcpService>> | undefined;
    try {
      if (options.toolFactory) local = await options.toolFactory(workspace);
      else {
        if (liveMcp.size >= 64)
          throw new ForgeError("busy", "Too many active tool services");
        service = await createMcpService({ home: directory });
        liveMcp.add(service);
        local = await createDefaultTools(
          workspace,
          settings,
          apiKey,
          join(
            directory,
            "checkpoints",
            createHash("sha256").update(workspace).digest("hex"),
          ),
          directory,
          service,
        );
      }
      context = await createProjectContext(workspace, {
        protectedRoots: [directory],
      });
      await context.refresh();
      const combined = createCombinedToolRegistry(
        local,
        createSkillTool(context),
      );
      const ownedService = service;
      const ownedContext = context;
      return {
        instructions: context.getSystemContext(),
        tools: {
          definitions: combined.definitions,
          execute: combined.execute,
          async dispose() {
            try {
              await combined.dispose();
            } finally {
              try {
                await ownedContext.dispose();
              } finally {
                if (ownedService) {
                  liveMcp.delete(ownedService);
                  await ownedService.dispose();
                }
              }
            }
          },
        } satisfies LocalToolRegistry,
      };
    } catch (error) {
      await Promise.allSettled([
        local?.dispose(),
        context?.dispose(),
        service?.dispose(),
      ]);
      if (service) liveMcp.delete(service);
      throw error;
    }
  };
  const checkpointFor = async (id: SessionId) => {
    const s = await store.get(id);
    return createCheckpointStore(
      s.workspace,
      join(
        directory,
        "checkpoints",
        createHash("sha256").update(s.workspace).digest("hex"),
      ),
      { protectedStateRoot: directory },
    );
  };
  const providerFactory = options.providerFactory ?? createModelProvider;
  const disposal = new AbortController();
  const active = new Map<SessionId, Promise<SessionSnapshot>>();
  const controls = new Map<
    SessionId,
    { controller: AbortController; work: Promise<unknown> }
  >();
  const track = (
    id: SessionId,
    controller: AbortController,
    work: Promise<unknown>,
  ) => {
    const owned = { controller, work };
    controls.set(id, owned);
    void work
      .finally(() => {
        if (controls.get(id) === owned) controls.delete(id);
      })
      .catch(() => undefined);
  };
  const titleTasks = new Set<Promise<void>>();
  const titleOperations = new Map<SessionId, { controller: AbortController; work: Promise<void> }>();
  const stopTitle = async (id: SessionId) => {
    const pending = titleOperations.get(id);
    if (pending) { pending.controller.abort(); await pending.work; }
  };
  let disposed = false;
  let closing: Promise<void> | undefined;
  const check = (): void => {
    if (disposed) throw new ForgeError("cancelled", "Harness is disposed.");
  };
  const endpoint = (baseUrl: string): void => {
    if (!baseUrl)
      throw new ForgeError(
        "invalid_input",
        "Configure a provider endpoint before continuing.",
      );
  };
  const mutate = async (
    id: SessionId,
    fn: (s: SessionSnapshot) => Promise<SessionSnapshot>,
  ): Promise<SessionSnapshot> => {
    check();
    await stopTitle(id);
    const release = await store.acquire(sessionIdSchema.parse(id));
    try {
      const next = await fn(await store.get(id));
      await store.save(next);
      return next;
    } finally {
      await release();
    }
  };
  return {
    async cancelSession(rawId) {
      const id = sessionIdSchema.parse(rawId);
      const owned = controls.get(id);
      if (!owned) return false;
      owned.controller.abort();
      await Promise.allSettled([owned.work]);
      return true;
    },
    compactSession(rawId, callerSignal) {
      check();
      const id = sessionIdSchema.parse(rawId);
      if (controls.has(id))
        return Promise.reject(
          new ForgeError("busy", "Session has an owned operation"),
        );
      const controller = new AbortController();
      const work = mutate(id, async (s) => {
        const signal = AbortSignal.any([
          disposal.signal,
          controller.signal,
          ...(callerSignal ? [callerSignal] : []),
        ]);
        const config = providerConfigSchema.parse(
          await settingsStore.getProviderConfig(),
        );
        const provider = providerFactory(config);
        const settings = await settingsStore.getPublic();
        let reported: number | null = null;
        const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
        try { reported = await withCancellation(provider.getModelContextWindow?.(s.model, metadataSignal) ?? Promise.resolve(null), metadataSignal); }
        catch { /* Optional metadata must not prevent compaction. */ }
        const window = resolveContextWindow(s.model, settings, reported);
        return summarize(s, provider, signal, s.messages.length, window ? Math.floor(window * 0.8) : 32000);
      });
      track(id, controller, work);
      return work;
    },
    async forkSession(id, boundary) {
      check();
      await stopTitle(id);
      const release = await store.acquire(sessionIdSchema.parse(id));
      try {
        const source = await store.get(id);
        const end = boundary ?? source.messages.length;
        assertBoundary(source.messages, end);
        let contextSummary: SessionSnapshot["contextSummary"];
        if (source.contextSummary && source.contextSummary.boundary <= end) {
          try {
            assertBoundary(source.messages, source.contextSummary.boundary);
            contextSummary = source.contextSummary;
          } catch {
            // Do not propagate stale memory whose boundary splits native calls.
          }
        }
        const fork = await store.create({
          workspace: source.workspace,
          title: `Fork: ${source.title}`.slice(0, 256),
          model: source.model,
        });
        const next = {
          ...fork,
          messages: source.messages.slice(0, end),
          ...(contextSummary ? { contextSummary } : {}),
          plan: source.plan,
          permissionCeiling: source.permissionCeiling,
          parentSessionId: source.parentSessionId,
          agentTask: source.agentTask,
          ownership: source.ownership,
          forkedFrom: id,
        };
        await store.save(next);
        return next;
      } finally {
        await release();
      }
    },
    renameSession(id, title) {
      return mutate(id, async (s) => ({
        ...s,
        title: sessionTitleSchema.parse(title),
        titleSource: "user",
      }));
    },
    archiveSession(id, archived) {
      return mutate(id, async (s) => ({ ...s, archived }));
    },
    async getDiagnostics(id) {
      check();
      const s = await store.get(sessionIdSchema.parse(id));
      return {
        transcriptChars: JSON.stringify(s.messages).length,
        projectedChars: JSON.stringify(projectSummary(s)).length,
        messageCount: s.messages.length,
        summaryFallback: s.contextSummary?.fallback ?? false,
      };
    },
    async getProjectContext(id) {
      check();
      const s = await store.get(id);
      const ctx = await createProjectContext(s.workspace, {
        protectedRoots: [directory],
      });
      try {
        await ctx.refresh();
        return ctx.getCatalog();
      } finally {
        await ctx.dispose();
      }
    },
    listMcpServers() {
      check();
      return mcp.list();
    },
    registerMcpServer(input) {
      check();
      return mcp.register(input);
    },
    async setMcpEnabled(id, enabled) {
      check();
      const result = await mcp.setEnabled(id, enabled);
      if (!enabled)
        await Promise.all([...liveMcp].map((service) => service.revoke(id)));
      return result;
    },
    async removeMcpServer(id) {
      check();
      const result = await mcp.remove(id);
      await Promise.all([...liveMcp].map((service) => service.revoke(id)));
      return result;
    },
    getMcpHealth(id) {
      check();
      return mcp.health(id);
    },
    async listCheckpoints(id) {
      check();
      return (await (await checkpointFor(id)).list()).filter(
        (c) => c.sessionId === id,
      );
    },
    async getCheckpointDiff(id, checkpointId) {
      check();
      const cp = await checkpointFor(id);
      if (
        !(await cp.list()).some(
          (c) => c.id === checkpointId && c.sessionId === id,
        )
      )
        throw new ForgeError("not_found", "Checkpoint not found");
      return cp.getDiff(checkpointId);
    },
    async restoreCheckpoint(id, checkpointId) {
      return mutate(id, async (s) => {
        const cp = await checkpointFor(id);
        if (
          !(await cp.list()).some(
            (c) => c.id === checkpointId && c.sessionId === id,
          )
        )
          throw new ForgeError("not_found", "Checkpoint not found");
        await cp.restore(checkpointId, {
          isSessionActive: async (session) =>
            active.has(sessionIdSchema.parse(session)),
        });
        return s;
      });
    },
    async getSettings() {
      check();
      return settingsStore.getPublic();
    },
    async updateSettings(input) {
      check();
      return settingsStore.update(configureInputSchema.parse(input));
    },
    async getModelContextWindow(model, signal) {
      check();
      const settings = await settingsStore.getPublic();
      endpoint(settings.baseUrl);
      const config = providerConfigSchema.parse(await settingsStore.getProviderConfig());
      check();
      return await providerFactory(config).getModelContextWindow?.(model,
        AbortSignal.any(signal ? [signal, disposal.signal] : [disposal.signal])) ?? null;
    },
    async listModels(signal) {
      check();
      const settings = await settingsStore.getPublic();
      endpoint(settings.baseUrl);
      const config = providerConfigSchema.parse(
        await settingsStore.getProviderConfig(),
      );
      check();
      return providerFactory(config).listModels(
        AbortSignal.any(signal ? [signal, disposal.signal] : [disposal.signal]),
      );
    },
    async listSessions() {
      check();
      return store.list();
    },
    async getSession(id) {
      check();
      return store.get(sessionIdSchema.parse(id));
    },
    async createSession(raw) {
      check();
      const input = createSessionInputSchema.parse(raw);
      const settings = await settingsStore.getPublic();
      const model = input.model ?? settings.model;
      if (!model)
        throw new ForgeError(
          "invalid_input",
          "Select a model before creating a session.",
        );
      const workspace = resolve(input.workspace);
      if (!isAbsolute(workspace))
        throw new ForgeError(
          "invalid_input",
          "Workspace must be an absolute directory.",
        );
      try {
        if (!(await stat(workspace)).isDirectory())
          throw new ForgeError(
            "invalid_input",
            "Workspace must be an existing directory.",
          );
      } catch {
        throw new ForgeError(
          "invalid_input",
          "Workspace must be an existing directory.",
        );
      }
      check();
      return store.create({
        workspace,
        title: input.title ?? "New session",
        titleSource: input.title === undefined ? "default" : "user",
        model: settingsFields.model.parse(model),
      });
    },
    run(raw, onEvent, approve, callerSignal, control) {
      check();
      const input = runInputSchema.parse(raw);
      if (controls.has(input.sessionId))
        return Promise.reject(
          new ForgeError(
            "busy",
            "This session already has an active run.",
            true,
          ),
        );
      const controller = new AbortController();
      const signal = AbortSignal.any([
        callerSignal,
        disposal.signal,
        controller.signal,
      ]);
      // Defer work so the reservation exists before the first asynchronous boundary.
      const operation = Promise.resolve().then(async () => {
        let tools: LocalToolRegistry | undefined;
        try {
          await stopTitle(input.sessionId);
          if (signal.aborted)
            throw new ForgeError("cancelled", "Run cancelled.");
          const [settings, config, snapshot] = await Promise.all([
            settingsStore.getPublic(),
            settingsStore.getProviderConfig(),
            store.get(input.sessionId),
          ]);
          endpoint(settings.baseUrl);
          settingsFields.model.parse(input.model ?? snapshot.model);
          const provider = providerFactory(
            providerConfigSchema.parse({
              ...config,
              apiMode: settings.apiMode,
            }),
          );
          if (signal.aborted)
            throw new ForgeError("cancelled", "Run cancelled.");
          const built = await buildTools(
            snapshot.workspace,
            settings,
            config.apiKey,
          );
          tools = built.tools;
          const result = await createAgentRuntime({
            store,
            settings,
            provider,
            tools,
            projectInstructions: built.instructions,
            onChildOperation: track,
            childToolFactory: async (workspace) => {
              return (await buildTools(workspace, settings, config.apiKey))
                .tools;
            },
          }).run(input, onEvent, approve, signal, control);
          const titleController = new AbortController();
          const naming = autoTitle({ snapshot: result, store, provider, signal: AbortSignal.any([disposal.signal, titleController.signal]), secrets: [config.apiKey, config.baseUrl] }).catch(() => {});
          titleOperations.set(result.id, { controller: titleController, work: naming });
          titleTasks.add(naming);
          void naming.finally(() => {
            titleTasks.delete(naming);
            if (titleOperations.get(result.id)?.work === naming) titleOperations.delete(result.id);
          });
          return result;
        } finally {
          try {
            if (tools) await tools.dispose();
          } finally {
            active.delete(input.sessionId);
          }
        }
      });
      active.set(input.sessionId, operation);
      track(input.sessionId, controller, operation);
      return operation;
    },
    dispose() {
      if (closing) return closing;
      disposed = true;
      disposal.abort();
      closing = Promise.allSettled(
        [...controls.values()].map((c) => c.work),
      ).then(async () => { await Promise.allSettled([...titleTasks]); await mcp.dispose(); });
      return closing;
    },
  };
};
