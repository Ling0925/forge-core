import type { WorkItemStore } from "../shared";

export function createCompositeWorkItemStore({
  local,
  board,
  backend,
}: {
  local: WorkItemStore;
  board: WorkItemStore;
  backend: () => Promise<"local" | "board">;
}): WorkItemStore {
  const owner = async (id: string) => ((await local.get(id)) ? local : board);
  return {
    create: async (input) =>
      ((await backend()) === "board" ? board : local).create(input),
    get: async (id) => (await local.get(id)) ?? board.get(id),
    claim: async (id, claimedBy) => (await owner(id)).claim(id, claimedBy),
    update: async (id, update) => (await owner(id)).update(id, update),
    linkThread: async (id, threadId) =>
      (await owner(id)).linkThread(id, threadId),
    unlinkThread: async (id, threadId) =>
      (await owner(id)).unlinkThread(id, threadId),
    linkWorker: async (id, sessionId, worktree) =>
      (await owner(id)).linkWorker(id, sessionId, worktree),
    async list(query) {
      const items = (
        await Promise.all([local.list(query), board.list(query)])
      ).flat();
      return items.sort((a, b) => {
        if (a.createdAt !== b.createdAt)
          return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    },
  };
}
