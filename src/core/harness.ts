import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createProjectContext } from "../context/index";
import { createMcpService } from "../mcp/registry";
import { createPluginHost } from "../plugins/host";
import { createModelProvider } from "../provider/openai";
import { createRouteState, createRoutedProvider } from "../provider/routing";
import type { AsyncTaskService } from "../shared/async-tasks";
import {
  budgetUsage,
  measureContext,
  resolveContextBudget,
  resolveContextWindow,
} from "../shared/context-usage";
import type {
  HarnessOptions,
  HarnessService,
  LocalToolRegistry,
  ModelProvider,
} from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { QueueAdmissionError } from "../shared/input-queue";
import {
  modelProtocol,
  modelProtocolEndpoint,
  modelProtocolOverride,
} from "../shared/model-protocol";
import { browserRequestSchema } from "../shared/plugins";
import {
  collectPublishedFiles,
  publishedFileIdSchema,
} from "../shared/published-files";
import type { RootRunBudget } from "../shared/run-budget";
import {
  configureInputSchema,
  createSessionInputSchema,
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
import type { CommandTaskAccess } from "../shared/task-view";
import { createCheckpointStore } from "../store/checkpoints";
import { openHarnessExperienceStore } from "../store/harness-experiences";
import { openMemoryStore } from "../store/memory";
import { openModelCatalogStore } from "../store/model-catalog";
import { openPublishedFileStore } from "../store/published-files";
import { openSessionStore } from "../store/sessions";
import { openSettingsStore } from "../store/settings";
import { openToolHooksStore } from "../store/tool-hooks";
import { createAsyncTaskToolRegistry } from "../tools/async-tasks";
import { createChartToolRegistry } from "../tools/chart";
import { createCombinedToolRegistry } from "../tools/combined";
import { withCommandTasks } from "../tools/command-tasks";
import { createLocalToolRegistry } from "../tools/local";
import { createLspToolRegistry } from "../tools/lsp";
import { createMcpToolRegistry } from "../tools/mcp";
import { createMemoryToolRegistry } from "../tools/memory";
import { createPublishedFileTool } from "../tools/published-files";
import { createSkillTool } from "../tools/skills";
import { createWebToolRegistry } from "../tools/web";
import { assertAgentModel } from "./agent-profiles";
import { createAgentWorktreeService } from "./agent-worktrees";
import { openAsyncTaskService } from "./async-tasks";
import { assertBoundary, projectSummary } from "./context";
import { createDelegationModels } from "./delegation-models";
import { forgeMemory } from "./forge-memory";
import {
  inputPredecessor,
  inputProviderBinding,
  openInputQueue,
} from "./input-queue";
import { redactMemoryText } from "./memory-retrieval";
import { createModelAccessService } from "./model-access";
import { createModelPricingService } from "./model-pricing";
import { createRootRunBudget } from "./run-budget";
import { openRunMemory } from "./run-memory";
import { createAgentRuntime, withCancellation } from "./runtime";
import { autoTitle } from "./session-title";
import { createSessionWriter } from "./session-writer";
import { resolveStateDirectory } from "./state-directory";
import { createTaskService } from "./task-service";
import { createUsageStatsService } from "./usage-stats";
import { summarizeWorkingState } from "./working-memory";
import {
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
} from "./workspace-files";

// Default per-run tools include the explicitly enabled plugin registries.
// Browser tools come only from the browser plugin and launch lazily on use;
// disabling that plugin leaves no legacy browser backend to fall back to.
// Custom injected tool factories keep their own behavior.
const createDefaultTools = async (
  workspace: string,
  settings: PublicSettings,
  apiKey: string,
  checkpointDirectory: string,
  stateDirectory: string,
  mcp: Awaited<ReturnType<typeof createMcpService>>,
  extensions: Awaited<
    ReturnType<Awaited<ReturnType<typeof createPluginHost>>["createTools"]>
  >,
): Promise<LocalToolRegistry> => {
  const registries: LocalToolRegistry[] = [extensions.registry];
  try {
    const local = await createLocalToolRegistry(workspace, {
      redactValues: [apiKey],
      protectedRoots: [stateDirectory],
      ...(settings.gitInspectionTimeoutMs === undefined
        ? {}
        : { gitTimeoutMs: settings.gitInspectionTimeoutMs }),
      checkpointStore: await createCheckpointStore(
        workspace,
        checkpointDirectory,
        { protectedStateRoot: stateDirectory },
      ),
    });
    registries.push(withCommandTasks(local, { redactValues: [apiKey] }));
    // Public-text tools require no browser configuration and do no I/O until called.
    registries.push(createWebToolRegistry({ redactValues: [apiKey] }));
    if (settings.lspServers?.length)
      registries.push(
        await createLspToolRegistry(workspace, settings.lspServers, {
          protectedRoots: [stateDirectory],
          redactValues: [apiKey],
        }),
      );
    registries.push(
      await createMcpToolRegistry(mcp, { redactValues: [apiKey] }),
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
  // Without an explicit source, use the active one unless the environment
  // overrides the provider configuration.
  const defaultSourceId = async (requested: string | undefined) => {
    if (requested !== undefined) return requested;
    const settings = await settingsStore.getPublic();
    return settings.environmentOverride ? undefined : settings.activeSourceId;
  };
  const buildTools = async (
    workspace: string,
    settings: PublicSettings,
    apiKey: string,
    provider: ModelProvider,
    uiHost?: "web",
  ) => {
    let local: LocalToolRegistry | undefined;
    let context: Awaited<ReturnType<typeof createProjectContext>> | undefined;
    let service: Awaited<ReturnType<typeof createMcpService>> | undefined;
    let extensions: Awaited<ReturnType<typeof plugins.createTools>> | undefined;
    try {
      if (options.toolFactory) local = await options.toolFactory(workspace);
      else {
        if (liveMcp.size >= 64)
          throw new ForgeError("busy", "Too many active tool services");
        service = await createMcpService({ home: directory });
        liveMcp.add(service);
        extensions = await plugins.createTools(workspace, [apiKey]);
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
          extensions,
        );
      }
      context = await createProjectContext(workspace, {
        protectedRoots: [directory],
      });
      await context.refresh();
      const combined = createCombinedToolRegistry(
        local,
        ...(!options.toolFactory
          ? [
              await createPublishedFileTool(workspace, publishedFiles, {
                protectedRoots: [directory],
                redactValues: [apiKey],
              }),
              createMemoryToolRegistry(memories, {
                redactValues: [apiKey],
                forge: (input, toolContext) =>
                  forgeMemory(input, {
                    sessions: store,
                    memories,
                    provider,
                    context: toolContext,
                    secrets: [apiKey],
                  }),
                background: async (input, toolContext) => {
                  const current = await store.get(toolContext.sessionId);
                  // Wake the primary session, also for nested children.
                  let main = current;
                  for (let hops = 0; main.parentSessionId && hops < 8; hops++)
                    main = await store.get(main.parentSessionId);
                  const service = await getAsyncTasks();
                  const levels = [
                    "readonly",
                    "workspace",
                    "unrestricted",
                  ] as const;
                  let ceiling = levels.indexOf(toolContext.permission);
                  const newOwner = !asyncPermissions.has(main.id);
                  if (newOwner)
                    asyncPermissions.set(main.id, () => toolContext.permission);
                  try {
                    return await service.start({
                      tool: "forge_memory",
                      sessionId: current.id,
                      wakeSessionId: main.id,
                      resume: {
                        model: main.model,
                        permission: toolContext.permission,
                        ...(main.providerSourceId
                          ? { providerSourceId: main.providerSourceId }
                          : {}),
                        ...(main.routeGroupId
                          ? { routeGroupId: main.routeGroupId }
                          : {}),
                      },
                      signal: toolContext.signal,
                      redact: (text) => redactMemoryText(text, [apiKey]),
                      execute: async (signal, onModelUsage) => {
                        const context = {
                          ...toolContext,
                          signal,
                          onModelUsage,
                          // No late callbacks into a disposed run's writer/approval queue.
                          approve: async () => false,
                          onEvent: () => {},
                          get permission() {
                            ceiling = Math.min(
                              ceiling,
                              levels.indexOf(toolContext.permission),
                              levels.indexOf(
                                asyncPermissions.get(main.id)?.() ?? "readonly",
                              ),
                            );
                            return levels[ceiling] ?? "readonly";
                          },
                        };
                        return {
                          content: JSON.stringify(
                            await forgeMemory(input, {
                              sessions: store,
                              memories,
                              provider,
                              context,
                              current,
                              secrets: [apiKey],
                            }),
                          ),
                          isError: false,
                        };
                      },
                    });
                  } catch (error) {
                    if (newOwner) asyncPermissions.delete(main.id);
                    throw error;
                  }
                },
              }),
              createAsyncTaskToolRegistry(getAsyncTasks),
            ]
          : []),
        createSkillTool(context),
        // The chart tool is a pure validator with no side effects; only the
        // Web host stamps uiHost, so CLI/desktop runs never advertise it.
        ...(uiHost === "web" ? [createChartToolRegistry()] : []),
      );
      const ownedService = service;
      const ownedContext = context;
      const access = combined.commandTasks;
      if (access) taskAccess.add(access);
      if (apiKey) taskSecrets.add(apiKey);
      let accessReleased = false;
      return {
        instructions: [context.getSystemContext(), extensions?.instructions]
          .filter(Boolean)
          .join("\n\n"),
        tools: {
          definitions: combined.definitions,
          isConcurrencySafe: (call) =>
            combined.isConcurrencySafe?.(call) === true,
          execute: combined.execute,
          ...(combined.settleBackground
            ? { settleBackground: combined.settleBackground }
            : {}),
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
        extensions?.registry.dispose(),
        context?.dispose(),
        service?.dispose(),
      ]);
      if (service) liveMcp.delete(service);
      throw error;
    }
  };
  // No checkpoints, command tasks, network, MCP, hooks or other native tools.
  // Each probe owns independent read authority; it cannot authorize later edits.
  const buildProbeTools = async (
    workspace: string,
    apiKey: string,
  ): Promise<LocalToolRegistry> => {
    let local: LocalToolRegistry | undefined;
    let context: Awaited<ReturnType<typeof createProjectContext>> | undefined;
    try {
      local = options.toolFactory
        ? await options.toolFactory(workspace)
        : await createLocalToolRegistry(workspace, {
            protectedRoots: [directory],
            redactValues: [apiKey],
          });
      context = await createProjectContext(workspace, {
        protectedRoots: [directory],
      });
      await context.refresh();
      const combined = createCombinedToolRegistry(
        local,
        createSkillTool(context),
      );
      const ownedContext = context;
      return {
        definitions: combined.definitions,
        execute: combined.execute,
        async dispose() {
          try {
            await combined.dispose();
          } finally {
            await ownedContext.dispose();
          }
        },
      };
    } catch (error) {
      await Promise.allSettled([local?.dispose(), context?.dispose()]);
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
  const catalogStore = await openModelCatalogStore(directory);
  const routeState = createRouteState();
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
  const titleTasks = new Set<Promise<void>>();
  const titleOperations = new Map<
    SessionId,
    { controller: AbortController; work: Promise<void> }
  >();
  const stopTitle = async (id: SessionId) => {
    const pending = titleOperations.get(id);
    if (pending) {
      pending.controller.abort();
      await pending.work;
    }
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
      const writer = createSessionWriter(store, id);
      const next = await fn(await writer.read());
      await writer.save(next);
      return next;
    } finally {
      await release();
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
    if (routeGroupId) {
      const group = settings.routeGroups?.find(
        (item) => item.id === routeGroupId,
      );
      if (!group)
        throw new ForgeError("not_found", "会话的路由组已不可用，请重新选择。");
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
    endpoint(config.baseUrl);
    const source = settings.providerSources?.find(
      (item) => item.id === sourceId,
    );
    return inputProviderBinding(
      config,
      source?.modelAliases?.[model] ?? model,
      sourceId,
    );
  };
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
        const settings = await settingsStore.getPublic();
        const providerSourceId = s.providerSourceId ?? settings.activeSourceId;
        const group = s.routeGroupId
          ? settings.routeGroups?.find((item) => item.id === s.routeGroupId)
          : undefined;
        if (s.routeGroupId && !group)
          throw new ForgeError(
            "not_found",
            "会话的路由组已不可用，请重新选择。",
          );
        const prepared = group
          ? await modelAccess.prepareRoute(group, signal)
          : undefined;
        const resolved =
          prepared?.base ??
          (await modelAccess.resolveProvider(
            providerSourceId,
            undefined,
            signal,
            s.model,
          ));
        const { provider } = resolved;
        const bound =
          providerSourceId && providerSourceId !== s.providerSourceId
            ? { ...s, providerSourceId }
            : s;
        let reported: number | null = prepared?.contextWindow ?? null;
        const metadataSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(2000),
        ]);
        try {
          reported ??= await withCancellation(
            provider.getModelContextWindow?.(
              resolved.actualModel ?? s.model,
              metadataSignal,
            ) ?? Promise.resolve(null),
            metadataSignal,
          );
        } catch {
          /* Optional metadata must not prevent compaction. */
        }
        const window = resolveContextWindow(s.model, settings, reported);
        const next = await summarizeWorkingState(
          bound,
          provider,
          signal,
          s.messages.length,
          Math.floor(window * 0.8),
        );
        const last = s.events.at(-1);
        // Also repair the stale meter on sessions compacted by older versions.
        if (
          next === s &&
          last?.type === "context_usage" &&
          last.usage.basis === "projected"
        )
          return s;
        const before = projectSummary(s);
        const after = projectSummary(next);
        const usage = measureContext(after, window);
        // Retain the last known tool-definition overhead without opening tool/MCP
        // services just to render an estimate. Tool results themselves are compacted.
        const previous = s.events.findLast(
          (event) =>
            event.type === "context_usage" && event.usage.basis === "projected",
        );
        const toolOverhead =
          previous?.type === "context_usage"
            ? Math.max(
                0,
                previous.usage.parts.tools -
                  measureContext(before, window).parts.tools,
              )
            : 0;
        const timestamp = new Date().toISOString();
        return {
          ...next,
          updatedAt: timestamp,
          events: [
            ...next.events,
            {
              type: "context_compacted",
              sessionId: id,
              timestamp,
              removedMessages: Math.max(0, before.length - after.length),
              beforeChars: JSON.stringify(before).length,
              afterChars: JSON.stringify(after).length,
            },
            {
              type: "context_usage",
              sessionId: id,
              timestamp,
              usage: {
                ...usage,
                ...budgetUsage(resolveContextBudget(window, settings)),
                usedTokens: usage.usedTokens + toolOverhead,
                parts: {
                  ...usage.parts,
                  tools: usage.parts.tools + toolOverhead,
                },
              },
            },
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
      const operation = Promise.resolve().then(async () => {
        let tools: LocalToolRegistry | undefined;
        let releaseSession: (() => Promise<void>) | undefined;
        let rootBudget: RootRunBudget | undefined;
        try {
          await stopTitle(input.sessionId);
          try {
            releaseSession = await store.acquire(input.sessionId, signal);
          } catch (error) {
            if (
              control?.providerBinding &&
              error instanceof ForgeError &&
              error.code === "busy"
            )
              throw new QueueAdmissionError();
            throw error;
          }
          if (signal.aborted)
            throw new ForgeError("cancelled", "Run cancelled.");
          const [settings, snapshot] = await Promise.all([
            settingsStore.getPublic(),
            store.get(input.sessionId),
          ]);
          // A role's model is frozen with its session, including manual continuation.
          assertAgentModel(snapshot.agentProfile, input);
          // Recheck under the actual execution lock, before provider/tool construction.
          if (control?.providerBinding) {
            const predecessor = inputPredecessor(snapshot);
            if (
              predecessor.unsafe &&
              control.acknowledgedPredecessor !== predecessor.token
            )
              throw new QueueAdmissionError();
          }
          if (asyncPermissions.has(input.sessionId)) {
            const levels = ["readonly", "workspace", "unrestricted"] as const;
            asyncPermissions.set(
              input.sessionId,
              () =>
                levels[
                  Math.min(
                    levels.indexOf(
                      input.mode === "plan"
                        ? "readonly"
                        : (control?.getPermission?.() ??
                            input.permission ??
                            settings.defaultPermission),
                    ),
                    levels.indexOf(
                      snapshot.permissionCeiling ?? "unrestricted",
                    ),
                  )
                ] ?? "readonly",
            );
          }
          rootBudget = createRootRunBudget({ rootSessionId: input.sessionId });
          // An explicit selection (the picked model's source) wins; a session
          // keeps the source it was created with; only when neither exists does
          // the model, and finally the remembered fallback, decide.
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
          const group = routeGroupId
            ? settings.routeGroups?.find((item) => item.id === routeGroupId)
            : undefined;
          if (routeGroupId && !group)
            throw new ForgeError(
              "not_found",
              "会话的路由组已不可用，请重新选择。",
            );
          if (input.harness && routeGroupId)
            throw new ForgeError(
              "invalid_input",
              "Harness adaptation requires a direct model selection, not a route group.",
            );
          const requestedModel = settingsFields.model.parse(
            input.model ?? snapshot.model,
          );
          const directSource = settings.providerSources?.find(
            (source) => source.id === providerSourceId,
          );
          const credentials = directSource?.credentials?.filter(
            (item) => item.enabled,
          );
          // Direct selections rotate only their explicitly configured credentials.
          const selectedGroup =
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
              : undefined);
          if (
            control?.providerBinding &&
            control.providerBinding !==
              (await queueProviderBinding(
                settings,
                requestedModel,
                providerSourceId,
                routeGroupId,
              ))
          )
            throw new ForgeError(
              "invalid_input",
              "The queued provider selection changed before execution. Nothing was replayed.",
            );
          const validateSelection: Parameters<
            typeof modelAccess.resolveProvider
          >[4] = control?.providerBinding
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
                    acceptedSource.modelAliases?.[selectedModel] ??
                      selectedModel,
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
          const prepared = selectedGroup
            ? await modelAccess.prepareRoute(
                selectedGroup,
                signal,
                validateSelection,
              )
            : undefined;
          const resolved =
            prepared?.base ??
            (await modelAccess.resolveProvider(
              providerSourceId,
              undefined,
              signal,
              requestedModel,
              validateSelection,
            ));
          const { config } = resolved;
          endpoint(config.baseUrl);
          // An explicit source (or one the model alone identifies) is what the
          // user just chose, so remember it as the fallback for the next run.
          await rememberSource(
            input.providerSourceId ?? inferSourceId(settings, input.model),
          );
          rootBudget.checkAdmission();
          const provider =
            selectedGroup && prepared
              ? createRoutedProvider({
                  group: selectedGroup,
                  state: routeState,
                  ...(prepared.apiMode ? { apiMode: prepared.apiMode } : {}),
                  mayUseWebSearch: prepared.mayUseWebSearch,
                  contextWindow: prepared.contextWindow,
                  quota: prepared.quota,
                  exclude: prepared.exclude,
                  resolve: (member, requestSignal) =>
                    modelAccess.resolveProvider(
                      member.sourceId,
                      member.credentialId,
                      requestSignal,
                      member.model,
                      validateSelection,
                    ),
                })
              : resolved.provider;
          if (signal.aborted)
            throw new ForgeError("cancelled", "Run cancelled.");
          const built = await buildTools(
            snapshot.workspace,
            settings,
            config.apiKey,
            provider,
            input.uiHost,
          );
          tools = built.tools;
          rootBudget.checkAdmission();
          const budget = rootBudget;
          const result = await createAgentRuntime({
            rootBudget: budget,
            store,
            sessionLock: { id: input.sessionId, release: releaseSession },
            autoTitle: {
              secrets: [config.apiKey, config.baseUrl],
              start: (claimed, apply) => {
                const titleController = new AbortController();
                const titleSignal = AbortSignal.any([
                  signal,
                  titleController.signal,
                ]);
                const naming = autoTitle({
                  snapshot: claimed,
                  provider: resolved.provider,
                  signal: titleSignal,
                  secrets: [config.apiKey, config.baseUrl],
                  beginUsage: () => budget.beginUsage(input.sessionId),
                })
                  .then(async (title) => {
                    if (!title || titleSignal.aborted || (await apply(title)))
                      return;
                    // A fast run may finish before inference. Re-read under a
                    // new lock; never save the stale first-turn snapshot.
                    const unlock = await store.acquire(claimed.id, titleSignal);
                    try {
                      if (titleSignal.aborted) return;
                      const writer = createSessionWriter(store, claimed.id);
                      const current = await writer.read();
                      if (
                        current.titleSource === "auto" &&
                        current.title === claimed.title &&
                        current.autoTitleAttempted
                      )
                        await writer.save({ ...current, title });
                    } finally {
                      await unlock();
                    }
                  })
                  .catch(() => {});
                titleOperations.set(claimed.id, {
                  controller: titleController,
                  work: naming,
                });
                titleTasks.add(naming);
                void naming.finally(() => {
                  titleTasks.delete(naming);
                  if (titleOperations.get(claimed.id)?.work === naming)
                    titleOperations.delete(claimed.id);
                });
              },
            },
            runMemory,
            toolHooks: await toolHooksStore.get(),
            agentWorktrees,
            settings,
            getAgentProfiles: async () =>
              (await settingsStore.getPublic()).agentProfiles ?? [],
            delegationModels: createDelegationModels({
              getSettings: () => settingsStore.getPublic(),
              listModels: async (sourceId, requestSignal) => {
                const resolved = await modelAccess.resolveProvider(
                  sourceId,
                  undefined,
                  requestSignal,
                );
                return resolved.provider.listModels(requestSignal);
              },
            }),
            provider,
            tools,
            projectInstructions: built.instructions,
            ...(input.harness
              ? {
                  harnessAdaptation: {
                    createProbeTools: () =>
                      buildProbeTools(snapshot.workspace, config.apiKey),
                    redact: (text: string) =>
                      redactMemoryText(text, [config.apiKey, config.baseUrl]),
                    experiences: {
                      list: async (scope) =>
                        (await getHarnessExperiences()).list(scope),
                      save: async (experience) =>
                        (await getHarnessExperiences()).save(experience),
                    },
                  },
                }
              : {}),
            onChildOperation: track,
            childContextFactory: async (workspace, childInput, childSignal) => {
              // Delegated model IDs remain exact, even when the parent chose a group.
              const current = await settingsStore.getPublic();
              // Admission already resolved an exact source. Never fall back to the parent's provider.
              const childSourceId = childInput?.providerSourceId;
              const child = await modelAccess.resolveProvider(
                childSourceId,
                undefined,
                childSignal ?? signal,
                childInput?.model,
              );
              return {
                ...(await buildTools(
                  workspace,
                  current,
                  child.config.apiKey,
                  child.provider,
                  input.uiHost,
                )),
                provider: child.provider,
                ...(childSourceId ? { providerSourceId: childSourceId } : {}),
              };
            },
          }).run(
            {
              ...input,
              ...(providerSourceId ? { providerSourceId } : {}),
              ...(routeGroupId ? { routeGroupId } : {}),
            },
            onEvent,
            approve,
            signal,
            control,
          );
          return result;
        } finally {
          try {
            if (tools) await tools.dispose();
          } finally {
            try {
              await releaseSession?.();
            } finally {
              rootBudget?.close();
              active.delete(input.sessionId);
              const reader = asyncPermissions.get(input.sessionId);
              if (reader) {
                const permission = reader();
                asyncPermissions.set(input.sessionId, () => permission);
              }
            }
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
          await Promise.allSettled([...titleTasks]);
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
