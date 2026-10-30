import type { ModelProvider } from "../shared/contracts";
import type { SessionId, SessionSnapshot, Usage } from "../shared/schemas";
import type { openSessionStore } from "../store/sessions";
import { autoTitle } from "./session-title";
import { createSessionWriter } from "./session-writer";

export type AutoTitleRequest = {
  signal: AbortSignal;
  provider: ModelProvider;
  secrets: readonly string[];
  beginUsage: () => (usage: Usage | undefined) => void;
};

/**
 * Background session naming. Each session has at most one tracked naming
 * operation; harness mutations stop it first, and disposal awaits all of them.
 */
export const createHarnessTitles = (
  store: Awaited<ReturnType<typeof openSessionStore>>,
) => {
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
  const startTitle = (
    claimed: SessionSnapshot,
    apply: (title: string) => Promise<boolean>,
    { signal, provider, secrets, beginUsage }: AutoTitleRequest,
  ): void => {
    const titleController = new AbortController();
    const titleSignal = AbortSignal.any([signal, titleController.signal]);
    const naming = autoTitle({
      snapshot: claimed,
      provider,
      signal: titleSignal,
      secrets,
      beginUsage,
    })
      .then(async (title) => {
        if (!title || titleSignal.aborted || (await apply(title))) return;
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
  };
  return { stopTitle, startTitle, pending: () => [...titleTasks] };
};
