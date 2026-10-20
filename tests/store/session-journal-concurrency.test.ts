import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../src/shared/schemas";
import * as io from "../../src/store/io";
import { openSessionStore } from "../../src/store/sessions";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-journal-race-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const writer = await openSessionStore(directory);
  const initial = await writer.create({ workspace: directory, title: "fixture", model: "fixture" });
  const committed: SessionSnapshot = {
    ...initial,
    status: "running",
    messages: [{ role: "user", content: "accepted" }],
  };
  await writer.save(committed);
  return { writer, committed, reader: await openSessionStore(directory) };
}

it.each(["append", "checkpoint", "temporary"] as const)(
  "reads a validated committed prefix while %s changes the journal on every replay",
  async (change) => {
    const { writer, reader, committed } = await fixture();
    let latest = committed;
    let changes = 0;
    const readJson = io.readJson;
    // Pause after the reader has enumerated its prefix, then perform a real
    // concurrent write. Repeating at every replay deterministically exhausted
    // the old three-attempt directory-stamp loop (without timing-based sleeps).
    const read = vi.spyOn(io, "readJson").mockImplementation(async (path, limit) => {
      const raw = await readJson(path, limit);
      if (path.endsWith("/00000001.json")) {
        changes++;
        if (change === "temporary") {
          await writeFile(join(dirname(path), `pending-${changes}.tmp`), "{", { mode: 0o600 });
        } else {
          latest = {
            ...latest,
            status: change === "checkpoint" ? "completed" : "running",
            title: `write ${changes}`,
            messages: [...latest.messages, { role: "assistant", content: `answer ${changes}` }],
          };
          await writer.save(latest);
        }
      }
      return raw;
    });
    expect(await reader.get(committed.id)).toEqual(committed);
    expect(changes).toBe(1);
    read.mockRestore();
    expect(await reader.get(committed.id)).toEqual(latest);
    const continued = { ...latest, title: "continued from latest" };
    await reader.save(continued);
    expect(await (await openSessionStore(directory)).get(committed.id)).toEqual(continued);
  },
);

it("does not replace a newer in-process writer cache with an older read prefix", async () => {
  const { writer, committed } = await fixture();
  const latest = { ...committed, title: "concurrent save" };
  const readJson = io.readJson;
  const read = vi.spyOn(io, "readJson").mockImplementation(async (path, limit) => {
    const raw = await readJson(path, limit);
    if (path.endsWith("/00000001.json")) await writer.save(latest);
    return raw;
  });
  expect(await writer.get(committed.id)).toEqual(committed);
  read.mockRestore();
  await writer.save({ ...latest, title: "next save" });
  const reopened = await openSessionStore(directory);
  expect((await reopened.get(committed.id)).title).toBe("next save");
});

it("keeps an active session listed without publishing a stale summary index", async () => {
  const { writer, reader, committed } = await fixture();
  const indexPath = join(directory, "sessions", "summaries", `${committed.id}.json`);
  await rm(indexPath);
  let changes = 0;
  const readJson = io.readJson;
  const read = vi.spyOn(io, "readJson").mockImplementation(async (path, limit) => {
    const raw = await readJson(path, limit);
    if (path.endsWith("/00000001.json")) {
      changes++;
      await writer.save({ ...committed, title: `new summary ${changes}` });
    }
    return raw;
  });
  expect(await reader.list()).toMatchObject([{ id: committed.id, title: committed.title }]);
  expect(changes).toBe(1);
  read.mockRestore();
  expect(JSON.parse(await readFile(indexPath, "utf8")).summary.title).toBe("new summary 1");
  expect(await reader.list()).toMatchObject([{ id: committed.id, title: "new summary 1" }]);
});

it("does not grant writers permission to save from a concurrently changing prefix", async () => {
  const { writer, reader, committed } = await fixture();
  let changes = 0;
  const readJson = io.readJson;
  const read = vi.spyOn(io, "readJson").mockImplementation(async (path, limit) => {
    const raw = await readJson(path, limit);
    if (path.endsWith("/00000001.json")) {
      changes++;
      await writer.save({ ...committed, title: `owner ${changes}` });
    }
    return raw;
  });
  await expect(reader.save({ ...committed, title: "must not be committed" })).rejects.toMatchObject({
    code: "storage", retryable: true,
  });
  expect(changes).toBe(3);
  read.mockRestore();
  expect((await reader.get(committed.id)).title).toBe("owner 3");
});

it.each(["hash", "sequence", "json"] as const)(
  "still rejects corrupt %s records instead of returning an older snapshot",
  async (corruption) => {
    const { writer, reader, committed } = await fixture();
    await writer.save({ ...committed, title: "second record" });
    const folder = join(directory, "sessions");
    const generation = (await readdir(folder)).find(name => name.endsWith(".journal"))!;
    const first = join(folder, generation, "00000001.json");
    if (corruption === "sequence") await rm(first);
    else if (corruption === "json") await writeFile(first, "{", { mode: 0o600 });
    else {
      const record = JSON.parse(await readFile(first, "utf8"));
      record.after = "0".repeat(64);
      await writeFile(first, JSON.stringify(record), { mode: 0o600 });
    }
    await expect(reader.get(committed.id)).rejects.toMatchObject({ code: "storage", retryable: false });
  },
);

it("serves complete snapshots to concurrent readers across journal checkpoint rotation", async () => {
  const { writer, committed } = await fixture();
  const readers = await Promise.all([openSessionStore(directory), openSessionStore(directory)]);
  let latest = committed;
  let finished = false;
  let readCount = 0;
  await Promise.all([
    (async () => {
      try {
        for (let index = 0; index < 70; index++) {
          latest = {
            ...latest,
            title: `turn ${index}`,
            messages: [...latest.messages, { role: "assistant", content: `answer ${index}` }],
          };
          await writer.save(latest);
        }
      } finally { finished = true; }
    })(),
    ...readers.map(async reader => {
      let previousLength = 0;
      do {
        const snapshot = await reader.get(committed.id);
        expect(snapshot.messages.length).toBeGreaterThanOrEqual(previousLength);
        expect(snapshot.messages).toEqual(latest.messages.slice(0, snapshot.messages.length));
        previousLength = snapshot.messages.length;
        readCount++;
      } while (!finished);
    }),
  ]);
  expect(readCount).toBeGreaterThan(2);
  for (const reader of readers) expect(await reader.get(committed.id)).toEqual(latest);
}, 20000);
