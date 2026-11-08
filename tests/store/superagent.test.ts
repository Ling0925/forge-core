import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type Trigger,
  type WorkItemStore,
  createWorkItemSchema,
  sessionIdSchema,
  workItemStatusSchema,
} from "../../src/shared";
import { type SuperAgentStore, openSuperAgentStore } from "../../src/store";

let directory: string;
let store: SuperAgentStore;
const opened: SuperAgentStore[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-superagent-"));
  store = await openSuperAgentStore(directory);
  opened.push(store);
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((item) => item.close()));
  await rm(directory, { recursive: true, force: true });
});
const receivedAt = "2026-11-01T00:00:00.000Z";
const delivery = {
  id: "delivery-id",
  event: "issues",
  receivedAt,
  payload: { issue: { number: 123 } },
};
const thread = {
  id: "gh:owner/repo#123",
  title: "Issue",
  url: "https://github.com/owner/repo/issues/123",
  state: "open",
  lastTriggerAt: receivedAt,
};
const trigger: Trigger = {
  id: "gh:delivery-id",
  source: "github",
  kind: "assigned",
  actor: "author",
  explicit: true,
  threadId: thread.id,
  summary: "Assigned",
  payload: delivery.payload,
  receivedAt,
  disposition: null,
  reason: null,
};
const work = {
  title: "Fix issue",
  brief: "Investigate",
  threadIds: [thread.id],
  profileId: "worker",
  routerSessionId: "router-session",
};
const outgoing = {
  workId: "wrk_example",
  kind: "comment" as const,
  target: { thread: thread.id },
  body: { text: "Done" },
};

const boardIdentity = {
  cursorKey: `superagent:board:${JSON.stringify(["http://board.invalid", "project"])}`,
  eventId: "8",
  workId: "task",
};
const notificationRequest = () => ({
  inputId: randomUUID(),
  input: {
    sessionId: sessionIdSchema.parse(randomUUID()),
    prompt: "Original notification",
  },
});

it("adds Board notification state to version 2 without changing existing records or the version", async () => {
  await store.recordDelivery(delivery);
  await store.putTrigger(trigger);
  const item = await store.workItems.create(work);
  await store.setCursor(boardIdentity.cursorKey, "7");
  await store.close();
  const legacy = new DatabaseSync(join(directory, "superagent.sqlite"));
  try {
    legacy.exec("DROP TABLE board_notifications");
  } finally {
    legacy.close();
  }
  store = await openSuperAgentStore(directory);
  opened.push(store);
  const request = notificationRequest();
  await store.boardNotifications.prepare(boardIdentity, request);
  await store.close();
  store = await openSuperAgentStore(directory);
  opened.push(store);
  expect(await store.boardNotifications.get(boardIdentity)).toEqual({
    request,
    handled: false,
  });
  expect(await store.unprocessedDeliveries()).toEqual([
    { ...delivery, processedAt: null },
  ]);
  expect(await store.getTrigger(trigger.id)).toEqual(trigger);
  expect(await store.workItems.get(item.id)).toEqual(item);
  expect(await store.getCursor(boardIdentity.cursorKey)).toBe("7");
  const database = new DatabaseSync(join(directory, "superagent.sqlite"));
  try {
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(
      database
        .prepare("SELECT value FROM cursors WHERE key = ?")
        .get(boardIdentity.cursorKey)?.value,
    ).toBe("7");
  } finally {
    database.close();
  }
});

