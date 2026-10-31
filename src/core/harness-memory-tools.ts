import type { AsyncTaskService } from "../shared/async-tasks";
import type { ModelProvider } from "../shared/contracts";
import { narrowestPermission } from "../shared/permissions";
import type { Permission, SessionId } from "../shared/schemas";
import type { openMemoryStore } from "../store/memory";
import type { openSessionStore } from "../store/sessions";
import { createMemoryToolRegistry } from "../tools/memory";
import { forgeMemory } from "./forge-memory";
import { redactMemoryText } from "./memory-retrieval";

export type HarnessMemoryToolDeps = {
  store: Awaited<ReturnType<typeof openSessionStore>>;
  memories: Awaited<ReturnType<typeof openMemoryStore>>;
  getAsyncTasks: () => Promise<AsyncTaskService>;
  /**
   * Only sessions which actually launch retained async receipts enter this map.
   * Later runs replace the reader so pending commits observe current grants.
   */
  asyncPermissions: Map<SessionId, () => Permission>;
};

/**
 * Memory tools for one run, including background forge_memory receipts whose
 * effective permission can only narrow while they are pending.
 */
export const createHarnessMemoryTools = (
  { store, memories, getAsyncTasks, asyncPermissions }: HarnessMemoryToolDeps,
  provider: ModelProvider,
  apiKey: string,
) =>
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
      // Only ever narrows across reads, so a pending commit cannot widen.
      let ceiling: Permission = toolContext.permission;
      const newOwner = !asyncPermissions.has(main.id);
      if (newOwner) asyncPermissions.set(main.id, () => toolContext.permission);
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
            ...(main.routeGroupId ? { routeGroupId: main.routeGroupId } : {}),
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
                ceiling = narrowestPermission(
                  ceiling,
                  toolContext.permission,
                  asyncPermissions.get(main.id)?.() ?? "readonly",
                );
                return ceiling;
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
  });
