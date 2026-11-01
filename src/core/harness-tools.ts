import { createProjectContext } from "../context";
import type { McpService } from "../mcp";
import type { createPluginHost } from "../plugins";
import type {
  AsyncTaskService,
  CommandEnvironmentTransform,
  CommandTaskAccess,
  HarnessOptions,
  LocalToolRegistry,
  ModelProvider,
  Permission,
  PublicSettings,
  SessionId,
  SessionSnapshot,
} from "../shared";

import {
  createCheckpointStore,
  type openMemoryStore,
  type openPublishedFileStore,
  type openSessionStore,
  workspaceCheckpointDirectory,
} from "../store";

import {
  type LspServerPool,
  createAsyncTaskToolRegistry,
  createChartToolRegistry,
  createCombinedToolRegistry,
  createLocalToolRegistry,
  createLspToolRegistry,
  createMcpToolRegistry,
  createPublishedFileTool,
  createSkillTool,
  createWebToolRegistry,
  withCommandTasks,
} from "../tools";

import { createHarnessMemoryTools } from "./harness-memory-tools";

/** Harness-owned state shared by every per-run tool registry. */
export type HarnessToolDeps = {
  directory: string;
  options: Pick<HarnessOptions, "toolFactory" | "sessionTools">;
  plugins: Awaited<ReturnType<typeof createPluginHost>>;
  publishedFiles: Awaited<ReturnType<typeof openPublishedFileStore>>;
  memories: Awaited<ReturnType<typeof openMemoryStore>>;
  store: Awaited<ReturnType<typeof openSessionStore>>;
  getAsyncTasks: () => Promise<AsyncTaskService>;
  asyncPermissions: Map<SessionId, { read: () => Permission; tasks: number }>;
  mcp: McpService;
  lspPool: LspServerPool;
  taskAccess: Set<CommandTaskAccess>;
  recentTaskAccess: CommandTaskAccess[];
  taskSecrets: Map<string, { registries: number }>;
};

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
  mcp: McpService,
  lspPool: LspServerPool,
  extensions: Awaited<
    ReturnType<Awaited<ReturnType<typeof createPluginHost>>["createTools"]>
  >,
  transformCommandEnv: CommandEnvironmentTransform | undefined,
): Promise<LocalToolRegistry> => {
  const registries: LocalToolRegistry[] = [extensions.registry];
  try {
    const local = await createLocalToolRegistry(workspace, {
      redactValues: [apiKey],
      protectedRoots: [stateDirectory],
      transformCommandEnv,
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
    registries.push(
      await createLspToolRegistry(workspace, settings.lspServers ?? [], {
        pool: lspPool,
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

/** Builds the per-run tool registries (and read-only probe tools) for a harness. */
export const createHarnessTools = (deps: HarnessToolDeps) => {
  const {
    directory,
    options,
    plugins,
    publishedFiles,
    memories,
    store,
    getAsyncTasks,
    asyncPermissions,
    mcp,
    lspPool,
    taskAccess,
    recentTaskAccess,
    taskSecrets,
  } = deps;
  const buildTools = async (
    workspace: string,
    settings: PublicSettings,
    apiKey: string,
    provider: ModelProvider,
    uiHost?: "web",
    session?: SessionSnapshot,
  ) => {
    let local: LocalToolRegistry | undefined;
    let sessionTools: ReturnType<NonNullable<HarnessOptions["sessionTools"]>>;
    let context: Awaited<ReturnType<typeof createProjectContext>> | undefined;
    let extensions: Awaited<ReturnType<typeof plugins.createTools>> | undefined;
    try {
      sessionTools = session ? options.sessionTools?.(session) : undefined;
      if (options.toolFactory) local = await options.toolFactory(workspace);
      else {
        extensions = await plugins.createTools(workspace, [apiKey]);
        local = await createDefaultTools(
          workspace,
          settings,
          apiKey,
          workspaceCheckpointDirectory(directory, workspace),
          directory,
          mcp,
          lspPool,
          extensions,
          sessionTools?.transformCommandEnv,
        );
      }
      context = await createProjectContext(workspace, {
        protectedRoots: [directory],
      });
      await context.refresh();
      const combined = createCombinedToolRegistry(
        local,
        ...(sessionTools ? [sessionTools.registry] : []),
        ...(!options.toolFactory
          ? [
              await createPublishedFileTool(workspace, publishedFiles, {
                protectedRoots: [directory],
                redactValues: [apiKey],
              }),
              createHarnessMemoryTools(
                { store, memories, getAsyncTasks, asyncPermissions },
                provider,
                apiKey,
              ),
              createAsyncTaskToolRegistry(getAsyncTasks),
            ]
          : []),
        createSkillTool(context),
        // The chart tool is a pure validator with no side effects; only the
        // Web host stamps uiHost, so CLI/desktop runs never advertise it.
        ...(uiHost === "web" ? [createChartToolRegistry()] : []),
      );
      const ownedContext = context;
      const access = combined.commandTasks;
      if (access) taskAccess.add(access);
      const secret = apiKey
        ? (taskSecrets.get(apiKey) ?? { registries: 0 })
        : undefined;
      if (secret) {
        secret.registries++;
        taskSecrets.set(apiKey, secret);
      }
      let accessReleased = false;
      return {
        instructions: [
          context.getSystemContext(),
          extensions?.instructions,
          sessionTools?.instructions,
        ]
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
              if (!accessReleased) {
                accessReleased = true;
                if (secret && --secret.registries === 0)
                  taskSecrets.delete(apiKey);
                if (access) {
                  taskAccess.delete(access);
                  recentTaskAccess.push(access);
                  if (recentTaskAccess.length > 8) recentTaskAccess.shift();
                }
              }
              await ownedContext.dispose();
            }
          },
        } satisfies LocalToolRegistry,
      };
    } catch (error) {
      await Promise.allSettled([
        local?.dispose(),
        sessionTools?.registry.dispose(),
        extensions?.registry.dispose(),
        context?.dispose(),
      ]);
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
  return { buildTools, buildProbeTools };
};