it("keeps the first Board notification request across handles and scopes identity to source, project, event and task", async () => {
  const other = await openSuperAgentStore(directory);
  opened.push(other);
  const first = notificationRequest();
  const replacement = notificationRequest();
  await store.boardNotifications.prepare(boardIdentity, first);
  expect(
    await Promise.all([
      store.boardNotifications.prepare(boardIdentity, replacement),
      other.boardNotifications.prepare(boardIdentity, replacement),
    ]),
  ).toEqual([
    { request: first, handled: false },
    { request: first, handled: false },
  ]);
  const identities = [
    {
      ...boardIdentity,
      cursorKey: `superagent:board:${JSON.stringify(["http://other-board.invalid", "project"])}`,
    },
    {
      ...boardIdentity,
      cursorKey: `superagent:board:${JSON.stringify(["http://board.invalid", "other-project"])}`,
    },
    { ...boardIdentity, eventId: "9" },
    { ...boardIdentity, workId: "other-task" },
  ];
  for (const identity of identities) {
    const request = notificationRequest();
    expect(await other.boardNotifications.prepare(identity, request)).toEqual({
      request,
      handled: false,
    });
  }
  expect(await other.boardNotifications.get(boardIdentity)).toEqual({
    request: first,
    handled: false,
  });
});

it("retires only the handled notification with its cursor and rolls back both on retirement failure", async () => {
  await store.setCursor(boardIdentity.cursorKey, "7");
  const request = notificationRequest();
  await store.boardNotifications.prepare(boardIdentity, request);
  const unhandled = { ...boardIdentity, workId: "unhandled-task" };
  const otherEvent = { ...boardIdentity, eventId: "9" };
  const otherSource = { ...boardIdentity, cursorKey: "another-source" };
  for (const identity of [unhandled, otherEvent, otherSource])
    await store.boardNotifications.prepare(identity, notificationRequest());
  for (const identity of [boardIdentity, otherEvent, otherSource])
    await store.boardNotifications.complete(identity);
  const database = new DatabaseSync(join(directory, "superagent.sqlite"));
  try {
    database.exec(
      "CREATE TRIGGER fail_retirement BEFORE DELETE ON board_notifications BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END",
    );
    await expect(
      store.setCursor(boardIdentity.cursorKey, "8"),
    ).rejects.toMatchObject({ code: "storage" });
    expect(await store.getCursor(boardIdentity.cursorKey)).toBe("7");
    expect(await store.boardNotifications.get(boardIdentity)).toEqual({
      request,
      handled: true,
    });
    database.exec("DROP TRIGGER fail_retirement");
    await store.setCursor(boardIdentity.cursorKey, "8");
    expect(await store.getCursor(boardIdentity.cursorKey)).toBe("8");
    expect(await store.boardNotifications.get(boardIdentity)).toBeUndefined();
    expect(await store.boardNotifications.get(unhandled)).toMatchObject({
      handled: false,
    });
    for (const identity of [otherEvent, otherSource])
      expect(await store.boardNotifications.get(identity)).toMatchObject({
        handled: true,
      });
  } finally {
    database.close();
  }
});

