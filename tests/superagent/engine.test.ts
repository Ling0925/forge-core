import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ForgeError,
  type SessionSnapshot,
  sessionIdSchema,
  superAgentEventSchema,
} from "../../src/shared";
import { createSuperAgent } from "../../src/superagent";
import {
  routerInstructions,
  workerInstructions,
} from "../../src/superagent/prompts";
import {
  call,
  done,
  fixture,
  hold,
  newDecision,
  thread,
  trigger,
} from "./fixture";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
  for (const item of f.items) {
    expect(item.input?.prompt).not.toContain(routerInstructions);
    expect(item.input?.prompt).not.toContain(workerInstructions);
  }
});

it("persists idempotently and records deterministic filter reasons", async () => {
  const self = trigger("self", { actor: "forge-bot" });
  const foreign = trigger("foreign", { threadId: "gh:elsewhere/repo#1" });
  await f.ingest(self, foreign);
  expect(await f.store.listTriggers()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: self.id,
        disposition: "ignored",
        reason: "Actor is the configured GitHub login.",
      }),
      expect.objectContaining({
        id: foreign.id,
        disposition: "ignored",
        reason: "Repository is not configured.",
      }),
    ]),
  );
  expect(await f.harness.listSessions()).toEqual([]);
  const event = trigger("1");
  await Promise.all([f.ingest(event), f.ingest(event)]);
  expect(f.items).toHaveLength(1);
  await f.ingest({
    ...event,
    explicit: false,
    summary: "Replay changed content",
  });
  expect(await f.store.getTrigger(event.id)).toMatchObject({
    explicit: true,
    disposition: "routing",
    summary: event.summary,
  });
  expect(
    f.events.every((event) => superAgentEventSchema.safeParse(event).success),
  ).toBe(true);
});

it("batches all backlog after the busy Router finishes", async () => {
  await f.ingest(trigger("1"));
  const router = await f.router();
  const gate = hold();
  const run = f.runNext(router.id, [gate.step]);
  await gate.entered;
  await f.ingest(trigger("2"));
  await f.ingest(trigger("3"));
  expect(f.items).toHaveLength(1);
  gate.release();
  await run;
  expect(f.items).toHaveLength(2);
  expect(f.items[1]).toMatchObject({
    sessionId: router.id,
    origin: "superagent",
  });
  expect(f.items[1]?.input?.prompt).toContain('"id":"gh:2"');
  expect(f.items[1]?.input?.prompt).toContain('"id":"gh:3"');
  await f.engine.sessionSettled();
  expect(f.items).toHaveLength(2);
});

it("creates an isolated profile Worker only for an explicit new decision", async () => {
  const work = await f.createWork();
  expect(work).toMatchObject({
    status: "running",
    profileId: "worker",
    threadIds: ["gh:owner/repo#1"],
  });
  const session = await f.harness.getSession(
    sessionIdSchema.parse(work.workerSessionId),
  );
  expect(session).toMatchObject({
    agentRole: { kind: "worker", ownerId: work.id },
    agentProfileId: "worker",
    agentWorktree: { repository: f.workspace },
  });
  expect(session.workspace).not.toBe(f.workspace);
  expect(f.items[1]).toMatchObject({
    origin: "superagent",
    input: { sessionId: session.id },
  });
  expect(f.items[1]?.input?.prompt).toContain("<untrusted_data>");
  expect(f.items[1]?.input?.prompt).toContain(work.brief);
  expect(
    await f.runNext(session.id, [
      async (messages) => {
        expect(
          messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n"),
        ).toContain(workerInstructions);
        return done;
      },
    ]),
  ).toMatchObject({ status: "completed" });
  await f.ingest(trigger("2"));
  expect(
    await f.runNext((await f.router()).id, [
      async (messages) => {
        expect(
          messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n"),
        ).toContain(routerInstructions);
        return done;
      },
    ]),
  ).toMatchObject({ status: "completed" });
});

