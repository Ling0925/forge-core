import { z } from "zod";
import {
  ForgeError,
  type WorkItem,
  type WorkItemStatus,
  type WorkItemStore,
  createWorkItemSchema,
  workItemQuerySchema,
  workItemSchema,
  workItemUpdateSchema,
} from "../shared";
import {
  BoardRequestError,
  type BoardTask,
  boardApprovalSchema,
  boardTaskSchema,
  type createBoardClient,
} from "./board-api";

const statuses = {
  queued: "todo",
  running: "in_progress",
  waiting: "input_required",
  ready: "in_review",
  blocked: "blocked",
  failed: "failed",
  stopped: "canceled",
  done: "done",
} as const;
const coreStatuses: Record<BoardTask["status"], WorkItemStatus> = {
  todo: "queued",
  in_progress: "running",
  input_required: "waiting",
  in_review: "ready",
  blocked: "blocked",
  failed: "failed",
  canceled: "stopped",
  done: "done",
};
const forgeSchema = z
  .object({
    profileId: z.string(),
    routerSessionId: z.string(),
    worktree: z.string().nullable(),
  })
  .passthrough();
const readSchema = boardTaskSchema.extend({
  links: z.array(z.object({ kind: z.string(), ref: z.string() })),
});
const transitionSchema = z.object({
  task: boardTaskSchema,
  approval: boardApprovalSchema.nullable(),
});
const taskPath = (id: string) => `/v1/tasks/${encodeURIComponent(id)}`;

