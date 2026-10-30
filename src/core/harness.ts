import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createProjectContext } from "../context/index";
import { createMcpService } from "../mcp/registry";
import { createPluginHost } from "../plugins/host";
import { createModelProvider } from "../provider/openai";
import { createRouteState } from "../provider/routing";
import type { AsyncTaskService } from "../shared/async-tasks";
import type { HarnessOptions, HarnessService } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { QueueAdmissionError } from "../shared/input-queue";
import { browserRequestSchema } from "../shared/plugins";
import {
  collectPublishedFiles,
  publishedFileIdSchema,
} from "../shared/published-files";
import {
  configureInputSchema,
  createSessionInputSchema,
  runInputSchema,
  sessionIdSchema,
  sessionTitleSchema,
  settingsFields,
} from "../shared/schemas";
import type { SessionId, SessionSnapshot } from "../shared/schemas";
import type { CommandTaskAccess } from "../shared/task-view";
import { createCheckpointStore } from "../store/checkpoints";
import { openHarnessExperienceStore } from "../store/harness-experiences";
import { openMemoryStore } from "../store/memory";
import { openModelCatalogStore } from "../store/model-catalog";
import { openPublishedFileStore } from "../store/published-files";
import { openSessionStore } from "../store/sessions";
import { openSettingsStore } from "../store/settings";
import { openToolHooksStore } from "../store/tool-hooks";
import { createAgentWorktreeService } from "./agent-worktrees";
import { openAsyncTaskService } from "./async-tasks";
import { assertBoundary, projectSummary } from "./context";
import { compactSessionSnapshot } from "./harness-compaction";
import {
  createProviderSelection,
  inferSourceId,
} from "./harness-provider-selection";
import { createHarnessRun } from "./harness-run";
import { createHarnessTitles } from "./harness-titles";
import { createHarnessTools } from "./harness-tools";
import { inputPredecessor, openInputQueue } from "./input-queue";
import { createModelAccessService } from "./model-access";
import { createModelPricingService } from "./model-pricing";
import { openRunMemory } from "./run-memory";
import { createSessionWriter } from "./session-writer";
import { resolveStateDirectory } from "./state-directory";
import { createTaskService } from "./task-service";
import { createUsageStatsService } from "./usage-stats";
import {
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
} from "./workspace-files";