it("creates a Suggestion for non-explicit work and accepts it exactly once", async () => {
  const event = trigger("1", { explicit: false });
  await f.ingest(event);
  await f.runNext((await f.router()).id, [
    call("superagent_route", { decisions: [newDecision(event)] }),
  ]);
  expect(await f.store.workItems.list()).toEqual([]);
  const suggestion = (await f.store.listSuggestions())[0]!;
  expect(suggestion).toMatchObject({
    state: "pending",
    triggerIds: [event.id],
  });
  const decisions = await Promise.allSettled([
    f.engine.decideSuggestion(suggestion.id, true),
    f.engine.decideSuggestion(suggestion.id, true),
  ]);
  expect(decisions.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const works = await f.store.workItems.list();
  expect(works).toHaveLength(1);
  expect(works[0]).toMatchObject({
    status: "running",
    brief: suggestion.brief,
  });
  expect(await f.store.getSuggestion(suggestion.id)).toMatchObject({
    state: "accepted",
    workId: works[0]?.id,
  });
});

it("rejects suggestions without creating Workers", async () => {
  const event = trigger("1", { explicit: false });
  await f.ingest(event);
  await f.runNext((await f.router()).id, [
    call("superagent_route", { decisions: [newDecision(event)] }),
  ]);
  const suggestion = (await f.store.listSuggestions())[0]!;
  expect(await f.engine.decideSuggestion(suggestion.id, false)).toMatchObject({
    state: "rejected",
  });
  expect(await f.store.workItems.list()).toEqual([]);
});

it("steers a subscribed running Worker through the runtime steering handler", async () => {
  const work = await f.createWork();
  const id = sessionIdSchema.parse(work.workerSessionId);
  const gate = hold();
  const run = f.runNext(id, [gate.step]);
  await gate.entered;
  const event = trigger("update", { threadId: work.threadIds[0]! });
  await f.ingest(event);
  expect(f.sessions.steer).toHaveBeenCalledTimes(1);
  expect(f.sessions.steer).toHaveBeenCalledWith(id, {
    prompt: expect.not.stringContaining(workerInstructions),
  });
  expect(f.items).toHaveLength(2);
  expect(await f.store.getTrigger(event.id)).toMatchObject({
    disposition: "forwarded",
  });
  expect(
    JSON.stringify((await f.harness.getSession(id)).pendingSteering),
  ).toContain(event.id);
  gate.release();
  const result = await run;
  expect(
    result.messages.some(
      (message) =>
        message.role === "user" && message.content?.includes(event.id),
    ),
  ).toBe(true);
});

it("enqueues trusted input for a subscribed idle Worker", async () => {
  const work = await f.createWork();
  await f.runNext(sessionIdSchema.parse(work.workerSessionId));
  await f.ingest(trigger("update", { threadId: work.threadIds[0]! }));
  expect(f.items.at(-1)).toMatchObject({
    sessionId: work.workerSessionId,
    origin: "superagent",
    state: "queued",
  });
  expect(f.sessions.steer).not.toHaveBeenCalled();
});

it("keeps work queued at maxWorkers and starts it when a session settles", async () => {
  await f.harness.updateSettings({
    settings: { superAgent: { maxWorkers: 1 } },
  });
  const first = trigger("1");
  const second = trigger("2");
  await f.ingest(first, second);
  await f.runNext((await f.router()).id, [
    call("superagent_route", {
      decisions: [newDecision(first), newDecision(second)],
    }),
  ]);
  let works = await f.store.workItems.list();
  const queued = works.find((work) => work.status === "queued")!;
  const running = works.find((work) => work.status === "running")!;
  expect(queued.workerSessionId).toBeNull();
  await f.runNext(sessionIdSchema.parse(running.workerSessionId), [
    call("superagent_report", { status: "done", progress: "Completed." }),
  ]);
  works = await f.store.workItems.list();
  expect(works.find((work) => work.id === queued.id)).toMatchObject({
    status: "running",
    workerSessionId: expect.any(String),
  });
});

it.each(["ready", "blocked", "failed", "done"])(
  "forwards a %s report as trusted Router input",
  async (status) => {
    const work = await f.createWork();
    await f.runNext(sessionIdSchema.parse(work.workerSessionId), [
      call("superagent_report", { status, progress: "Result details" }),
    ]);
    expect(await f.store.workItems.get(work.id)).toMatchObject({
      status,
      progress: "Result details",
    });
    expect(f.items.at(-1)).toMatchObject({
      sessionId: (await f.router()).id,
      origin: "superagent",
    });
    expect(f.items.at(-1)?.input?.prompt).toContain("Result details");
  },
);

it("keeps outbox pending until approval and never executes a rejection", async () => {
  const work = await f.createWork();
  const input = {
    kind: "comment",
    target: { thread: work.threadIds[0] },
    body: { text: "Response" },
  };
  await f.runNext(sessionIdSchema.parse(work.workerSessionId), [
    call("superagent_send", input),
    call("superagent_send", input),
  ]);
  const items = await f.store.listOutbox();
  expect(items.map((item) => item.state)).toEqual(["pending", "pending"]);
  expect(f.outbox.execute).not.toHaveBeenCalled();
  expect(await f.engine.decideOutbox(items[0]!.id, false)).toMatchObject({
    state: "rejected",
  });
  expect(f.outbox.execute).not.toHaveBeenCalled();
  expect(await f.engine.decideOutbox(items[1]!.id, true)).toMatchObject({
    state: "sent",
    sentAt: expect.any(String),
  });
  expect(f.outbox.execute).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: items[1]!.id, state: "approved" }),
  );
  await expect(f.engine.decideOutbox(items[0]!.id, true)).rejects.toThrow();
  await expect(f.engine.decideOutbox(items[1]!.id, true)).rejects.toThrow();
  expect(f.outbox.execute).toHaveBeenCalledTimes(1);
});

