import { createProjectContext } from "../context/index";
import { createMcpService } from "../mcp/registry";
import type { createPluginHost } from "../plugins/host";
import type { AsyncTaskService } from "../shared/async-tasks";
import type {
  HarnessOptions,
  LocalToolRegistry,
  ModelProvider,
} from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { Permission, PublicSettings, SessionId } from "../shared/schemas";
import type { CommandTaskAccess } from "../shared/task-view";
import {
  createCheckpointStore,
  workspaceCheckpointDirectory,
} from "../store/checkpoints";
import type { openMemoryStore } from "../store/memory";
import type { openPublishedFileStore } from "../store/published-files";
import type { openSessionStore } from "../store/sessions";
import { createAsyncTaskToolRegistry } from "../tools/async-tasks";
import { createChartToolRegistry } from "../tools/chart";
import { createCombinedToolRegistry } from "../tools/combined";
import { withCommandTasks } from "../tools/command-tasks";
import { createLocalToolRegistry } from "../tools/local";
import { createLspToolRegistry } from "../tools/lsp";
import { createMcpToolRegistry } from "../tools/mcp";
import { createPublishedFileTool } from "../tools/published-files";
import { createSkillTool } from "../tools/skills";
import { createWebToolRegistry } from "../tools/web";
import { createHarnessMemoryTools } from "./harness-memory-tools";

type McpService = Awaited<ReturnType<typeof createMcpService>>;

/** Harness-owned state shared by every per-run tool registry. */
export type HarnessToolDeps = {
  directory: string;
  options: Pick<HarnessOptions, "toolFactory">;
  plugins: Awaited<ReturnType<typeof createPluginHost>>;
  publishedFiles: Awaited<ReturnType<typeof openPublishedFileStore>>;
  memories: Awaited<ReturnType<typeof openMemoryStore>>;
  store: Awaited<ReturnType<typeof openSessionStore>>;
  getAsyncTasks: () => Promise<AsyncTaskService>;
  asyncPermissions: Map<SessionId, () => Permission>;
  liveMcp: Set<McpService>;
  taskAccess: Set<CommandTaskAccess>;
  recentTaskAccess: CommandTaskAccess[];
  taskSecrets: Set<string>;
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
    liveMcp,
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
          workspaceCheckpointDirectory(directory, workspace),
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
  return { buildTools, buildProbeTools };
};