export function createBoardWorkItemStore({
  client,
  projectId,
  accountable,
}: {
  client: ReturnType<typeof createBoardClient>;
  projectId: string;
  accountable: string;
}): WorkItemStore {
  const approvals = () =>
    client.pages(
      `/v1/approvals?${new URLSearchParams({ project: projectId, state: "pending" })}`,
      boardApprovalSchema,
    );
  const toWork = (
    task: z.infer<typeof readSchema>,
    pending: z.infer<typeof boardApprovalSchema>[],
  ): WorkItem | undefined => {
    if (task.projectId !== projectId || task.metadata.forge === undefined)
      return undefined;
    const forge = forgeSchema.parse(task.metadata.forge);
    const approval = pending.find((item) => item.taskId === task.id);
    const session = task.links.find((link) => link.kind === "session");
    return workItemSchema.parse({
      id: task.id,
      title: task.title,
      brief: task.description,
      status: coreStatuses[task.status],
      pendingStatus: approval ? coreStatuses[approval.to] : null,
      threadIds: task.links
        .filter((link) => link.kind === "thread")
        .map((link) => link.ref),
      workerSessionId: session
        ? session.ref.replace(/^forge:session:/, "")
        : null,
      profileId: forge.profileId,
      routerSessionId: forge.routerSessionId,
      worktree: forge.worktree,
      progress: task.progress === "" ? null : task.progress,
      claimedBy: task.lease ? forge.routerSessionId : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  };
  const read = async (id: string) =>
    readSchema.parse(await client.json(`${taskPath(id)}?include=links`));
  const get = async (id: string) => {
    let task: z.infer<typeof readSchema>;
    try {
      task = await read(id);
    } catch (error) {
      if (error instanceof BoardRequestError && error.status === 404)
        return undefined;
      throw error;
    }
    return toWork(task, await approvals());
  };
  const requireWork = async (id: string) => {
    const work = await get(id);
    if (!work) throw new ForgeError("not_found", "Work item was not found.");
    return work;
  };
  const mutate = async <T>(
    initial: BoardTask,
    method: string,
    suffix: string,
    body: (task: BoardTask) => object,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> => {
    let task = initial;
    for (;;) {
      try {
        return schema.parse(
          await client.json(`${taskPath(task.id)}${suffix}`, {
            method,
            headers: { "If-Match": `"${task.version}"` },
            body: JSON.stringify({
              ...body(task),
              ...(task.lease ? { leaseToken: task.lease.token } : {}),
            }),
          }),
        );
      } catch (error) {
        if (!(error instanceof BoardRequestError)) throw error;
        const current = error.currentTask;
        if (
          !(
            (error.status === 412 && error.boardCode === "version_mismatch") ||
            (error.status === 409 && error.boardCode === "lease_lost")
          ) ||
          !current ||
          current.status !== task.status ||
          current.lease?.holder !== task.lease?.holder ||
          (current.version === task.version &&
            current.lease?.token === task.lease?.token)
        )
          throw error;
        task = current;
      }
    }
  };
  const link = async (id: string, method: string, kind: string, ref: string) =>
    mutate(
      await read(id),
      method,
      "/links",
      () => ({ kind, ref }),
      method === "POST"
        ? z.object({ task: boardTaskSchema }).transform((value) => value.task)
        : boardTaskSchema,
    );
  return {
    get,
    async list(raw = {}) {
      const query = workItemQuerySchema.parse(raw);
      const params = new URLSearchParams({
        project: projectId,
        include: "links",
      });
      if (query.status !== undefined) {
        const values =
          typeof query.status === "string" ? [query.status] : query.status;
        if (!values.length) return [];
        params.set(
          "status",
          values.map((status) => statuses[status]).join(","),
        );
      }
      if (query.threadId !== undefined) params.set("link", query.threadId);
      const tasks = await client.pages(`/v1/tasks?${params}`, readSchema);
      const pending = await approvals();
      return tasks.flatMap((task) => {
        const work = toWork(task, pending);
        return work ? [work] : [];
      });
    },
    async create(raw) {
      const input = createWorkItemSchema.parse(raw);
      const task = boardTaskSchema.parse(
        await client.json("/v1/tasks", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            accountable,
            title: input.title,
            description: input.brief,
            links: input.threadIds.map((ref) => ({ kind: "thread", ref })),
            metadata: {
              forge: {
                profileId: input.profileId,
                routerSessionId: input.routerSessionId,
                worktree: input.worktree ?? null,
              },
            },
          }),
        }),
      );
      return requireWork(task.id);
    },
    async claim(id) {
      const task = await read(id);
      const work = toWork(task, await approvals());
      if (work && work.pendingStatus !== null) return work;
      try {
        await mutate(task, "POST", "/claim", () => ({}), transitionSchema);
      } catch (error) {
        if (
          error instanceof BoardRequestError &&
          error.boardCode === "claim_conflict"
        )
          return undefined;
        throw error;
      }
      return requireWork(id);
    },
    async update(id, raw) {
      const update = workItemUpdateSchema.parse(raw);
      let task: BoardTask = await read(id);
      const to =
        update.status === undefined ? task.status : statuses[update.status];
      const progress =
        update.progress === undefined
          ? {}
          : { progress: update.progress ?? "" };
      if (to !== task.status) {
        try {
          await mutate(
            task,
            "POST",
            "/transition",
            () => ({ to, ...progress }),
            transitionSchema,
          );
        } catch (error) {
          if (
            !(error instanceof BoardRequestError) ||
            error.boardCode !== "invalid_transition" ||
            task.status === "in_progress"
          )
            throw error;
          const result = await mutate(
            task,
            "POST",
            "/transition",
            () => ({ to: "in_progress" }),
            transitionSchema,
          );
          if (result.approval) return requireWork(id);
          task = result.task;
          await mutate(
            task,
            "POST",
            "/transition",
            () => ({ to, ...progress }),
            transitionSchema,
          );
        }
      } else if (update.progress !== undefined) {
        await mutate(task, "PATCH", "", () => progress, boardTaskSchema);
      }
      return requireWork(id);
    },
    async linkThread(id, threadId) {
      await link(id, "POST", "thread", threadId);
      return requireWork(id);
    },
    async unlinkThread(id, threadId) {
      await link(id, "DELETE", "thread", threadId);
      return requireWork(id);
    },
    async linkWorker(id, sessionId, worktree) {
      const task = await link(
        id,
        "POST",
        "session",
        `forge:session:${sessionId}`,
      );
      if (worktree !== undefined)
        await mutate(
          task,
          "PATCH",
          "",
          (current) => ({
            metadata: {
              ...current.metadata,
              forge: { ...forgeSchema.parse(current.metadata.forge), worktree },
            },
          }),
          boardTaskSchema,
        );
      return requireWork(id);
    },
  };
}
