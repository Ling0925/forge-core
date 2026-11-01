import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type WorkItem,
  type WorkerMessage,
  sessionIdSchema,
} from "../../src/shared";
import {
  createBoardClient,
  createBoardWorkItemStore,
  openSettingsStore,
  openSuperAgentStore,
} from "../../src/store";
import { boardFixture } from "./board-fixture";
import { call, done, hold } from "./fixture";
import { payload } from "./github-fixture";
import { hostFixture } from "./host-fixture";

const secondPayload = (explicit: boolean) => ({
  ...payload,
  issue: { ...payload.issue, id: 102, number: 2 },
  comment: {
    ...payload.comment,
    id: 202,
    body: explicit ? "@forge-bot please investigate" : "A useful improvement",
  },
});
function route(
  messages: readonly { role: string; content: unknown }[],
  routed: Set<string>,
) {
  const text = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  for (const [id, number] of [
    [201, 1],
    [202, 2],
  ]) {
    const trigger = `gh:comment:${id}`;
    if (!text.includes(trigger) || routed.has(trigger)) continue;
    routed.add(trigger);
    return call("superagent_route", {
      decisions: [
        {
          type: "new",
          threads: [`gh:owner/repo#${number}`],
          triggers: [trigger],
          brief: `Investigate ${number}`,
        },
      ],
    });
  }
  return done;
}