it("opens lazily and atomically deduplicates deliveries across store handles", async () => {
  expect(await readdir(directory)).toEqual([]);
  const other = await openSuperAgentStore(directory);
  opened.push(other);
  const results = await Promise.all([
    store.recordDelivery(delivery),
    other.recordDelivery(delivery),
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect(
    await store.recordDelivery({ ...delivery, payload: { replaced: true } }),
  ).toBe(false);
  expect(await store.unprocessedDeliveries()).toEqual([
    { ...delivery, processedAt: null },
  ]);
  expect((await stat(join(directory, "superagent.sqlite"))).mode & 0o077).toBe(
    0,
  );
  await store.markDeliveryProcessed(delivery.id);
  expect(await other.unprocessedDeliveries()).toEqual([]);
  await store.close();
  await expect(store.getTrigger(trigger.id)).rejects.toMatchObject({
    code: "storage",
  });
});

it("filters triggers by disposition and threads without changing order or results", async () => {
  const records = [
    { ...trigger, id: "b", disposition: "backlog" },
    { ...trigger, id: "a", disposition: "routing" },
    {
      ...trigger,
      id: "older",
      disposition: "backlog",
      threadId: "other",
      receivedAt: "2026-10-31T00:00:00.000Z",
    },
    { ...trigger, id: "ignored", disposition: "ignored" },
    { ...trigger, id: "unset", threadId: "other" },
  ];
  for (const record of records) await store.putTrigger(record);
  const all = await store.listTriggers();
  expect(all.map((item) => item.id)).toEqual([
    "older",
    "a",
    "b",
    "ignored",
    "unset",
  ]);
  for (const disposition of [
    undefined,
    "backlog",
    ["backlog", "routing"],
    [],
    "' OR 1=1 --",
  ])
    for (const threadIds of [
      undefined,
      [thread.id],
      [thread.id, "other"],
      [],
      ["missing"],
    ]) {
      const query = {
        ...(disposition === undefined ? {} : { disposition }),
        ...(threadIds === undefined ? {} : { threadIds }),
      };
      expect(await store.listTriggers(query)).toEqual(
        all.filter(
          (item) =>
            (disposition === undefined ||
              (typeof disposition === "string"
                ? [disposition]
                : disposition
              ).includes(item.disposition ?? "")) &&
            (threadIds === undefined || threadIds.includes(item.threadId)),
        ),
      );
    }
  await store.putTrigger({
    ...records[0]!,
    disposition: "ignored",
    threadId: "moved",
  });
  expect(await store.listTriggers({ disposition: "backlog" })).toEqual([
    records[2],
  ]);
  expect(await store.listTriggers({ threadIds: ["moved"] })).toMatchObject([
    { id: "b", disposition: "ignored" },
  ]);
});

it("adds usable trigger indexes when reopening an existing store", async () => {
  await store.putTrigger(trigger);
  await store.close();
  const existing = new DatabaseSync(join(directory, "superagent.sqlite"));
  try {
    existing.exec(
      "DROP INDEX triggers_disposition; DROP INDEX triggers_thread;",
    );
  } finally {
    existing.close();
  }
  store = await openSuperAgentStore(directory);
  opened.push(store);
  expect(await store.listTriggers()).toEqual([trigger]);
  const database = new DatabaseSync(join(directory, "superagent.sqlite"));
  try {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    for (const query of [
      { disposition: "backlog" },
      { disposition: ["backlog", "routing"] },
      { threadIds: [thread.id] },
      { disposition: ["backlog", "routing"], threadIds: [thread.id] },
    ]) {
      await store.listTriggers(query);
      const sql = prepare.mock.calls.at(-1)![0];
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
      expect(plan, sql).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detail: expect.stringMatching(
              /SEARCH triggers USING INDEX triggers_(disposition|thread)/,
            ),
          }),
        ]),
      );
    }
  } finally {
    database.close();
  }
});