it("validates each send kind and preserves its target and body in the outbox", async () => {
  const work = await f.createWork();
  const writes = [
    {
      kind: "comment",
      target: { thread: work.threadIds[0]! },
      body: { text: "Reply" },
    },
    {
      kind: "label",
      target: { thread: work.threadIds[0]! },
      body: { labels: ["bug", "help wanted"] },
    },
    { kind: "push", target: {}, body: { branch: "fix" } },
    {
      kind: "pull_request",
      target: {},
      body: { title: "Fix", body: "Details", head: "fix", base: "main" },
    },
  ] as const;
  const invalid = [
    { ...writes[0], kind: "unknown" },
    ...writes.flatMap((input, index) => [
      { ...input, target: index < 2 ? {} : writes[0].target },
      { ...input, body: {} },
      { ...input, body: writes[(index + 1) % writes.length]!.body },
    ]),
    { ...writes[1], body: { labels: [1] } },
    { ...writes[3], body: { title: "Fix", body: "Details", head: "fix" } },
  ];
  const id = sessionIdSchema.parse(work.workerSessionId);
  const session = await f.harness.getSession(id);
  const { registry } = f.engine.sessionTools(session)!;
  expect(
    registry.definitions.find(
      (tool) => tool.function.name === "superagent_send",
    ),
  ).toMatchObject({
    function: {
      parameters: {
        type: "object",
        properties: { kind: { enum: writes.map((input) => input.kind) } },
      },
    },
  });
  for (const input of invalid) {
    expect(
      await registry.execute(
        {
          id: "send",
          type: "function",
          function: {
            name: "superagent_send",
            arguments: JSON.stringify(input),
          },
        },
        {
          sessionId: id,
          toolCallId: "send",
          workspace: session.workspace,
          permission: "workspace",
          signal: new AbortController().signal,
          approve: async () => false,
          onEvent: () => {},
        },
      ),
    ).toMatchObject({ isError: true });
  }
  await registry.dispose();
  const result = await f.runNext(id, [
    ...writes.map((input) => call("superagent_send", input)),
  ]);
  expect(result.status).toBe("completed");
  const items = await f.store.listOutbox();
  expect(items).toHaveLength(writes.length);
  for (const input of writes) {
    const item = items.find((item) => item.kind === input.kind)!;
    expect(item).toMatchObject({ ...input, workId: work.id, state: "pending" });
    expect(await f.store.getOutboxItem(item.id)).toEqual(item);
  }
  const comment = items.find((item) => item.kind === "comment")!;
  expect(comment.target.thread).toBe(work.threadIds[0]);
  expect(comment.body.text).toBe("Reply");
  const label = items.find((item) => item.kind === "label")!;
  expect(label.body.labels).toEqual(writes[1].body.labels);
  expect(items.find((item) => item.kind === "push")!.body.branch).toBe("fix");
  expect(items.find((item) => item.kind === "pull_request")!.body.head).toBe(
    "fix",
  );
  for (const input of invalid) {
    await expect(
      f.store.createOutboxItem({ ...input, workId: work.id } as never),
    ).rejects.toThrow();
    await expect(
      f.store.updateOutboxItem(comment.id, {
        ...input,
        workId: work.id,
      } as never),
    ).rejects.toThrow();
  }
  expect(await f.store.getOutboxItem(comment.id)).toEqual(comment);
  expect(f.outbox.execute).not.toHaveBeenCalled();
});