it("runs the Super-agent flow against the board, keeps local work, and keeps the token out of Workers", async () => {
  const board = await boardFixture();
  const routed = new Set<string>();
  const steps = new Map<string, number>();
  const gate = hold();
  const visible: unknown[] = [];
  const events: WorkerMessage[] = [];
  let local!: WorkItem;
  let f: Awaited<ReturnType<typeof hostFixture>> | undefined;
  try {
    f = await hostFixture({
      board: board.config,
      localTools: true,
      beforeStart: async (directory) => {
        const store = await openSuperAgentStore(directory);
        try {
          const created = await store.workItems.create({
            title: "Existing local work",
            brief: "Keep local",
            threadIds: [],
            profileId: "worker",
            routerSessionId: randomUUID(),
          });
          local = await store.workItems.update(created.id, {
            status: "stopped",
          });
        } finally {
          await store.close();
        }
      },
      providerFactory: () => ({
        listModels: async () => ["fixture"],
        complete: async (messages, tools, options) => {
          if (tools.some((tool) => tool.function.name === "superagent_route"))
            return route(messages, routed);
          if (!tools.some((tool) => tool.function.name === "superagent_report"))
            return done;
          visible.push(messages);
          const step = steps.get(options.sessionId!) ?? 0;
          steps.set(options.sessionId!, step + 1);
          if (step === 0)
            return call("superagent_send", {
              kind: "comment",
              target: { thread: "gh:owner/repo#1" },
              body: { text: "Investigation ready" },
            });
          if (step === 1)
            return call("run_command", {
              argv: [
                process.execPath,
                "-e",
                "require('node:fs').writeFileSync('worker-env.json', JSON.stringify(process.env)); process.stdout.write(JSON.stringify(process.env))",
              ],
              timeout_ms: 5000,
            });
          if (step === 2) {
            await gate.step(messages, tools, options);
            return call("superagent_report", {
              status: "done",
              progress: "Investigation complete",
            });
          }
          return done;
        },
      }),
    });
    const host = f;
    host.runtime.subscribe((event) => {
      events.push(event);
      if (
        event.kind === "event" &&
        "event" in event.data &&
        event.data.event.type === "approval_requested"
      ) {
        void host.runtime.request({
          id: randomUUID(),
          method: "answerApproval",
          runId: event.data.runId,
          approvalId: event.data.event.request.id,
          approved: true,
        });
      }
    });
    expect((await host.send(payload, "unsigned", false)).status).toBe(401);
    expect((await host.send(payload, "signed")).status).toBe(202);
    expect((await host.send(payload, "signed")).status).toBe(409);
    await vi.waitFor(
      async () => {
        expect(await board.tasks()).toMatchObject([
          {
            status: "in_progress",
            links: expect.arrayContaining([
              { kind: "session", ref: expect.any(String) },
            ]),
          },
        ]);
      },
      { timeout: 15000 },
    );
    await gate.entered;
    const [task] = await board.tasks();
    const workResponse = await host.rpc({
      method: "getWorkItem",
      workId: task!.id,
    });
    if (!workResponse.ok || workResponse.method !== "getWorkItem")
      throw new Error("Missing board work");
    const work = workResponse.result;
    expect(task).toMatchObject({
      title: payload.issue.title,
      description: "Investigate 1",
      accountable: board.accountable,
      links: expect.arrayContaining([
        { kind: "thread", ref: "gh:owner/repo#1" },
        { kind: "session", ref: `forge:session:${work.workerSessionId}` },
      ]),
      metadata: {
        forge: {
          profileId: "worker",
          routerSessionId: work.routerSessionId,
          worktree: work.worktree,
        },
      },
    });
    expect(work.worktree).not.toBe(host.workspace);
    const env = JSON.parse(
      await readFile(join(work.worktree!, "worker-env.json"), "utf8"),
    );
    expect(env).toHaveProperty("PATH");
    expect(JSON.stringify(env)).not.toContain(board.token);
    expect(JSON.stringify(process.env)).not.toContain(board.token);
    expect(await host.rpc({ method: "listWorkItems" })).toMatchObject({
      ok: true,
      result: [local, expect.objectContaining({ id: task!.id })],
    });
    const outbox = await host.rpc({ method: "listOutbox", state: "pending" });
    if (!outbox.ok || outbox.method !== "listOutbox")
      throw new Error("Missing outbox");
    expect(outbox.result).toHaveLength(1);
    expect(host.outbox.execute).not.toHaveBeenCalled();
    expect(
      await host.rpc({
        method: "decideOutbox",
        outboxId: outbox.result[0]!.id,
        approve: true,
      }),
    ).toMatchObject({ ok: true, result: { state: "sent" } });
    expect(
      await host.rpc({
        method: "decideOutbox",
        outboxId: outbox.result[0]!.id,
        approve: true,
      }),
    ).toMatchObject({ ok: false });
    expect(host.outbox.execute).toHaveBeenCalledOnce();
    gate.release();
    await vi.waitFor(
      async () =>
        expect(await board.task(task!.id)).toMatchObject({
          status: "done",
          progress: "Investigation complete",
          lease: null,
        }),
      { timeout: 15000 },
    );
    expect((await host.send(secondPayload(false))).status).toBe(202);
    await vi.waitFor(
      async () =>
        expect(
          await host.rpc({ method: "listSuggestions", state: "pending" }),
        ).toMatchObject({
          ok: true,
          result: [{ triggerIds: ["gh:comment:202"] }],
        }),
      { timeout: 15000 },
    );
    expect(await board.tasks()).toHaveLength(1);
    const suggestions = await host.rpc({ method: "listSuggestions" });
    if (!suggestions.ok || suggestions.method !== "listSuggestions")
      throw new Error("Missing suggestions");
    expect(
      await host.rpc({
        method: "decideSuggestion",
        suggestionId: suggestions.result[0]!.id,
        accept: true,
      }),
    ).toMatchObject({ ok: true, result: { state: "accepted" } });
    await vi.waitFor(
      async () =>
        expect(await board.tasks()).toMatchObject([
          { status: "done" },
          { status: "done" },
        ]),
      { timeout: 15000 },
    );
    expect(steps.size).toBe(2);
    expect(host.outbox.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(visible)).toContain('"role":"tool"');
    expect(JSON.stringify(visible)).toContain("Investigation complete");
    expect(JSON.stringify(visible)).not.toContain(board.token);
    expect(JSON.stringify(events)).not.toContain(board.token);
    expect(JSON.stringify(await host.harness.getSettings())).not.toContain(
      board.token,
    );
    const localStore = await openSuperAgentStore(join(host.directory, "state"));
    try {
      expect(await localStore.workItems.list()).toEqual([local]);
    } finally {
      await localStore.close();
    }
  } finally {
    gate.release();
    await f?.close();
    await board.close();
  }
}, 45000);

