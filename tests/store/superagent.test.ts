import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  type Trigger,
  type WorkItemStore,
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
};
const outgoing = {
  workId: "wrk_example",
  kind: "comment",
  target: { threadId: thread.id },
  body: { text: "Done" },
};

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

it("claims once, updates progress, and queries work by status and subscriptions", async () => {
  const items: WorkItemStore = store.workItems;
  const first = await items.create(work);
  const second = await items.create({ ...work, threadIds: [] });
  expect(first.id).toMatch(/^wrk_/);
  expect(first).toMatchObject({
    status: "queued",
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
  await store.updateOutboxItem(item.id, { ...outgoing, body: "Updated" });
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