it("records outbox execution failure without replaying it on start", async () => {
  const work = await f.createWork();
  await f.runNext(sessionIdSchema.parse(work.workerSessionId), [
    call("superagent_send", {
      kind: "comment",
      target: { thread: work.threadIds[0] },
      body: { text: "Reply" },
    }),
  ]);
  const item = (await f.store.listOutbox())[0]!;
  f.outbox.execute.mockRejectedValue(
    new ForgeError("tool", "Fixture write failed."),
  );
  expect(await f.engine.decideOutbox(item.id, true)).toMatchObject({
    state: "failed",
    error: "Fixture write failed.",
  });
  await f.restart();
  expect(f.outbox.execute).toHaveBeenCalledTimes(1);
});

it("denies Worker reads of foreign threads and triggers", async () => {
  const work = await f.createWork();
  const foreign = trigger("foreign", { summary: "Foreign private body" });
  await f.ingest(foreign);
  const result = await f.runNext(sessionIdSchema.parse(work.workerSessionId), [
    call("superagent_read", { ids: [foreign.threadId] }),
    call("superagent_read", { ids: [foreign.id] }),
    call("superagent_read", { ids: [work.threadIds[0], "gh:1"] }),
  ]);
  const tools = result.messages.filter((message) => message.role === "tool");
  expect(tools[0]?.content).toContain("not subscribed");
  expect(tools[1]?.content).toContain("not subscribed");
  expect(tools[2]?.content).toContain("Please investigate.");
  expect(JSON.stringify(result.messages)).not.toContain("Foreign private body");
});

it("allows history only between the stored Router and its Workers", async () => {
  const first = trigger("1");
  const second = trigger("2");
  await f.ingest(first, second);
  await f.runNext((await f.router()).id, [
    call("superagent_route", {
      decisions: [newDecision(first), newDecision(second)],
    }),
  ]);
  const router = await f.harness.getSession((await f.router()).id);
  const works = await f.store.workItems.list();
  const workers = await Promise.all(
    works.map((work) =>
      f.harness.getSession(sessionIdSchema.parse(work.workerSessionId)),
    ),
  );
  const ordinary = await f.harness.createSession({ workspace: f.workspace });
  const foreign = await f.harness.createSessionWithProfile({
    workspace: f.workspace,
    profileId: "router",
    agentRole: { kind: "router", ownerId: "foreign-workspace" },
  });
  const sessions = [router, ...workers, ordinary, foreign];
  for (const reader of sessions)
    for (const target of sessions) {
      const allowed =
        (reader.id === router.id && workers.includes(target)) ||
        (target.id === router.id && workers.includes(reader));
      expect(await f.engine.canReadSession(reader, target.id)).toBe(allowed);
    }
});