it("claims once, updates progress, and queries work by status and subscriptions", async () => {
  const items: WorkItemStore = store.workItems;
  const first = await items.create(work);
  const second = await items.create({ ...work, threadIds: [] });
  expect(first.id).toMatch(/^wrk_/);
  expect(first).toMatchObject({
    status: "queued",
    routerSessionId: work.routerSessionId,
    pendingStatus: null,
    claimedBy: null,
    workerSessionId: null,
  });
  const other = await openSuperAgentStore(directory);
  opened.push(other);
  const claims = await Promise.all([
    items.claim(first.id, "one"),
    other.workItems.claim(first.id, "two"),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await items.claim(first.id, "three")).toBeUndefined();
  expect(await items.list({ status: "running", threadId: thread.id })).toEqual([
    claims.find(Boolean),
  ]);
  await items.linkThread(second.id, thread.id);
  await items.linkThread(second.id, thread.id);
  expect((await items.get(second.id))?.threadIds).toEqual([thread.id]);
  expect(
    await items.list({ status: ["running", "queued"], threadId: thread.id }),
  ).toHaveLength(2);
  await items.unlinkThread(second.id, thread.id);
  expect(await items.list({ status: "queued", threadId: thread.id })).toEqual(
    [],
  );
  expect(await items.list({ status: [] })).toEqual([]);
  await items.linkWorker(first.id, "session-id", "/workspace/isolated");
  for (const status of workItemStatusSchema.options) {
    await items.update(first.id, { status });
    expect((await items.get(first.id))?.status).toBe(status);
  }
  await items.update(first.id, { progress: "Verified" });
  expect(await items.get(first.id)).toMatchObject({
    status: "done",
    progress: "Verified",
    workerSessionId: "session-id",
    worktree: "/workspace/isolated",
  });
  await expect(items.linkThread("missing", thread.id)).rejects.toMatchObject({
    code: "not_found",
  });
});

it("requires a Router on create and migrates version 1 Router cursors into work items", async () => {
  const { routerSessionId, ...legacyInput } = work;
  expect(createWorkItemSchema.safeParse(legacyInput).success).toBe(false);
  const first = await store.workItems.create(work);
  const second = await store.workItems.create({
    ...work,
    routerSessionId: "other-router",
  });
  const running = await store.workItems.claim(second.id, "other-router");
  await store.setCursor(`superagent:work-router:${first.id}`, routerSessionId);
  await store.setCursor(`superagent:work-router:${second.id}`, "other-router");
  await store.setCursor("superagent:work-router:orphan", "former-router");
  await store.setCursor("superagent:router:workspace", routerSessionId);
  await store.setCursor("github:owner/repo:since", receivedAt);
  await store.close();
  const legacy = new DatabaseSync(join(directory, "superagent.sqlite"));
  try {
    legacy.exec(
      "ALTER TABLE work_items DROP COLUMN router_session_id; PRAGMA user_version = 1;",
    );
  } finally {
    legacy.close();
  }
  store = await openSuperAgentStore(directory);
  opened.push(store);
  expect(await store.workItems.get(first.id)).toEqual(first);
  expect(await store.workItems.get(second.id)).toEqual(running);
  expect(await store.workItems.list()).toEqual(
    expect.arrayContaining([first, running]),
  );
  expect(await store.getCursor("superagent:router:workspace")).toBe(
    routerSessionId,
  );
  expect(await store.getCursor("github:owner/repo:since")).toBe(receivedAt);
  const migrated = new DatabaseSync(join(directory, "superagent.sqlite"));
  try {
    expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(
      migrated
        .prepare(
          "SELECT * FROM cursors WHERE key GLOB 'superagent:work-router:*'",
        )
        .all(),
    ).toEqual([]);
    expect(
      migrated
        .prepare("PRAGMA table_info(work_items)")
        .all()
        .map((column) => column.name),
    ).not.toContain("pending_status");
  } finally {
    migrated.close();
  }
  expect(
    await store.workItems.linkWorker(first.id, "worker-session"),
  ).toMatchObject({
    routerSessionId,
    pendingStatus: null,
  });
  await store.close();
  store = await openSuperAgentStore(directory);
  opened.push(store);
  expect(await store.workItems.get(second.id)).toEqual(running);
  expect(await store.workItems.create(work)).toMatchObject({
    routerSessionId,
    pendingStatus: null,
  });
});

it("keeps outbox writes pending until approved and enforces decision and completion transitions", async () => {
  const item = await store.createOutboxItem(outgoing);
  expect(item).toMatchObject({
    state: "pending",
    decidedAt: null,
    sentAt: null,
  });
  expect(item.id).toMatch(/^out_/);
  await expect(store.markOutboxSent(item.id)).rejects.toMatchObject({
    code: "invalid_input",
  });
  await expect(store.markOutboxFailed(item.id, "error")).rejects.toMatchObject({
    code: "invalid_input",
  });
  await store.updateOutboxItem(item.id, {
    ...outgoing,
    body: { text: "Updated" },
  });
  const decisions = await Promise.allSettled([
    store.decideOutbox(item.id, true),
    store.decideOutbox(item.id, false),
  ]);
  expect(decisions.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  await expect(store.updateOutboxItem(item.id, outgoing)).rejects.toMatchObject(
    { code: "invalid_input" },
  );
  const sent = await store.markOutboxSent(item.id);
  expect(sent.state).toBe("sent");
  expect(sent.decidedAt).not.toBeNull();
  expect(sent.sentAt).not.toBeNull();
  await expect(store.markOutboxSent(item.id)).rejects.toMatchObject({
    code: "invalid_input",
  });
  const failed = await store.createOutboxItem(outgoing);
  await store.decideOutbox(failed.id, true);
  expect(await store.markOutboxFailed(failed.id, "Send failed")).toMatchObject({
    state: "failed",
    error: "Send failed",
    sentAt: null,
  });
  const rejected = await store.createOutboxItem(outgoing);
  await store.decideOutbox(rejected.id, false);
  await expect(store.markOutboxSent(rejected.id)).rejects.toMatchObject({
    code: "invalid_input",
  });
  expect(await store.listOutbox("sent")).toEqual([sent]);
  expect(await store.deleteOutboxItem(rejected.id)).toBe(true);
  expect(await store.getOutboxItem(rejected.id)).toBeUndefined();
});

it("persists deliveries, triggers, threads, work, cursors, suggestions and outbox across reopen", async () => {
  await store.recordDelivery(delivery);
  await store.recordDelivery({ ...delivery, id: "processed" });
  await store.markDeliveryProcessed("processed");
  await store.putTrigger(trigger);
  const routed = {
    ...trigger,
    disposition: "routed",
    reason: "Explicit assignment",
  };
  await store.putTrigger(routed);
  await store.upsertThread(thread);
  const updatedThread = { ...thread, title: "Updated issue" };
  await store.upsertThread(updatedThread);
  await store.setCursor("github:owner/repo", "before");
  await store.setCursor("github:owner/repo", receivedAt);
  const item = await store.workItems.create(work);
  await store.workItems.claim(item.id, "host");
  const linked = await store.workItems.linkWorker(item.id, "worker-session");
  const input = {
    threadIds: [thread.id],
    brief: "Proposed work",
    triggerIds: [trigger.id],
  };
  const suggestion = await store.createSuggestion(input);
  expect(suggestion.id).toMatch(/^sug_/);
  await store.updateSuggestion(suggestion.id, {
    ...input,
    brief: "Revised work",
  });
  const accepted = await store.decideSuggestion(suggestion.id, item.id);
  await expect(
    store.decideSuggestion(suggestion.id, null),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const rejected = await store.createSuggestion(input);
  await store.decideSuggestion(rejected.id, null);
  expect(await store.listSuggestions("rejected")).toMatchObject([
    { id: rejected.id },
  ]);
  expect(await store.deleteSuggestion(rejected.id)).toBe(true);
  expect(await store.getSuggestion(rejected.id)).toBeUndefined();
  const queued = await store.createOutboxItem({ ...outgoing, workId: item.id });
  const approved = await store.decideOutbox(queued.id, true);
  await store.close();
  store = await openSuperAgentStore(directory);
  opened.push(store);
  expect(await store.recordDelivery(delivery)).toBe(false);
  expect(await store.unprocessedDeliveries()).toEqual([
    { ...delivery, processedAt: null },
  ]);
  expect(await store.getTrigger(trigger.id)).toEqual(routed);
  expect(await store.listTriggers()).toEqual([routed]);
  expect(await store.getThread(thread.id)).toEqual(updatedThread);
  expect(await store.getCursor("github:owner/repo")).toBe(receivedAt);
  expect(await store.workItems.get(item.id)).toEqual(linked);
  expect(await store.workItems.list({ threadId: thread.id })).toEqual([linked]);
  expect(await store.getSuggestion(suggestion.id)).toEqual(accepted);
  expect(await store.listSuggestions()).toEqual([accepted]);
  expect(await store.getOutboxItem(queued.id)).toEqual(approved);
});
