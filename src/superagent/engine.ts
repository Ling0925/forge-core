import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_ACTIVE_AGENTS,
  ForgeError,
  type HarnessService,
  type InputQueueHost,
  type OutboxItem,
  type SessionId,
  type SessionSnapshot,
  type SettingsStore,
  type SteeringInput,
  type Suggestion,
  type SuperAgentEvent,
  type Thread,
  type Trigger,
  type WorkItem,
  type WorkItemQuery,
  type WorkItemStore,
  sessionIdSchema,
  toErrorInfo,
} from "../shared";
import { type SuperAgentStore, isolateGithubCredentials } from "../store";
import {
  routerInstructions,
  untrustedData,
  workerInstructions,
} from "./prompts";
import { type RouteDecision, createSuperAgentTools } from "./tools";

export interface OutboxExecutor {
  execute(item: OutboxItem): Promise<void>;
}

export interface SuperAgentSessions {
  isRunning(sessionId: SessionId): boolean;
  /** Use the host's RunControl steering handler; false means the run has finished. */
  steer(sessionId: SessionId, input: SteeringInput): Promise<boolean>;
}

export interface SuperAgentDeps {
  stateDirectory: string;
  harness: HarnessService;
  inputQueue: Pick<
    InputQueueHost,
    "notify" | "list" | "cancel" | "pause" | "resume"
  >;
  sessions: SuperAgentSessions;
  store: SuperAgentStore;
  workItems: WorkItemStore;
  settings: Pick<SettingsStore, "getPublic">;
  outbox: OutboxExecutor;
  events: { emit(event: SuperAgentEvent): void };
}

const activeStatuses = ["running", "waiting", "ready", "blocked"] as const;
const routerKey = (workspace: string) => `superagent:router:${workspace}`;
const pendingInput = (state: string) =>
  ["queued", "bound", "blocked", "uncertain"].includes(state);