it("reuses the Router after restart and leaves idle running work for explicit resume", async () => {
  const work = await f.createWork();
  const id = sessionIdSchema.parse(work.workerSessionId);
  await f.runNext(id);
  const routerId = (await f.router()).id;
  const count = f.items.length;
  await f.restart();
  expect(f.items).toHaveLength(count);
  expect(await f.store.workItems.get(work.id)).toMatchObject({
    status: "running",
  });
  await f.engine.resumeWorkItem(work.id);
  expect(f.items).toHaveLength(count + 1);
  expect(f.items.at(-1)).toMatchObject({ sessionId: id, origin: "superagent" });
  await f.ingest(trigger("new"));
  expect((await f.router()).id).toBe(routerId);
  expect(
    (await f.harness.listSessions()).filter(
      (session) => session.agentRole?.kind === "router",
    ),
  ).toHaveLength(1);
});

it("cancels a running Worker and marks its work stopped", async () => {
  const work = await f.createWork();
  const gate = hold();
  const run = f.runNext(sessionIdSchema.parse(work.workerSessionId), [
    gate.step,
  ]);
  await gate.entered;
  await f.engine.stopWorkItem(work.id, "User stopped work.");
  expect((await run).status).toBe("cancelled");
  expect(await f.store.workItems.get(work.id)).toMatchObject({
    status: "stopped",
    progress: "User stopped work.",
  });
});

it("attaches, follows, unfollows, and hands triggers back to the Router", async () => {
  const work = await f.createWork();
  const extra = trigger("2");
  await f.ingest(extra);
  await f.runNext((await f.router()).id, [
    call("superagent_route", {
      decisions: [{ type: "attach", work: work.id, threads: [extra.threadId] }],
    }),
  ]);
  expect((await f.store.workItems.get(work.id))?.threadIds).toContain(
    extra.threadId,
  );
  const another = trigger("3");
  await f.store.upsertThread(thread(another));
  await f.runNext(sessionIdSchema.parse(work.workerSessionId), [
    call("superagent_follow", { thread: another.threadId }),
    call("superagent_unfollow", { thread: another.threadId }),
    call("superagent_handback", {
      triggers: [extra.id],
      reason: "Needs routing.",
    }),
  ]);
  expect((await f.store.workItems.get(work.id))?.threadIds).not.toContain(
    another.threadId,
  );
  expect(await f.store.getTrigger(extra.id)).toMatchObject({
    disposition: "routing",
  });
  expect(f.items.at(-1)?.input?.prompt).toContain("Needs routing.");
});

it("stays inactive until enabled", async () => {
  await f.harness.updateSettings({
    settings: { superAgent: { enabled: false } },
  });
  await f.ingest(trigger("1"));
  await f.engine.start();
  expect(await f.harness.listSessions()).toEqual([]);
  expect(f.items).toEqual([]);
});

it("does not treat filtered explicit triggers as authorization", async () => {
  const ignored = trigger("self", { actor: "forge-bot" });
  const event = trigger("1", { explicit: false });
  await f.ingest(ignored, event);
  await f.runNext((await f.router()).id, [
    call("superagent_route", {
      decisions: [
        {
          ...newDecision(event),
          threads: [event.threadId, ignored.threadId],
          triggers: [event.id, ignored.id],
        },
      ],
    }),
  ]);
  expect(await f.store.workItems.list()).toEqual([]);
  expect(await f.store.listSuggestions()).toHaveLength(1);
  expect(await f.store.getTrigger(ignored.id)).toMatchObject({
    disposition: "ignored",
    reason: "Actor is the configured GitHub login.",
  });
});

