import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanupOrphanSessions } from "../../scripts/cleanup-orphan-sessions";
import { atomicJson, readJson } from "../../src/store/io";
import { openSessionStore } from "../../src/store/sessions";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "forge-orphan-cleanup-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function fixture() {
  const store = await openSessionStore(home);
  const original = await store.create({ workspace: home, title: "Keep history", model: "test" });
  const call = { id: "pending-call", type: "function" as const, function: { name: "search_files", arguments: "{}" } };
  const snapshot = {
    ...original, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z",
    status: "running" as const, pendingTool: call,
    messages: [{ role: "user" as const, content: "Keep this request" },
      { role: "assistant" as const, content: null, tool_calls: [call] }],
    events: [{ sessionId: original.id, timestamp: "2026-01-01T00:01:00.000Z", type: "tool_started" as const, call }],
    // A maintenance operation must not migrate historical file-change fields.
    changes: [{ path: "sample.ts", kind: "modified", before: "old", after: "new", truncated: false }],
    plan: { explanation: "Keep unfinished work", steps: [{ step: "Inspect", status: "in_progress" }] },
  };
  const path = join(home, "sessions", `${original.id}.json`);
  await atomicJson(path, snapshot);
  return { store, snapshot, path };
}
const before = "2026-01-02T00:00:00.000Z";

it("previews explicit stale IDs without changing the snapshot or creating backups", async () => {
  const { snapshot, path } = await fixture();
  const original = await readFile(path, "utf8");
  expect(await cleanupOrphanSessions(home, [snapshot.id], { before })).toEqual([
    { id: snapshot.id, action: "would-interrupt", closedCalls: 1 },
  ]);
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readdir(home)).toEqual(["sessions"]);
});

it("backs up exact bytes, preserves old records and the lock inode, and closes pending calls once", async () => {
  const { store, snapshot, path } = await fixture();
  const original = await readFile(path, "utf8");
  const release = await store.acquire(snapshot.id);
  await release();
  const inode = (await stat(`${path}.lock`)).ino;
  const [result] = await cleanupOrphanSessions(home, [snapshot.id], { before, apply: true });
  expect(result).toMatchObject({ action: "interrupted", closedCalls: 1 });
  if (!result?.backup) throw new Error("Expected a backup path");
  expect(await readFile(result.backup, "utf8")).toBe(original);
  expect((await stat(result.backup)).mode & 0o777).toBe(0o600);
  expect((await stat(`${path}.lock`)).ino).toBe(inode);
  const next = await readJson(path) as typeof snapshot;
  expect(next.status).toBe("interrupted");
  expect(next).not.toHaveProperty("pendingTool");
  expect(next.changes).toEqual(snapshot.changes);
  expect(next.plan).toEqual(snapshot.plan);
  expect(next.messages.slice(0, snapshot.messages.length)).toEqual(snapshot.messages);
  expect(next.events.slice(0, snapshot.events.length)).toEqual(snapshot.events);
  expect(next.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "pending-call" });
  const lastMessage = next.messages.at(-1);
  if (!lastMessage?.content) throw new Error("Expected an interrupted tool result");
  expect(JSON.parse(lastMessage.content)).toMatchObject({ isError: true });
  expect(next.events.slice(-2)).toMatchObject([
    { type: "tool_finished", toolCallId: "pending-call", result: { isError: true } },
    { type: "state_changed", status: "interrupted" },
  ]);
  expect((await store.get(snapshot.id)).status).toBe("interrupted");
  const cleaned = await readFile(path, "utf8");
  expect(await cleanupOrphanSessions(home, [snapshot.id], { before, apply: true })).toEqual([
    { id: snapshot.id, action: "skipped", reason: "status is interrupted" },
  ]);
  expect(await readFile(path, "utf8")).toBe(cleaned);
});

it("does not touch an actively locked session", async () => {
  const { store, snapshot, path } = await fixture();
  const original = await readFile(path, "utf8");
  const release = await store.acquire(snapshot.id);
  try {
    expect(await cleanupOrphanSessions(home, [snapshot.id], { before, apply: true })).toEqual([
      { id: snapshot.id, action: "skipped", reason: "locked by a live owner" },
    ]);
    expect(await readFile(path, "utf8")).toBe(original);
  } finally { await release(); }
});

it("leaves recent, completed and non-target sessions unchanged", async () => {
  const { store, snapshot, path } = await fixture();
  const other = await store.create({ workspace: home, title: "Untargeted", model: "test" });
  const otherPath = join(home, "sessions", `${other.id}.json`);
  const otherBytes = await readFile(otherPath, "utf8");
  expect(await cleanupOrphanSessions(home, [snapshot.id], { before: snapshot.updatedAt, apply: true })).toMatchObject([
    { action: "skipped", reason: "updated since cutoff" },
  ]);
  await atomicJson(path, { ...snapshot, status: "completed" });
  expect(await cleanupOrphanSessions(home, [snapshot.id], { before, apply: true })).toMatchObject([
    { action: "skipped", reason: "status is completed" },
  ]);
  expect(await readFile(otherPath, "utf8")).toBe(otherBytes);
});

it("rejects invalid IDs, timestamps and an empty target list before maintenance", async () => {
  await expect(cleanupOrphanSessions(home, [], { before, apply: true })).rejects.toThrow();
  await expect(cleanupOrphanSessions(home, ["../not-a-session"], { before, apply: true })).rejects.toThrow();
  await expect(cleanupOrphanSessions(home, [], { before: "invalid", apply: true })).rejects.toThrow();
  expect(await readdir(home)).toEqual([]);
});
