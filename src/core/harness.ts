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
  ModelProvider,
} from "../shared/contracts";
import { budgetUsage, measureContext, resolveContextBudget, resolveContextWindow } from "../shared/context-usage";
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
import { openPublishedFileStore } from "../store/published-files";
import { collectPublishedFiles, publishedFileIdSchema } from "../shared/published-files";
import { createPublishedFileTool } from "../tools/published-files";
import { openSessionStore } from "../store/sessions";
import { openMemoryStore } from "../store/memory";
import { createMemoryToolRegistry } from "../tools/memory";
import { forgeMemory } from "./forge-memory";
import { openSettingsStore } from "../store/settings";
import { openToolHooksStore } from "../store/tool-hooks";
import { createAgentWorktreeService } from "./agent-worktrees";
import { createCombinedToolRegistry } from "../tools/combined";
import { createLocalToolRegistry } from "../tools/local";
import { withCommandTasks } from "../tools/command-tasks";
import { createLspToolRegistry } from "../tools/lsp";
import { createMcpToolRegistry } from "../tools/mcp";
import { createSkillTool } from "../tools/skills";
import { createWebToolRegistry } from "../tools/web";
import { createUsageStatsService } from "./usage-stats";
import { assertBoundary, projectSummary } from "./context";
import { summarizeWorkingState } from "./working-memory";
import { openRunMemory } from "./run-memory";
import { autoTitle } from "./session-title";
import { createTaskService } from "./task-service";
import {
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
} from "./workspace-files";
import type { CommandTaskAccess } from "../shared/task-view";
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
    registries.push(withCommandTasks(local, { redactValues: [apiKey] }));
    // Public-text tools require no browser configuration and do no I/O until called.
    registries.push(createWebToolRegistry({ redactValues: [apiKey] }));
    if (settings.lspServers?.length) registries.push(await createLspToolRegistry(workspace, settings.lspServers, {
      protectedRoots: [stateDirectory], redactValues: [apiKey],
    }));
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

/**
 * A model name is the user's real choice, and each source publishes its own
 * models, so the source follows the model when it is unambiguous. Returns
 * undefined when nothing identifies a source; callers then fall back.
 */
function inferSourceId(
  settings: PublicSettings,
  model: string | undefined,
): string | undefined {
  if (model === undefined || model === "") return undefined;
  const owners = (settings.providerSources ?? []).filter(
    (source) => source.model === model,
  );
  return owners.length === 1 ? owners[0]?.id : undefined;
}

