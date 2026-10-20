import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionWriter } from "../../src/core/session-writer";
import type { SessionSnapshot } from "../../src/shared/schemas";
import type {
  SessionMutation,
  VersionedSession,
} from "../../src/shared/session-store";
import * as io from "../../src/store/io";
import { openSessionStore } from "../../src/store/sessions";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-incremental-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const fixture = async () => {
  const store = await openSessionStore(directory);
  const initial = await store.create({
    workspace: directory,
    title: "original",
    model: "fixture",
  });
  if (!store.incremental) throw new Error("Missing incremental persistence");
  return { store, initial, port: store.incremental };
};
function mutation(previous: VersionedSession, title: string): SessionMutation {
  const { messages, events, changes, ...metadata } = previous.snapshot;
  return {
    baseRevision: previous.revision,
    metadata: { ...metadata, title },
    messages: { keep: messages.length, append: [] },
    events: { keep: events.length, append: [] },
    changes: { keep: changes.length, append: [] },
  };
}

it("does not reload or serialize history on warm metadata updates and reads only newly committed records", async () => {
  const { store, initial, port } = await fixture();
  await store.save({
    ...initial,
    status: "completed",
    messages: Array.from({ length: 1000 }, () => ({
      role: "user",
      content: "historical body".repeat(100),
    })),
  });
  let current = await port.read(initial.id);
  current = await port.commit(initial.id, {
    ...mutation(current, "running"),
    metadata: { ...mutation(current, "running").metadata, status: "running" },
  });
  const observer = await openSessionStore(directory);
  await observer.get(initial.id);
  const read = vi.spyOn(io, "readJson");
  const stringify = vi.spyOn(JSON, "stringify");
  const next = await port.commit(initial.id, mutation(current, "renamed"));
  expect(next.snapshot.messages).toBe(current.snapshot.messages);
  expect(read).not.toHaveBeenCalled();
  expect(
    stringify.mock.calls.some(
      ([value]) =>
        value === current.snapshot.messages ||
        (value &&
          typeof value === "object" &&
          "messages" in value &&
          Array.isArray(value.messages) &&
          value.messages.length > 0),
    ),
  ).toBe(false);
  expect((await observer.get(initial.id)).title).toBe("renamed");
  expect(read.mock.calls.map(([path]) => path)).toHaveLength(1);
  expect(read.mock.calls[0]?.[0]).toMatch(/\.journal\/00000002\.json$/);
  read.mockClear();
  expect(await observer.get(initial.id)).toEqual(next.snapshot);
  expect(read).not.toHaveBeenCalled();
});

it("returns chained bounded deltas, stable no-op revisions, and checkpoint fallback", async () => {
  const { initial, port } = await fixture();
  const first = await port.read(initial.id);
  const second = await port.commit(initial.id, {
    ...mutation(first, "second"),
    messages: { keep: 0, append: [{ role: "user", content: "new" }] },
  });
  const third = await port.commit(initial.id, mutation(second, "third"));
  const noOp = await port.commit(initial.id, mutation(third, "third"));
  expect(noOp.revision).toBe(third.revision);
  const changes = await port.changesSince(initial.id, first.revision);
  if (!("changes" in changes)) throw new Error("Expected incremental changes");
  expect(changes.changes).toHaveLength(2);
  let rebuilt = first.snapshot;
  let revision = first.revision;
  for (const change of changes.changes) {
    expect(change.before).toBe(revision);
    rebuilt = {
      ...change.metadata,
      messages: [
        ...rebuilt.messages.slice(0, change.messages.keep),
        ...change.messages.append,
      ],
      events: [
        ...rebuilt.events.slice(0, change.events.keep),
        ...change.events.append,
      ],
      changes: [
        ...rebuilt.changes.slice(0, change.changes.keep),
        ...change.changes.append,
      ],
    };
    revision = change.after;
  }
  expect(rebuilt).toEqual(third.snapshot);
  expect(revision).toBe(third.revision);
  const reopened = await openSessionStore(directory);
  expect(await reopened.incremental?.read(initial.id)).toEqual(third);
  expect(
    await reopened.incremental?.changesSince(initial.id, second.revision),
  ).toEqual({ revision: third.revision, changes: changes.changes.slice(1) });
  const terminal = await port.commit(initial.id, {
    ...mutation(third, "done"),
    metadata: { ...mutation(third, "done").metadata, status: "completed" },
  });
  expect(await port.changesSince(initial.id, third.revision)).toEqual({
    revision: terminal.revision,
    snapshot: terminal.snapshot,
  });
  expect(await port.changesSince(initial.id, terminal.revision)).toEqual({
    revision: terminal.revision,
    changes: [],
  });
});