export function createSuperAgent(deps: SuperAgentDeps) {
  const { harness, inputQueue, sessions, store, workItems, settings, events } =
    deps;
  let operations: Promise<unknown> = Promise.resolve();
  let catchUp: { at: string; error: string } | undefined;
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const operation = operations.then(action);
    operations = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const config = async () => (await settings.getPublic()).superAgent;
  const requireConfig = async () => {
    const value = await config();
    if (!value?.enabled)
      throw new ForgeError(
        "not_found",
        "Super-agent is disabled on this host.",
      );
    if (!value.workspace || !value.routerProfileId || !value.workerProfileId)
      throw new ForgeError(
        "invalid_input",
        "Enable superagent and configure its workspace and profiles.",
      );
    return {
      ...value,
      workspace: value.workspace,
      routerProfileId: value.routerProfileId,
      workerProfileId: value.workerProfileId,
    };
  };
  const requireWork = async (id: string) => {
    const work = await workItems.get(id);
    if (!work)
      throw new ForgeError("invalid_input", "Work item was not found.");
    return work;
  };
  const requireTrigger = async (id: string) => {
    const trigger = await store.getTrigger(id);
    if (!trigger)
      throw new ForgeError("invalid_input", "Trigger was not found.");
    return trigger;
  };
  const requireThread = async (id: string) => {
    const thread = await store.getThread(id);
    if (!thread) throw new ForgeError("invalid_input", "Thread was not found.");
    return thread;
  };
  const publishWork = (work: WorkItem) => {
    events.emit({ type: "superagent_work", work });
    return work;
  };
  const disposition = async (
    trigger: Trigger,
    value: string,
    reason: string | null = null,
  ) => {
    const next = { ...trigger, disposition: value, reason };
    await store.putTrigger(next);
    events.emit({ type: "superagent_trigger", trigger: next });
  };
  const enqueue = (sessionId: SessionId, prompt: string) =>
    inputQueue.notify(
      {
        inputId: randomUUID(),
        input: { sessionId, prompt },
      },
      "superagent",
    );
  const busy = async (id: SessionId) =>
    sessions.isRunning(id) ||
    (await inputQueue.list(id)).items.some((item) =>
      ["queued", "bound"].includes(item.state),
    );
  const router = async (workspace: string) => {
    const saved = await store.getCursor(routerKey(workspace));
    if (saved) return sessionIdSchema.parse(saved);
    const current = await requireConfig();
    const session = await harness.createSessionWithProfile({
      workspace,
      profileId: current.routerProfileId,
      isolation: "shared",
      title: "Superagent Router",
      agentRole: { kind: "router", ownerId: workspace },
    });
    await store.setCursor(routerKey(workspace), session.id);
    return session.id;
  };
  const triggerData = async (triggers: readonly Trigger[]) => ({
    triggers,
    threads: await Promise.all(
      [...new Set(triggers.map((trigger) => trigger.threadId))].map(
        requireThread,
      ),
    ),
  });
  const flushBacklog = async () => {
    const current = await config();
    if (!current?.enabled) return;
    const backlog = await store.listTriggers({ disposition: "backlog" });
    if (!backlog.length) return;
    const configured = await requireConfig();
    const id = await router(configured.workspace);
    if (await busy(id)) return;
    await enqueue(
      id,
      `Route this batch:\n${untrustedData(await triggerData(backlog))}`,
    );
    for (const trigger of backlog) await disposition(trigger, "routing");
  };
  const workPrompt = async (work: WorkItem) => {
    const triggers = await store.listTriggers({ threadIds: work.threadIds });
    return `Work item: ${work.id}\nBrief:\n${work.brief}\n\n${untrustedData(await triggerData(triggers))}`;
  };
  const launchWorker = async (work: WorkItem) => {
    const routerId = sessionIdSchema.parse(work.routerSessionId);
    try {
      let id = work.workerSessionId
        ? sessionIdSchema.parse(work.workerSessionId)
        : undefined;
      if (!id) {
        const session = await harness.createSessionWithProfile({
          workspace: (await harness.getSession(routerId)).workspace,
          profileId: work.profileId,
          isolation: "worktree",
          title: work.id,
          agentRole: { kind: "worker", ownerId: work.id },
        });
        id = session.id;
        await workItems.linkWorker(work.id, id, session.workspace);
      }
      // Keep notify from starting a successful predecessor before resume acknowledges it.
      if (work.workerSessionId) await inputQueue.pause(id);
      await enqueue(id, await workPrompt(work));
      if (work.workerSessionId) await inputQueue.resume(id);
      publishWork(await requireWork(work.id));
    } catch (error) {
      publishWork(
        await workItems.update(work.id, {
          status: "failed",
          progress: toErrorInfo(error).message,
        }),
      );
      throw error;
    }
  };
  const startWorker = async (work: WorkItem) => {
    const claimed = await workItems.claim(work.id, work.routerSessionId);
    if (!claimed) return false;
    if (claimed.pendingStatus !== null) {
      publishWork(claimed);
      return false;
    }
    await launchWorker(claimed);
    return true;
  };
  const drainWorkers = async () => {
    const current = await config();
    if (!current?.enabled) return;
    const works = await workItems.list();
    let occupied = 0;
    for (const work of works) {
      if (
        work.workerSessionId &&
        (await busy(sessionIdSchema.parse(work.workerSessionId)))
      )
        occupied++;
    }
    for (const work of works) {
      if (occupied >= (current.maxWorkers ?? DEFAULT_MAX_ACTIVE_AGENTS)) break;
      if (work.status !== "queued" || work.pendingStatus !== null) continue;
      if (await startWorker(work)) occupied++;
    }
  };
  const createWork = async ({
    threadIds,
    brief,
    routerId,
  }: {
    threadIds: readonly string[];
    brief: string;
    routerId: SessionId;
  }) => {
    const current = await requireConfig();
    const threads = await Promise.all(threadIds.map(requireThread));
    const work = await workItems.create({
      title: threads.map((thread) => thread.title).join("; "),
      brief,
      threadIds,
      profileId: current.workerProfileId,
      routerSessionId: routerId,
    });
    return publishWork(work);
  };
  const workerOwns = async (sessionId: SessionId, workId: string) => {
    const work = await requireWork(workId);
    if (work.workerSessionId !== sessionId)
      throw new ForgeError(
        "invalid_input",
        "This session does not own the work item.",
      );
    return work;
  };
  const read = async (session: SessionSnapshot, ids: readonly string[]) => {
    const work =
      session.agentRole?.kind === "worker"
        ? await workerOwns(session.id, session.agentRole.ownerId)
        : undefined;
    const records = [];
    for (const id of ids) {
      const trigger = await store.getTrigger(id);
      const threadId = trigger?.threadId ?? id;
      if (work && !work.threadIds.includes(threadId))
        throw new ForgeError(
          "invalid_input",
          "This work item is not subscribed to the requested thread.",
        );
      records.push(trigger ?? (await requireThread(id)));
    }
    return { untrustedData: records };
  };
  const haltWorker = async (work: WorkItem) => {
    if (work.workerSessionId) {
      const sessionId = sessionIdSchema.parse(work.workerSessionId);
      for (const item of (await inputQueue.list(sessionId)).items)
        if (pendingInput(item.state))
          await inputQueue.cancel(sessionId, item.inputId);
      await harness.cancelSession(sessionId);
    }
  };
  const stopWorkItem = async (id: string, reason: string) => {
    const work = await serial(async () =>
      publishWork(
        await workItems.update(id, { status: "stopped", progress: reason }),
      ),
    );
    await haltWorker(work);
    await serial(drainWorkers);
    return requireWork(id);
  };
  const route = async (
    routerId: SessionId,
    decisions: readonly RouteDecision[],
  ) => {
    const results: unknown[] = [];
    for (const decision of decisions) {
      if (decision.type === "stop") {
        results.push(await stopWorkItem(decision.work, decision.reason));
        continue;
      }
      results.push(
        await serial(async () => {
          if (decision.type === "ignore") {
            for (const id of decision.triggers)
              await disposition(
                await requireTrigger(id),
                "ignored",
                decision.reason,
              );
            return null;
          }
          if (decision.type === "attach") {
            let work = await requireWork(decision.work);
            for (const thread of decision.threads) {
              await requireThread(thread);
              work = await workItems.linkThread(work.id, thread);
            }
            publishWork(work);
            const triggers = await store.listTriggers({
              threadIds: decision.threads,
              disposition: ["backlog", "routing"],
            });
            if (work.workerSessionId && triggers.length) {
              await deliverWorker(work, triggers);
              for (const trigger of triggers)
                await disposition(trigger, "attached");
            }
            return work;
          }
          const referenced = await Promise.all(
            decision.triggers.map(requireTrigger),
          );
          if (
            !referenced.every((trigger) =>
              decision.threads.includes(trigger.threadId),
            )
          )
            throw new ForgeError(
              "invalid_input",
              "New work must reference triggers from its threads.",
            );
          await Promise.all(decision.threads.map(requireThread));
          const triggers = referenced.filter(
            (trigger) => trigger.disposition !== "ignored",
          );
          if (!triggers.some((trigger) => trigger.explicit)) {
            const suggestion = await store.createSuggestion({
              threadIds: decision.threads,
              triggerIds: decision.triggers,
              brief: decision.brief,
            });
            for (const trigger of triggers)
              await disposition(trigger, "suggested");
            events.emit({ type: "superagent_suggestion", suggestion });
            return suggestion;
          }
          const work = await createWork({
            threadIds: decision.threads,
            brief: decision.brief,
            routerId,
          });
          for (const trigger of triggers)
            await disposition(trigger, "assigned");
          await drainWorkers();
          return requireWork(work.id);
        }),
      );
    }
    return results;
  };
  const deliverWorker = async (
    work: WorkItem,
    triggers: readonly Trigger[],
  ) => {
    const id = sessionIdSchema.parse(work.workerSessionId);
    const prompt = `Updates for ${work.id}:\n${untrustedData(await triggerData(triggers))}`;
    if (sessions.isRunning(id) && (await sessions.steer(id, { prompt })))
      return;
    await enqueue(id, prompt);
  };

  return {
    async getSuperAgentState() {
      const current = await requireConfig();
      return {
        enabled: true as const,
        workspace: current.workspace,
        routerSessionId:
          (await store.getCursor(routerKey(current.workspace))) ?? null,
        ...(catchUp ? { catchUp } : {}),
      };
    },
    reportCatchUpFailure(error: unknown) {
      catchUp = {
        at: new Date().toISOString(),
        error: toErrorInfo(error).message,
      };
      events.emit({ type: "superagent_catch_up", catchUp });
    },
    listSuperAgentTriggers: (
      query?: Parameters<SuperAgentStore["listTriggers"]>[0],
    ) => store.listTriggers(query),
    listWorkItems: (query?: WorkItemQuery) => workItems.list(query),
    getWorkItem: requireWork,
    listSuggestions: (state?: Suggestion["state"]) =>
      store.listSuggestions(state),
    listOutbox: (state?: OutboxItem["state"]) => store.listOutbox(state),
    start: () =>
      serial(async () => {
        await drainWorkers();
        await flushBacklog();
      }),
    /** The host calls this after run completion and after the queue's terminal transition. */
    sessionSettled: () =>
      serial(async () => {
        await drainWorkers();
        await flushBacklog();
      }),
    ingest: (triggers: readonly Trigger[], threads: readonly Thread[]) =>
      serial(async () => {
        const current = await config();
        for (const thread of threads) {
          const existing = await store.getThread(thread.id);
          if (!existing || existing.lastTriggerAt < thread.lastTriggerAt)
            await store.upsertThread(thread);
        }
        for (const trigger of triggers) {
          if (await store.getTrigger(trigger.id)) continue;
          const repo = trigger.threadId.slice(
            "gh:".length,
            trigger.threadId.indexOf("#"),
          );
          const reason =
            trigger.actor.toLowerCase() ===
            current?.github?.login?.toLowerCase()
              ? "Actor is the configured GitHub login."
              : !current?.github?.repos?.some(
                    (configured) =>
                      configured.toLowerCase() === repo.toLowerCase(),
                  )
                ? "Repository is not configured."
                : null;
          await disposition(trigger, reason ? "ignored" : "backlog", reason);
          if (reason || !current?.enabled) continue;
          const subscribers = (
            await workItems.list({
              threadId: trigger.threadId,
              status: activeStatuses,
            })
          ).filter((work) => work.workerSessionId);
          if (!subscribers.length) continue;
          for (const work of subscribers) await deliverWorker(work, [trigger]);
          await disposition(trigger, "forwarded");
        }
        await flushBacklog();
      }),
    stopWorkItem,
    async workChanged(id: string) {
      const stopped = await serial(async () => {
        const work = publishWork(await requireWork(id));
        if (work.status === "stopped") return work;
        if (
          work.status === "running" &&
          work.pendingStatus === null &&
          (!work.workerSessionId ||
            !(await busy(sessionIdSchema.parse(work.workerSessionId))))
        ) {
          await launchWorker(work);
          return;
        }
        await enqueue(
          sessionIdSchema.parse(work.routerSessionId),
          `Work item changed:\n${untrustedData(work)}`,
        );
        await drainWorkers();
      });
      if (stopped) {
        // Cancellation joins Worker tool calls that may be waiting on this queue.
        await haltWorker(stopped);
        await serial(drainWorkers);
      }
    },
    resumeWorkItem: (id: string) =>
      serial(async () => {
        const work = await requireWork(id);
        if (
          work.workerSessionId &&
          (await busy(sessionIdSchema.parse(work.workerSessionId)))
        )
          throw new ForgeError(
            "busy",
            "The Worker still has queued or running input.",
          );
        if (work.workerSessionId) {
          const sessionId = sessionIdSchema.parse(work.workerSessionId);
          for (const item of (await inputQueue.list(sessionId)).items)
            if (item.state === "blocked")
              await inputQueue.cancel(sessionId, item.inputId);
        }
        publishWork(await workItems.update(id, { status: "queued" }));
        await drainWorkers();
        return requireWork(id);
      }),
    decideSuggestion: (id: string, accept: boolean) =>
      serial(async () => {
        const suggestion = await store.getSuggestion(id);
        if (!suggestion || suggestion.state !== "pending")
          throw new ForgeError("invalid_input", "Suggestion is not pending.");
        const work = accept
          ? await createWork({
              threadIds: suggestion.threadIds,
              brief: suggestion.brief,
              routerId: await router((await requireConfig()).workspace),
            })
          : undefined;
        const decided = await store.decideSuggestion(id, work?.id ?? null);
        events.emit({ type: "superagent_suggestion", suggestion: decided });
        if (work) await drainWorkers();
        return decided;
      }),
    async decideOutbox(id: string, approve: boolean) {
      const item = await store.decideOutbox(id, approve);
      events.emit({ type: "superagent_outbox", item });
      if (!approve) return item;
      let result: OutboxItem;
      try {
        await deps.outbox.execute(item);
      } catch (error) {
        result = await store.markOutboxFailed(id, toErrorInfo(error).message);
        events.emit({ type: "superagent_outbox", item: result });
        return result;
      }
      result = await store.markOutboxSent(id);
      events.emit({ type: "superagent_outbox", item: result });
      return result;
    },
    async canReadSession(reader: SessionSnapshot, target: SessionId) {
      if (reader.agentRole?.kind === "worker") {
        const work = await workItems.get(reader.agentRole.ownerId);
        if (work?.workerSessionId !== reader.id) return false;
        return work.routerSessionId === target;
      }
      if (
        reader.agentRole?.kind !== "router" ||
        (await store.getCursor(routerKey(reader.agentRole.ownerId))) !==
          reader.id
      )
        return false;
      const work = (await workItems.list()).find(
        (item) => item.workerSessionId === target,
      );
      return work !== undefined && work.routerSessionId === reader.id;
    },
    sessionTools(session: SessionSnapshot) {
      const role = session.agentRole;
      if (!role) return undefined;
      const registry = createSuperAgentTools(role.kind, {
        read: ({ ids }) => read(session, ids),
        list: async () => ({
          workItems: await workItems.list(),
          suggestions: await store.listSuggestions("pending"),
          triggers: await store.listTriggers({
            disposition: ["backlog", "routing"],
          }),
        }),
        route: ({ decisions }) => route(session.id, decisions),
        report: ({ status, progress }) =>
          serial(async () => {
            const work = await workerOwns(session.id, role.ownerId);
            if (work.status === "stopped")
              throw new ForgeError("invalid_input", "Work item is stopped.");
            const updated = publishWork(
              await workItems.update(work.id, { status, progress }),
            );
            await enqueue(
              sessionIdSchema.parse(work.routerSessionId),
              `Worker report:\n${untrustedData(updated)}`,
            );
            return updated;
          }),
        follow: ({ thread }) =>
          serial(async () => {
            const work = await workerOwns(session.id, role.ownerId);
            await requireThread(thread);
            return publishWork(await workItems.linkThread(work.id, thread));
          }),
        unfollow: ({ thread }) =>
          serial(async () =>
            publishWork(
              await workItems.unlinkThread(
                (await workerOwns(session.id, role.ownerId)).id,
                thread,
              ),
            ),
          ),
        handback: ({ triggers, reason }) =>
          serial(async () => {
            await read(session, triggers);
            for (const id of triggers)
              await disposition(await requireTrigger(id), "backlog", reason);
            await flushBacklog();
            return null;
          }),
        send: (input) =>
          serial(async () => {
            const work = await workerOwns(session.id, role.ownerId);
            const item = await store.createOutboxItem({
              ...input,
              workId: work.id,
            });
            events.emit({ type: "superagent_outbox", item });
            return item;
          }),
      });
      return {
        registry,
        ...(role.kind === "worker"
          ? {
              transformCommandEnv: (env: Record<string, string | undefined>) =>
                isolateGithubCredentials(env, deps.stateDirectory),
            }
          : {}),
        instructions:
          role.kind === "router" ? routerInstructions : workerInstructions,
      };
    },
  };
}