export const createHarness = async (
  options: HarnessOptions = {},
): Promise<HarnessService> => {
  const directory = resolveStateDirectory(options.stateDir);
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
  // Lazy: ordinary runs neither read nor create the adaptation library.
  let harnessExperiences:
    | ReturnType<typeof openHarnessExperienceStore>
    | undefined;
  const agentWorktrees = createAgentWorktreeService(directory);
  const publishedFiles = await openPublishedFileStore(directory);
  const plugins = await createPluginHost(directory, {
    async publishOfficePreview(sessionId, preview, signal) {
      return publishedFiles.put(
        sessionId,
        Buffer.from(preview.html, "utf8"),
        {
          name: preview.name,
          mimeType: "text/html",
          previewKind: "html",
          description: preview.description,
        },
        signal,
      );
    },
    async publishImage(sessionId, image, signal) {
      const bytes = Buffer.from(image.data, "base64");
      const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (
        bytes.toString("base64") !== image.data ||
        (image.mimeType === "image/png" ? !png : !jpeg)
      )
        throw new ForgeError("tool", "Browser returned an invalid screenshot.");
      return publishedFiles.put(
        sessionId,
        bytes,
        {
          name: `browser-${Date.now()}.${png ? "png" : "jpg"}`,
          mimeType: image.mimeType,
          previewKind: "image",
          description: "Browser screenshot",
        },
        signal,
      );
    },
  });
  const usageStatsService = createUsageStatsService(
    store,
    createModelPricingService({
      cacheDirectory: directory,
    }),
  );
  const mcp = await createMcpService({ home: directory });
  const liveMcp = new Set<Awaited<ReturnType<typeof createMcpService>>>();
  // Keep live access and a bounded recent history without retaining disposed tools.
  const taskAccess = new Set<CommandTaskAccess>();
  const recentTaskAccess: CommandTaskAccess[] = [];
  const taskSecrets = new Set<string>();
  let asyncTasks: Promise<AsyncTaskService> | undefined;
  // Only sessions which actually launch retained async receipts enter this map.
  // Later runs replace the reader so pending commits observe current grants.
  const asyncPermissions = new Map<
    SessionId,
    () => import("../shared/schemas").Permission
  >();
  const getAsyncTasks = () => {
    check();
    asyncTasks ??= openAsyncTaskService({
      directory,
      notify: (request) => inputQueue.notify(request),
    });
    return asyncTasks;
  };
  const getHarnessExperiences = () => {
    harnessExperiences ??= openHarnessExperienceStore(directory);
    return harnessExperiences;
  };
  const { defaultSourceId, rememberSource, queueProviderBinding } =
    createProviderSelection(settingsStore);
  const { buildTools, buildProbeTools } = createHarnessTools({
    directory,
    options,
    plugins,
    publishedFiles,
    memories,
    store,
    getAsyncTasks,
    asyncPermissions,
    liveMcp,
    taskAccess,
    recentTaskAccess,
    taskSecrets,
  });
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
  const catalogStore = await openModelCatalogStore(directory);
  const routeState = createRouteState();
  const disposal = new AbortController();
  const modelAccess = createModelAccessService({
    settingsStore,
    catalogStore,
    providerFactory: options.providerFactory ?? createModelProvider,
    signal: disposal.signal,
  });
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
  const {
    stopTitle,
    startTitle,
    pending: pendingTitles,
  } = createHarnessTitles(store);
  let disposed = false;
  let closing: Promise<void> | undefined;
  const check = (): void => {
    if (disposed) throw new ForgeError("cancelled", "Harness is disposed.");
  };
  const mutate = async (
    id: SessionId,
    fn: (s: SessionSnapshot) => Promise<SessionSnapshot>,
  ): Promise<SessionSnapshot> => {
    check();
    await stopTitle(id);
    const release = await store.acquire(sessionIdSchema.parse(id));
    try {
      const writer = createSessionWriter(store, id);
      const next = await fn(await writer.read());
      await writer.save(next);
      return next;
    } finally {
      await release();
    }
  };
  const runSession = createHarnessRun({
    store,
    settingsStore,
    modelAccess,
    routeState,
    queueProviderBinding,
    rememberSource,
    buildTools,
    buildProbeTools,
    stopTitle,
    startTitle,
    runMemory,
    toolHooksStore,
    agentWorktrees,
    getHarnessExperiences,
    asyncPermissions,
    track,
    active,
  });
  const inputQueue = await openInputQueue({
    directory,
    validateSession: async (id) => {
      await store.get(id);
    },
    predecessor: async (id, acknowledge) => {
      if (!acknowledge) return inputPredecessor(await store.get(id));
      if (controls.has(id)) throw new QueueAdmissionError();
      const release = await store.acquire(id);
      try {
        return inputPredecessor(await store.get(id));
      } finally {
        await release();
      }
    },
    prepare: async (input) => {
      check();
      const [snapshot, settings] = await Promise.all([
        store.get(input.sessionId),
        settingsStore.getPublic(),
      ]);
      const providerSourceId =
        input.providerSourceId ??
        snapshot.providerSourceId ??
        inferSourceId(settings, input.model) ??
        settings.activeSourceId;
      const routeGroupId =
        input.routeGroupId ??
        (input.model !== undefined || input.providerSourceId !== undefined
          ? undefined
          : snapshot.routeGroupId);
      const model = settingsFields.model.parse(input.model ?? snapshot.model);
      const providerBinding = await queueProviderBinding(
        settings,
        model,
        providerSourceId,
        routeGroupId,
      );
      const levels = ["readonly", "workspace", "unrestricted"] as const;
      const permission =
        levels[
          Math.min(
            levels.indexOf(
              input.mode === "plan"
                ? "readonly"
                : (input.permission ?? settings.defaultPermission),
            ),
            levels.indexOf(snapshot.permissionCeiling ?? "unrestricted"),
          )
        ] ?? "readonly";
      return {
        input: {
          ...input,
          model,
          permission,
          mode: input.mode ?? "build",
          ...(providerSourceId ? { providerSourceId } : {}),
          ...(routeGroupId ? { routeGroupId } : {}),
        },
        providerBinding,
      };
    },
  });
  const taskService = createTaskService({
    store,
    commands: () => [...taskAccess, ...recentTaskAccess],
    owns: (id) => controls.has(id),
    cancel: async (id) => {
      check();
      const owned = controls.get(id);
      if (!owned) return false;
      owned.controller.abort();
      await Promise.allSettled([owned.work]);
      return true;
    },
    redact: (text) => {
      let result = text;
      for (const secret of taskSecrets)
        result = result.split(secret).join("[REDACTED]");
      return result;
    },
  });
  // Existing receipts are recovered at host startup, not as a side effect of a
  // model's readonly query. Never create this service for hosts which never use it.
  try {
    await stat(join(directory, "async-tasks"));
    await getAsyncTasks();
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      await Promise.allSettled([
        modelAccess.dispose(),
        inputQueue.dispose(),
        memories.close(),
        mcp.dispose(),
      ]);
      throw error;
    }
  }
  return {
    inputQueue,
    tasks: {
      listTasks: (...args) => {
        check();
        return taskService.listTasks(...args);
      },
      getTask: (...args) => {
        check();
        return taskService.getTask(...args);
      },
      stopTask: (...args) => {
        check();
        return taskService.stopTask(...args);
      },
    },
    async cancelSession(rawId) {
      const id = sessionIdSchema.parse(rawId);
      const owned = controls.get(id);
      owned?.controller.abort();
      let stoppedTask = false;
      try {
        if (asyncTasks)
          stoppedTask = await (await asyncTasks).cancelSession(id);
      } finally {
        await Promise.allSettled([owned?.work]);
      }
      return !!owned || stoppedTask;
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
        return compactSessionSnapshot(
          { settingsStore, modelAccess },
          id,
          s,
          signal,
        );
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
          ...(source.providerSourceId
            ? { providerSourceId: source.providerSourceId }
            : {}),
          ...(source.routeGroupId ? { routeGroupId: source.routeGroupId } : {}),
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
    async listPlugins() {
      check();
      return plugins.list();
    },
    async configurePlugin(input) {
      check();
      return plugins.configure(input);
    },
    async checkPlugin(id) {
      check();
      return plugins.health(id);
    },
    async browser(raw) {
      check();
      const input = browserRequestSchema.parse(raw);
      await store.get(input.sessionId); // Unknown sessions cannot probe another browser owner.
      return plugins.browser(input);
    },
    async getToolHooks() {
      check();
      return toolHooksStore.get();
    },
    async setToolHooks(config) {
      check();
      await toolHooksStore.set(config);
    },
    async updateSettings(input) {
      check();
      return settingsStore.update(configureInputSchema.parse(input));
    },
    async getModelContextWindow(model, signal, requestedSourceId) {
      check();
      const sourceId = await defaultSourceId(requestedSourceId);
      const requestSignal = AbortSignal.any(
        signal ? [signal, disposal.signal] : [disposal.signal],
      );
      const { provider } = await modelAccess.resolveProvider(
        sourceId,
        undefined,
        requestSignal,
        model,
      );
      check();
      return (
        (await provider.getModelContextWindow?.(model, requestSignal)) ?? null
      );
    },
    async listModels(signal, requestedSourceId, refresh) {
      check();
      const sourceId = await defaultSourceId(requestedSourceId);
      const requestSignal = AbortSignal.any(
        signal ? [signal, disposal.signal] : [disposal.signal],
      );
      const { provider } = await modelAccess.resolveProvider(
        sourceId,
        undefined,
        requestSignal,
      );
      check();
      return provider.listModels(requestSignal, refresh);
    },
    async listModelCatalog(signal, requestedSourceId, refresh) {
      check();
      const sourceId = await defaultSourceId(requestedSourceId);
      const requestSignal = AbortSignal.any(
        signal ? [signal, disposal.signal] : [disposal.signal],
      );
      const { provider } = await modelAccess.resolveProvider(
        sourceId,
        undefined,
        requestSignal,
      );
      if (!provider.listModelCatalog)
        throw new ForgeError(
          "provider",
          "This provider does not expose a model catalog.",
        );
      return provider.listModelCatalog(requestSignal, refresh);
    },
    async modelAccess(input, signal) {
      check();
      return modelAccess.request(input, signal);
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
      const referenced = collectPublishedFiles(session.messages).find(
        (file) => file.id === fileId,
      );
      if (!referenced)
        throw new ForgeError(
          "not_found",
          "This session does not contain that attachment.",
        );
      const response = await publishedFiles.get(fileId);
      if (JSON.stringify(response.file) !== JSON.stringify(referenced))
        throw new ForgeError(
          "storage",
          "Attachment metadata does not match the published snapshot.",
        );
      return response;
    },
    async createSession(raw) {
      check();
      const input = createSessionInputSchema.parse(raw);
      const settings = await settingsStore.getPublic();
      // A new session pins the source of the model the user picked, so choosing
      // a model alone is enough to switch providers.
      const group = input.routeGroupId
        ? settings.routeGroups?.find((item) => item.id === input.routeGroupId)
        : undefined;
      if (input.routeGroupId && !group)
        throw new ForgeError("not_found", "未找到所选路由组。");
      const firstMember = group?.members.find(
        (member) => member.enabled !== false,
      );
      const providerSourceId =
        firstMember?.sourceId ??
        input.providerSourceId ??
        inferSourceId(settings, input.model) ??
        settings.activeSourceId;
      const source = settings.providerSources?.find(
        (candidate) => candidate.id === providerSourceId,
      );
      if (providerSourceId && !source)
        throw new ForgeError(
          "invalid_input",
          "The session's provider source is unavailable. Select an existing source explicitly.",
        );
      const model =
        firstMember?.model ?? input.model ?? source?.model ?? settings.model;
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
        ...(group ? { routeGroupId: group.id } : {}),
      });
    },
    run(raw, onEvent, approve, callerSignal, control) {
      check();
      const input = runInputSchema.parse(raw);
      if (controls.has(input.sessionId))
        return Promise.reject(
          control?.providerBinding
            ? new QueueAdmissionError()
            : new ForgeError(
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
      const operation = Promise.resolve().then(() =>
        runSession(input, onEvent, approve, signal, control),
      );
      active.set(input.sessionId, operation);
      track(input.sessionId, controller, operation);
      return operation;
    },
    dispose() {
      if (closing) return closing;
      disposed = true;
      inputQueue.stop();
      disposal.abort();
      closing = Promise.allSettled(
        [...controls.values()].map((c) => c.work),
      ).then(async () => {
        try {
          try {
            if (asyncTasks) await (await asyncTasks).dispose();
          } finally {
            await modelAccess.dispose();
          }
        } finally {
          await Promise.allSettled(pendingTitles());
          try {
            await inputQueue.dispose();
          } finally {
            try {
              await memories.close();
            } finally {
              try {
                await mcp.dispose();
              } finally {
                await plugins.dispose();
              }
            }
          }
        }
      });
      return closing;
    },
  };
};