it("does not process deliveries or execute approved outbox items on restart", async () => {
  const work = await f.createWork();
  await f.store.recordDelivery({
    id: "delivery",
    event: "issues",
    receivedAt: "2026-11-01T00:00:00.000Z",
    payload: {},
  });
  const item = await f.store.createOutboxItem({
    workId: work.id,
    kind: "comment",
    target: { thread: work.threadIds[0]! },
    body: { text: "Reply" },
  });
  await f.store.decideOutbox(item.id, true);
  const count = f.items.length;
  await f.restart();
  expect(await f.store.unprocessedDeliveries()).toHaveLength(1);
  expect(f.items).toHaveLength(count);
  expect(f.outbox.execute).not.toHaveBeenCalled();
});

it("explicitly resumes a failed session through the real durable input queue", async () => {
  const work = await f.createWork();
  const id = sessionIdSchema.parse(work.workerSessionId);
  const failed = await f.runNext(id, [
    async () => {
      throw new ForgeError("tool", "Fixture local failure.");
    },
  ]);
  expect(failed.status).toBe("failed");
  const inputQueue = f.harness.inputQueue!;
  const engine = createSuperAgent({
    stateDirectory: join(f.directory, "state"),
    harness: f.harness,
    inputQueue,
    sessions: f.sessions,
    store: f.store,
    workItems: f.store.workItems,
    settings: { getPublic: () => f.harness.getSettings() },
    outbox: f.outbox,
    events: { emit: (event) => f.events.push(event) },
  });
  await engine.start();
  expect((await inputQueue.list(id)).items).toEqual([]);
  await engine.resumeWorkItem(work.id);
  expect((await inputQueue.list(id)).items).toEqual([
    expect.objectContaining({ state: "queued", origin: "superagent" }),
  ]);
  let complete!: (session: SessionSnapshot) => void;
  const completed = new Promise<SessionSnapshot>((resolve) => {
    complete = resolve;
  });
  await inputQueue.attach({
    isBusy: () => false,
    async start(
      input,
      _runId,
      providerBinding,
      acknowledgedPredecessor,
      inputOrigin,
    ) {
      const result = await f.harness.run(
        input,
        () => {},
        async () => false,
        new AbortController().signal,
        {
          drainSteering: () => [],
          providerBinding,
          ...(acknowledgedPredecessor ? { acknowledgedPredecessor } : {}),
          ...(inputOrigin ? { inputOrigin } : {}),
        },
      );
      complete(result);
      return result.status;
    },
  });
  expect((await completed).status).toBe("completed");
});

it("keeps a Router's new work in its workspace when settings change during the run", async () => {
  const event = trigger("1");
  await f.ingest(event);
  const router = await f.harness.getSession((await f.router()).id);
  await f.harness.updateSettings({
    settings: { superAgent: { workspace: f.directory } },
  });
  await f.runNext(router.id, [
    call("superagent_route", { decisions: [newDecision(event)] }),
  ]);
  const work = (await f.store.workItems.list())[0]!;
  const worker = await f.harness.getSession(
    sessionIdSchema.parse(work.workerSessionId),
  );
  expect(worker.agentWorktree?.repository).toBe(f.workspace);
  await f.ingest(trigger("2"));
  const other = (await f.harness.listSessions()).find(
    (session) => session.agentRole?.ownerId === f.directory,
  )!;
  expect(other.id).not.toBe(router.id);
  expect(await f.engine.canReadSession(router, worker.id)).toBe(true);
  expect(await f.engine.canReadSession(worker, router.id)).toBe(true);
  expect(await f.engine.canReadSession(worker, other.id)).toBe(false);
  expect(
    await f.engine.canReadSession(
      await f.harness.getSession(other.id),
      worker.id,
    ),
  ).toBe(false);
});
