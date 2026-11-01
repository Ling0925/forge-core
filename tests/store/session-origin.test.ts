import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createProfileSessionInputSchema,
  createSessionInputSchema,
  sessionSnapshotSchema,
  sessionSummarySchema,
} from "../../src/shared";
import { createSessionJournal } from "../../src/store/session-journal";
import { validateSnapshot } from "../../src/store/session-validation";
import { openSessionStore } from "../../src/store/sessions";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-session-origin-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const store = await openSessionStore(directory);
  const session = await store.create({
    workspace: directory,
    title: "Origin fixture",
    model: "fixture",
  });
  return { store, session };
}

it("validates optional readonly ownership without accepting it from client creation", async () => {
  const { store, session } = await fixture();
  expect(session.originWorkspace).toBe(session.workspace);
  const summary = (await store.list())[0]!;
  expect(summary.originWorkspace).toBe(session.workspace);
  for (const originWorkspace of [undefined, directory]) {
    expect(
      sessionSnapshotSchema.safeParse({ ...session, originWorkspace }).success,
    ).toBe(true);
    expect(
      sessionSummarySchema.safeParse({ ...summary, originWorkspace }).success,
    ).toBe(true);
  }
  expect(
    sessionSnapshotSchema.safeParse({ ...session, originWorkspace: "" })
      .success,
  ).toBe(false);
  expect(
    sessionSummarySchema.safeParse({ ...summary, originWorkspace: "" }).success,
  ).toBe(false);
  expect(
    createSessionInputSchema.safeParse({
      workspace: directory,
      originWorkspace: directory,
    }).success,
  ).toBe(false);
  expect(
    createProfileSessionInputSchema.safeParse({
      workspace: directory,
      originWorkspace: directory,
      profileId: "worker",
    }).success,
  ).toBe(false);
  await expect(
    store.create({
      workspace: directory,
      originWorkspace: "relative",
      title: "Invalid",
      model: "fixture",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

it("rejects changed or dropped ownership in snapshot and incremental writes", async () => {
  const { store, session } = await fixture();
  const versioned = await store.incremental!.read(session.id);
  const { messages, events, changes, ...metadata } = versioned.snapshot;
  const { originWorkspace: _origin, ...withoutOrigin } = metadata;
  for (const next of [
    { ...metadata, originWorkspace: join(directory, "other") },
    { ...metadata, originWorkspace: undefined },
    withoutOrigin,
  ]) {
    await expect(
      store.save({ ...next, messages, events, changes }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.incremental!.commit(session.id, {
        baseRevision: versioned.revision,
        metadata: next,
        messages: { keep: messages.length, append: [] },
        events: { keep: events.length, append: [] },
        changes: { keep: changes.length, append: [] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  }
  expect(await store.get(session.id)).toEqual(session);
});

it.each([false, true])(
  "derives legacy ownership for snapshots and summary indexes (worktree: %s)",
  async (worktree) => {
    const { session } = await fixture();
    const { originWorkspace: _origin, ...withoutOrigin } = session;
    const legacy = sessionSnapshotSchema.parse({
      ...withoutOrigin,
      ...(worktree
        ? {
            workspace: join(directory, "worktree"),
            agentWorktree: {
              repository: directory,
              worktree: join(directory, "worktree"),
              baseRevision: "a".repeat(40),
            },
          }
        : {}),
    });
    const folder = join(directory, "sessions");
    const journal = createSessionJournal(
      folder,
      join(folder, "summaries"),
      validateSnapshot,
    );
    await journal.create(legacy);
    const path = join(folder, `${session.id}.json`);
    const before = await readFile(path, "utf8");
    const indexPath = join(folder, "summaries", `${session.id}.json`);
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.summary.originWorkspace = undefined;
    await writeFile(indexPath, JSON.stringify(index));
    const reader = await openSessionStore(directory);
    const summaries = await reader.list();
    expect(summaries[0]?.originWorkspace).toBe(directory);
    expect(await reader.list()).toEqual(summaries);
    const snapshot = await reader.get(session.id);
    expect(snapshot).toEqual({ ...legacy, originWorkspace: directory });
    expect((await reader.incremental!.read(session.id)).snapshot).toEqual(
      snapshot,
    );
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(reader.save(legacy)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await reader.save({ ...snapshot, title: "Updated legacy" });
    expect(
      await (await openSessionStore(directory)).get(session.id),
    ).toMatchObject({ title: "Updated legacy", originWorkspace: directory });
  },
);

it.each([1, 2])(
  "reads version %s legacy journal records without changing their hashes",
  async (version) => {
    const { session } = await fixture();
    const { originWorkspace: _origin, ...legacy } = session;
    const folder = join(directory, "sessions");
    const journal = createSessionJournal(
      folder,
      join(folder, "summaries"),
      validateSnapshot,
    );
    await journal.create(legacy);
    const path = join(folder, `${session.id}.json`);
    const base = JSON.parse(await readFile(path, "utf8"));
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const before = digest(legacy);
    const baseHash = digest([before, base._journalGeneration]);
    const next = sessionSnapshotSchema.parse({
      ...legacy,
      title: "Legacy delta",
    });
    const {
      messages: _messages,
      events: _events,
      changes: _changes,
      ...metadata
    } = next;
    const payload = {
      version,
      before,
      metadata,
      messages: { keep: 0, append: [] },
      events: { keep: 0, append: [] },
      changes: { keep: 0, append: [] },
    };
    const record = {
      ...payload,
      after: digest(version === 1 ? next : payload),
    };
    const journalDirectory = join(folder, `${session.id}.${baseHash}.journal`);
    await mkdir(journalDirectory, { mode: 0o700 });
    await writeFile(
      join(journalDirectory, "00000001.json"),
      JSON.stringify(record),
      { mode: 0o600 },
    );
    const reader = await openSessionStore(directory);
    expect(await reader.get(session.id)).toEqual({
      ...next,
      originWorkspace: directory,
    });
    expect(
      await reader.incremental!.changesSince(
        session.id,
        digest([baseHash, before]),
      ),
    ).toMatchObject({
      changes: [
        { metadata: { title: next.title, originWorkspace: directory } },
      ],
    });
    expect(
      await reader.incremental!.changesSince(session.id, "unknown"),
    ).toMatchObject({ snapshot: { originWorkspace: directory } });
    const current = await reader.get(session.id);
    await reader.save({ ...current, title: "After legacy delta" });
    expect(
      await (await openSessionStore(directory)).get(session.id),
    ).toMatchObject({
      title: "After legacy delta",
      originWorkspace: directory,
    });
  },
);