it("maps adapter operations to real board transitions, approvals, metadata and idempotent links", async () => {
  const board = await boardFixture();
  try {
    const settings = await openSettingsStore(join(board.directory, "forge"));
    await settings.update({
      settings: { superAgent: { board: board.config } },
    });
    const store = createBoardWorkItemStore({
      client: createBoardClient({ url: board.url, settings }),
      projectId: board.projectId,
      accountable: board.accountable,
    });
    const work = await store.create({
      title: "Adapter work",
      brief: "Description",
      threadIds: ["thread-1"],
      profileId: "worker",
      routerSessionId: "router",
    });
    expect(work).toMatchObject({
      status: "queued",
      pendingStatus: null,
      progress: null,
      claimedBy: null,
    });
    let task = await board.task(work.id);
    await store.linkThread(work.id, "thread-1");
    await store.unlinkThread(work.id, "absent");
    expect((await board.task(work.id)).version).toBe(task.version);
    await store.linkThread(work.id, "thread-2");
    expect(await store.unlinkThread(work.id, "thread-1")).toMatchObject({
      threadIds: ["thread-2"],
    });
    expect(
      await store.list({ status: ["queued", "running"], threadId: "thread-2" }),
    ).toHaveLength(1);
    expect(await store.list({ status: [] })).toEqual([]);
    expect(await store.claim(work.id, "router")).toMatchObject({
      status: "running",
      claimedBy: "router",
    });
    expect(await store.claim(work.id, "router")).toBeUndefined();
    expect(
      await store.linkWorker(work.id, "session", "/worktree"),
    ).toMatchObject({ workerSessionId: "session", worktree: "/worktree" });
    task = await board.task(work.id);
    expect(task.metadata).toEqual({
      forge: {
        profileId: "worker",
        routerSessionId: "router",
        worktree: "/worktree",
      },
    });
    expect(task.links).toContainEqual({
      kind: "session",
      ref: "forge:session:session",
    });
    expect(
      await store.update(work.id, { progress: "Progress only" }),
    ).toMatchObject({ status: "running", progress: "Progress only" });
    expect(await store.update(work.id, { progress: null })).toMatchObject({
      progress: null,
    });
    expect((await board.task(work.id)).progress).toBe("");
    expect(await store.update(work.id, { status: "blocked" })).toMatchObject({
      status: "blocked",
    });
    expect(
      await store.update(work.id, { status: "done", progress: "Finished" }),
    ).toMatchObject({ status: "done", progress: "Finished" });
    const history = z
      .object({
        items: z.array(
          z.object({ type: z.string(), data: z.record(z.unknown()) }),
        ),
      })
      .parse(await board.request(`/v1/events?task=${work.id}`));
    expect(
      history.items
        .filter((event) => event.type === "task_transitioned")
        .map((event) => event.data),
    ).toEqual([
      { from: "in_progress", to: "blocked" },
      { from: "blocked", to: "in_progress" },
      { from: "in_progress", to: "done" },
    ]);
    await store.update(work.id, { status: "queued" });
    await store.claim(work.id, "router");
    expect(await store.update(work.id, { status: "waiting" })).toMatchObject({
      status: "waiting",
    });
    expect(await store.update(work.id, { status: "ready" })).toMatchObject({
      status: "ready",
    });
    expect(await store.update(work.id, { status: "failed" })).toMatchObject({
      status: "failed",
    });
    await store.update(work.id, { status: "queued" });
    await store.claim(work.id, "router");
    await board.request(`/v1/projects/${board.projectId}`, {
      method: "PATCH",
      body: JSON.stringify({
        settings: { approvalRequired: ["in_progress->done"] },
      }),
    });
    await expect(
      store.update(work.id, { status: "stopped" }),
    ).rejects.toMatchObject({ message: "Only a human may cancel a task" });
    expect(
      await store.update(work.id, {
        status: "done",
        progress: "Awaiting review",
      }),
    ).toMatchObject({
      status: "running",
      pendingStatus: "done",
      progress: "Awaiting review",
    });
    expect(await store.list()).toMatchObject([{ pendingStatus: "done" }]);
    const approvals = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(
        await board.request(
          `/v1/approvals?project=${board.projectId}&state=pending`,
        ),
      );
    task = await board.task(work.id);
    await board.request(`/v1/approvals/${approvals.items[0]!.id}/decide`, {
      method: "POST",
      headers: { "If-Match": `"${task.version}"` },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(await store.get(work.id)).toMatchObject({
      status: "done",
      pendingStatus: null,
    });
    await board.request(`/v1/projects/${board.projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ settings: { allowAgentCancel: true } }),
    });
    await store.update(work.id, { status: "queued" });
    expect(await store.update(work.id, { status: "stopped" })).toMatchObject({
      status: "stopped",
    });
    expect((await board.task(work.id)).status).toBe("canceled");
    const unrelated = z.object({ id: z.string() }).parse(
      await board.request("/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId: board.projectId,
          accountable: board.accountable,
          title: "Human task",
        }),
      }),
    );
    expect(await store.get(unrelated.id)).toBeUndefined();
    expect(await store.get("missing")).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  } finally {
    await board.close();
  }
}, 45000);

it("receives human cancellation and launches only after approval of a pending claim", async () => {
  const board = await boardFixture();
  const routed = new Set<string>();
  const gate = hold();
  const workers = new Set<string>();
  let f: Awaited<ReturnType<typeof hostFixture>> | undefined;
  try {
    f = await hostFixture({
      board: board.config,
      providerFactory: () => ({
        listModels: async () => ["fixture"],
        complete: async (messages, tools, options) => {
          if (tools.some((tool) => tool.function.name === "superagent_route"))
            return route(messages, routed);
          if (
            tools.some((tool) => tool.function.name === "superagent_report")
          ) {
            workers.add(options.sessionId!);
            return gate.step(messages, tools, options);
          }
          return done;
        },
      }),
    });
    const host = f;
    await host.send(payload);
    await gate.entered;
    const [task] = await board.tasks();
    const workerId = sessionIdSchema.parse(
      task!.links
        .find((link) => link.kind === "session")!
        .ref.replace("forge:session:", ""),
    );
    await board.transition(task!.id, "canceled");
    await vi.waitFor(
      async () => {
        expect(
          await host.rpc({ method: "getWorkItem", workId: task!.id }),
        ).toMatchObject({ ok: true, result: { status: "stopped" } });
        expect(await host.harness.getSession(workerId)).toMatchObject({
          status: "cancelled",
        });
      },
      { timeout: 15000 },
    );
    await board.request(`/v1/projects/${board.projectId}`, {
      method: "PATCH",
      body: JSON.stringify({
        settings: {
          allowAgentCancel: true,
          approvalRequired: ["todo->in_progress"],
        },
      }),
    });
    await host.send(secondPayload(true));
    await vi.waitFor(
      async () =>
        expect(
          await host.rpc({
            method: "listWorkItems",
            query: { status: "queued" },
          }),
        ).toMatchObject({
          ok: true,
          result: [{ pendingStatus: "running", workerSessionId: null }],
        }),
      { timeout: 15000 },
    );
    const pending = (await board.tasks()).find(
      (item) => item.status === "todo",
    )!;
    const approvalPath = `/v1/approvals?project=${board.projectId}&state=pending`;
    const approvals = z
      .object({
        items: z.array(
          z.object({ id: z.string(), action: z.string(), taskId: z.string() }),
        ),
      })
      .parse(await board.request(approvalPath));
    expect(approvals.items).toEqual([
      { id: expect.any(String), action: "claim", taskId: pending.id },
    ]);
    expect(workers.size).toBe(1);
    await board.request(`/v1/approvals/${approvals.items[0]!.id}/decide`, {
      method: "POST",
      headers: { "If-Match": `"${pending.version}"` },
      body: JSON.stringify({ decision: "approved" }),
    });
    await vi.waitFor(
      async () => {
        expect(
          await host.rpc({ method: "getWorkItem", workId: pending.id }),
        ).toMatchObject({
          ok: true,
          result: {
            status: "running",
            pendingStatus: null,
            workerSessionId: expect.any(String),
          },
        });
        expect(workers.size).toBe(2);
      },
      { timeout: 15000 },
    );
    expect(
      (await board.tasks()).find((item) => item.id === pending.id),
    ).toMatchObject({ status: "in_progress" });
    expect(
      z
        .object({ items: z.array(z.unknown()) })
        .parse(await board.request(approvalPath)).items,
    ).toEqual([]);
  } finally {
    gate.release();
    await f?.close();
    await board.close();
  }
}, 45000);