export const createHarness = async (
  options: HarnessOptions = {},
): Promise<HarnessService> => {
  const directory = resolve(
    options.stateDir ??
      process.env.FORGE_HOME ??
      join(homedir(), ".local", "share", "forge"),
  );
  const store = await openSessionStore(directory);
  // Removing a source must not silently strand sessions pinned to it, so the
  // settings store asks the session store which sessions still reference it.
  const settingsStore = await openSettingsStore(directory, {
    referencedSessions: async (sourceId) =>
      (await store.list())
        .filter((session) => session.providerSourceId === sourceId)
        .map((session) => session.id),
  });
  const runMemory = await openRunMemory(directory);
  const memories = await openMemoryStore(directory);
  const toolHooksStore = await openToolHooksStore(directory);
  const agentWorktrees = createAgentWorktreeService(directory);
  const publishedFiles = await openPublishedFileStore(directory);
  const usageStatsService = createUsageStatsService(store);
  const mcp = await createMcpService({ home: directory });
  const liveMcp = new Set<Awaited<ReturnType<typeof createMcpService>>>();
  // Keep live access and a bounded recent history without retaining disposed tools.
  const taskAccess = new Set<CommandTaskAccess>();
  const recentTaskAccess: CommandTaskAccess[] = [];
  const taskSecrets = new Set<string>();
  const buildTools = async (
    workspace: string,
    settings: PublicSettings,
    apiKey: string,
    provider: ModelProvider,
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
        ...(!options.toolFactory ? [
          await createPublishedFileTool(workspace, publishedFiles, { protectedRoots: [directory], redactValues: [apiKey] }),
          createMemoryToolRegistry(memories, { redactValues: [apiKey],
            forge: (input, toolContext) => forgeMemory(input, { sessions: store, memories, provider, context: toolContext, secrets: [apiKey] }),
          }),
        ] : []),
        createSkillTool(context),
      );
      const ownedService = service;
      const ownedContext = context;
      const access = combined.commandTasks;
      if (access) taskAccess.add(access);
      if (apiKey) taskSecrets.add(apiKey);
      let accessReleased = false;
      return {
        instructions: context.getSystemContext(),
        tools: {
          definitions: combined.definitions,
          isConcurrencySafe: call => combined.isConcurrencySafe?.(call) === true,
          execute: combined.execute,
          ...(combined.settleBackground ? { settleBackground: combined.settleBackground } : {}),
          async dispose() {
            try {
              await combined.dispose();
            } finally {
              if (access && !accessReleased) {
                accessReleased = true;
                taskAccess.delete(access);
                recentTaskAccess.push(access);
                if (recentTaskAccess.length > 8) recentTaskAccess.shift();
              }
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
  /**
   * The "active" source is only the fallback for callers that name no source.
   * Whenever a caller does name one, remember it, so selecting a model in any
   * client automatically keeps that source for the next run.
   */
  const rememberSource = async (sourceId: string | undefined): Promise<void> => {
    if (!sourceId) return;
    const current = await settingsStore.getPublic();
    if (current.activeSourceId === sourceId) return;
    try {
      await settingsStore.update({ source: { type: "activate", id: sourceId } });
    } catch {
      // Remembering the fallback is best-effort: the run already resolved its
      // own source explicitly and must not fail because of this.
    }
  };
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
  const taskService = createTaskService({
    store,
    commands: () => [...taskAccess, ...recentTaskAccess],
    owns: id => controls.has(id),
    cancel: async id => {
      check();
      const owned = controls.get(id);
      if (!owned) return false;
      owned.controller.abort();
      await Promise.allSettled([owned.work]);
      return true;
    },
    redact: text => {
      let result = text;
      for (const secret of taskSecrets) result = result.split(secret).join("[REDACTED]");
      return result;
    },
  });
  return {
    tasks: {
      listTasks: (...args) => { check(); return taskService.listTasks(...args); },
      getTask: (...args) => { check(); return taskService.getTask(...args); },
      stopTask: (...args) => { check(); return taskService.stopTask(...args); },
    },
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
        const settings = await settingsStore.getPublic();
        const providerSourceId = s.providerSourceId ?? settings.activeSourceId;
        const config = providerConfigSchema.parse(
          await settingsStore.getProviderConfig(providerSourceId),
        );
        const provider = providerFactory(config);
        const bound = providerSourceId ? { ...s, providerSourceId } : s;
        let reported: number | null = null;
        const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
        try { reported = await withCancellation(provider.getModelContextWindow?.(s.model, metadataSignal) ?? Promise.resolve(null), metadataSignal); }
        catch { /* Optional metadata must not prevent compaction. */ }
        const window = resolveContextWindow(s.model, settings, reported);
        const next = await summarizeWorkingState(bound, provider, signal, s.messages.length, Math.floor(window * 0.8));
        const last = s.events.at(-1);
        // Also repair the stale meter on sessions compacted by older versions.
        if (next === s && last?.type === "context_usage" && last.usage.basis === "projected") return s;
        const before = projectSummary(s);
        const after = projectSummary(next);
        const usage = measureContext(after, window);
        // Retain the last known tool-definition overhead without opening tool/MCP
        // services just to render an estimate. Tool results themselves are compacted.
        const previous = s.events.findLast(event => event.type === "context_usage" && event.usage.basis === "projected");
        const toolOverhead = previous?.type === "context_usage"
          ? Math.max(0, previous.usage.parts.tools - measureContext(before, window).parts.tools) : 0;
        const timestamp = new Date().toISOString();
        return {
          ...next,
          updatedAt: timestamp,
          events: [...next.events,
            { type: "context_compacted", sessionId: id, timestamp,
              removedMessages: Math.max(0, before.length - after.length),
              beforeChars: JSON.stringify(before).length, afterChars: JSON.stringify(after).length },
            { type: "context_usage", sessionId: id, timestamp,
              usage: { ...usage, ...budgetUsage(resolveContextBudget(window, settings)),
                usedTokens: usage.usedTokens + toolOverhead,
                parts: { ...usage.parts, tools: usage.parts.tools + toolOverhead } } },
          ],
        };
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
          ...(source.providerSourceId ? { providerSourceId: source.providerSourceId } : {}),
        });
        const next = {
          ...fork,
          messages: source.messages.slice(0, end),
          ...(contextSummary ? { contextSummary } : {}),
          plan: source.plan,
          plans: source.plans,
          permissionCeiling: source.permissionCeiling,
          parentSessionId: source.parentSessionId,
          agentTask: source.agentTask,
          ownership: source.ownership,
          writePaths: source.writePaths,
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
    async getToolHooks() { check(); return toolHooksStore.get(); },
    async setToolHooks(config) { check(); await toolHooksStore.set(config); },
    async updateSettings(input) {
      check();
      return settingsStore.update(configureInputSchema.parse(input));
    },
    async getModelContextWindow(model, signal, sourceId) {
      check();
      const config = providerConfigSchema.parse(await settingsStore.getProviderConfig(sourceId));
      endpoint(config.baseUrl);
      check();
      return await providerFactory(config).getModelContextWindow?.(model,
        AbortSignal.any(signal ? [signal, disposal.signal] : [disposal.signal])) ?? null;
    },
    async listModels(signal, sourceId) {
      check();
      const config = providerConfigSchema.parse(
        await settingsStore.getProviderConfig(sourceId),
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
    async getUsageStats(filter) {
      check();
      return usageStatsService.getUsageStats(filter);
    },
    async getSession(id) {
      check();
      return store.get(sessionIdSchema.parse(id));
    },
    async listWorkspaceEntries(id, path) {
      check();
      const session = await store.get(sessionIdSchema.parse(id));
      return listWorkspaceDirectory(session.workspace, path, {
        protectedRoots: [directory],
        redactValues: [...taskSecrets],
      });
    },
    async readWorkspaceFile(id, path) {
      check();
      const session = await store.get(sessionIdSchema.parse(id));
      return readWorkspaceFilePreview(session.workspace, path, {
        protectedRoots: [directory],
        redactValues: [...taskSecrets],
      });
    },
    async getPublishedFile(rawSessionId, rawFileId) {
      check();
      const session = await store.get(sessionIdSchema.parse(rawSessionId));
      const fileId = publishedFileIdSchema.parse(rawFileId);
      const referenced = collectPublishedFiles(session.messages).find(file => file.id === fileId);
      if (!referenced) throw new ForgeError("not_found", "This session does not contain that attachment.");
      const response = await publishedFiles.get(fileId);
      if (JSON.stringify(response.file) !== JSON.stringify(referenced))
        throw new ForgeError("storage", "Attachment metadata does not match the published snapshot.");
      return response;
    },
    async createSession(raw) {
      check();
      const input = createSessionInputSchema.parse(raw);
      const settings = await settingsStore.getPublic();
      // A new session pins the source of the model the user picked, so choosing
      // a model alone is enough to switch providers.
      const providerSourceId =
        input.providerSourceId ?? inferSourceId(settings, input.model) ?? settings.activeSourceId;
      const source = settings.providerSources?.find(candidate => candidate.id === providerSourceId);
      if (providerSourceId && !source)
        throw new ForgeError("invalid_input", "The session's provider source is unavailable. Select an existing source explicitly.");
      const model = input.model ?? source?.model ?? settings.model;
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
        ...(providerSourceId ? { providerSourceId } : {}),
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
        let releaseSession: (() => Promise<void>) | undefined;
        try {
          await stopTitle(input.sessionId);
          releaseSession = await store.acquire(input.sessionId, signal);
          if (signal.aborted)
            throw new ForgeError("cancelled", "Run cancelled.");
          const [settings, snapshot] = await Promise.all([
            settingsStore.getPublic(),
            store.get(input.sessionId),
          ]);
          // An explicit selection (the picked model's source) wins; a session
          // keeps the source it was created with; only when neither exists does
          // the model, and finally the remembered fallback, decide.
          const providerSourceId =
            input.providerSourceId ??
            snapshot.providerSourceId ??
            inferSourceId(settings, input.model) ??
            settings.activeSourceId;
          const config = await settingsStore.getProviderConfig(providerSourceId);
          endpoint(config.baseUrl);
          settingsFields.model.parse(input.model ?? snapshot.model);
          // An explicit source (or one the model alone identifies) is what the
          // user just chose, so remember it as the fallback for the next run.
          await rememberSource(
            input.providerSourceId ?? inferSourceId(settings, input.model),
          );
          // Endpoint, credential and protocol come from the same atomic source snapshot.
          const provider = providerFactory(providerConfigSchema.parse(config));
          if (signal.aborted)
            throw new ForgeError("cancelled", "Run cancelled.");
          const built = await buildTools(
            snapshot.workspace,
            settings,
            config.apiKey,
            provider,
          );
          tools = built.tools;
          const result = await createAgentRuntime({
            store,
            sessionLock: { id: input.sessionId, release: releaseSession },
            autoTitle: {
              secrets: [config.apiKey, config.baseUrl],
              start: (claimed, apply) => {
                const titleController = new AbortController();
                const titleSignal = AbortSignal.any([disposal.signal, titleController.signal]);
                const naming = autoTitle({ snapshot: claimed, provider, signal: titleSignal, secrets: [config.apiKey, config.baseUrl] })
                  .then(async title => {
                    if (!title || titleSignal.aborted || await apply(title)) return;
                    // A fast run may finish before inference. Re-read under a
                    // new lock; never save the stale first-turn snapshot.
                    const unlock = await store.acquire(claimed.id, titleSignal);
                    try {
                      if (titleSignal.aborted) return;
                      const current = await store.get(claimed.id);
                      if (current.titleSource === "auto" && current.title === claimed.title && current.autoTitleAttempted)
                        await store.save({ ...current, title });
                    } finally { await unlock(); }
                  }).catch(() => {});
                titleOperations.set(claimed.id, { controller: titleController, work: naming });
                titleTasks.add(naming);
                void naming.finally(() => {
                  titleTasks.delete(naming);
                  if (titleOperations.get(claimed.id)?.work === naming) titleOperations.delete(claimed.id);
                });
              },
            },
            runMemory,
            toolHooks: await toolHooksStore.get(),
            agentWorktrees,
            settings,
            provider,
            tools,
            projectInstructions: built.instructions,
            onChildOperation: track,
            childContextFactory: workspace => buildTools(workspace, settings, config.apiKey, provider),
          }).run({ ...input, ...(providerSourceId ? { providerSourceId } : {}) }, onEvent, approve, signal, control);
          return result;
        } finally {
          try {
            if (tools) await tools.dispose();
          } finally {
            try { await releaseSession?.(); }
            finally { active.delete(input.sessionId); }
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
      ).then(async () => { await Promise.allSettled([...titleTasks]); await memories.close(); await mcp.dispose(); });
      return closing;
    },
  };
};