it("rejects stale versions, invalid prefixes and cross-session event relationships", async () => {
  const { initial, port } = await fixture();
  const first = await port.read(initial.id);
  const current = await port.commit(initial.id, mutation(first, "changed"));
  await expect(
    port.commit(initial.id, mutation(first, "stale")),
  ).rejects.toMatchObject({ code: "busy" });
  await expect(
    port.commit(initial.id, {
      ...mutation(current, "bad"),
      messages: { keep: 1, append: [] },
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const { initial: other } = await fixture();
  await expect(
    port.commit(initial.id, {
      ...mutation(current, "bad"),
      events: {
        keep: 0,
        append: [
          {
            type: "state_changed",
            status: "running",
            sessionId: other.id,
            timestamp: initial.createdAt,
          },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(await port.read(initial.id)).toEqual(current);
});

it("validates native tool pairs across incremental commits and explicit history rewrites", async () => {
  const { initial, port } = await fixture();
  const first = await port.read(initial.id);
  const pending = await port.commit(initial.id, {
    ...mutation(first, "tool"),
    messages: {
      keep: 0,
      append: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
      ],
    },
  });
  await expect(
    port.commit(initial.id, {
      ...mutation(pending, "bad"),
      messages: { keep: 1, append: [{ role: "user", content: "unpaired" }] },
    }),
  ).rejects.toMatchObject({ code: "storage" });
  const paired = await port.commit(initial.id, {
    ...mutation(pending, "paired"),
    messages: {
      keep: 1,
      append: [{ role: "tool", tool_call_id: "call", content: "result" }],
    },
  });
  await expect(
    port.commit(initial.id, {
      ...mutation(paired, "bad rewrite"),
      messages: {
        keep: 0,
        append: [{ role: "tool", tool_call_id: "call", content: "orphan" }],
      },
    }),
  ).rejects.toMatchObject({ code: "storage" });
  const shorter = await port.commit(initial.id, {
    ...mutation(paired, "shorter"),
    messages: { keep: 0, append: [] },
  });
  expect(await (await openSessionStore(directory)).get(initial.id)).toEqual(
    shorter.snapshot,
  );
});

it("detects in-place corruption even when the journal directory stamp is unchanged", async () => {
  const { initial, port } = await fixture();
  const first = await port.read(initial.id);
  await port.commit(initial.id, mutation(first, "changed"));
  const folder = join(directory, "sessions");
  const name = (await readdir(folder)).find((name) =>
    name.endsWith(".journal"),
  );
  if (!name) throw new Error("Missing journal");
  const path = join(folder, name, "00000001.json");
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace("changed", "damaged"));
  await expect(port.read(initial.id)).rejects.toMatchObject({
    code: "storage",
  });
  await expect(
    (await openSessionStore(directory)).get(initial.id),
  ).rejects.toMatchObject({ code: "storage" });
});

it("reads legacy v1 delta records and appends v2 records without losing their integrity chain", async () => {
  const { initial, port } = await fixture();
  const first = await port.read(initial.id);
  await port.commit(initial.id, mutation(first, "second"));
  const folder = join(directory, "sessions");
  const name = (await readdir(folder)).find((name) =>
    name.endsWith(".journal"),
  );
  if (!name) throw new Error("Missing journal");
  const path = join(folder, name, "00000001.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  const snapshot: SessionSnapshot = { ...initial, title: "second" };
  record.version = 1;
  record.after = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  await writeFile(path, `${JSON.stringify(record)}\n`);
  const store = await openSessionStore(directory);
  expect(await store.get(initial.id)).toEqual(snapshot);
  const writer = createSessionWriter(store, initial.id);
  const current = await writer.read();
  await writer.save({ ...current, title: "third" });
  expect(
    (await (await openSessionStore(directory)).get(initial.id)).title,
  ).toBe("third");
});

it("keeps terminal metadata-only revisions incremental and preserves checkpoint metadata across restart", async () => {
  const { store, initial, port } = await fixture();
  await store.save({
    ...initial,
    titleSource: "user",
    archived: true,
    status: "completed",
    messages: [{ role: "user", content: "body" }],
  });
  const checkpoint = await readFile(
    join(directory, "sessions", `${initial.id}.json`),
    "utf8",
  );
  const before = await port.read(initial.id);
  const next = await port.commit(
    initial.id,
    mutation(before, "renamed after completion"),
  );
  expect(
    await readFile(join(directory, "sessions", `${initial.id}.json`), "utf8"),
  ).toBe(checkpoint);
  expect(
    await (await openSessionStore(directory)).incremental?.read(initial.id),
  ).toEqual(next);
  const fork = await store.create({
    workspace: directory,
    title: "fork",
    model: "fixture",
  });
  await store.save({
    ...fork,
    messages: next.snapshot.messages,
    forkedFrom: initial.id,
  });
  const forkVersion = await port.read(fork.id);
  expect(forkVersion.revision).not.toBe(next.revision);
  expect(await port.changesSince(fork.id, next.revision)).toEqual({
    revision: forkVersion.revision,
    snapshot: forkVersion.snapshot,
  });
});
