import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Linux stamps inodes from a coarse clock, so a journal append in the same
// tick leaves the directory's mtime/ctime (and, on ext4, its size) unchanged.
// Freeze directory timestamps and coarsen file ones to model that clock.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    const info = await actual.lstat(...args);
    const copy = (fields: object) =>
      Object.assign(Object.create(Object.getPrototypeOf(info)), info, fields);
    if (info.isDirectory()) return copy({ size: 4096, mtimeMs: 1, ctimeMs: 1 });
    // Files: a 1 s clock, so a same-length rewrite right after a commit keeps
    // its whole stamp.
    const tick = (ms: number | bigint) => Math.floor(Number(ms) / 1000) * 1000;
    return copy({ mtimeMs: tick(info.mtimeMs), ctimeMs: tick(info.ctimeMs) });
  }) as typeof actual.lstat;
  return { ...actual, default: { ...actual, lstat }, lstat };
});

const io = await import("../../src/store/io");
const { openSessionStore } = await import("../../src/store/sessions");

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-journal-coarse-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("detects a same-tick journal append and never publishes a stale summary index", async () => {
  const writer = await openSessionStore(directory);
  const initial = await writer.create({
    workspace: directory,
    title: "fixture",
    model: "fixture",
  });
  const committed = {
    ...initial,
    status: "running" as const,
    messages: [{ role: "user" as const, content: "accepted" }],
  };
  await writer.save(committed);
  const reader = await openSessionStore(directory);
  const indexPath = join(
    directory,
    "sessions",
    "summaries",
    `${committed.id}.json`,
  );
  await rm(indexPath);
  const readJson = io.readJson;
  let changes = 0;
  vi.spyOn(io, "readJson").mockImplementation(async (path, limit) => {
    const raw = await readJson(path, limit);
    if (path.endsWith("/00000001.json") && changes++ === 0)
      await writer.save({ ...committed, title: "newer" });
    return raw;
  });
  await reader.list();
  vi.restoreAllMocks();
  const index = await readFile(indexPath, "utf8").then(
    (text) => JSON.parse(text).summary.title as string,
    () => undefined,
  );
  // Either no index yet, or the current one; never the stale "fixture".
  expect(index === undefined || index === "newer").toBe(true);
  expect((await reader.get(committed.id)).title).toBe("newer");
});

it("detects a same-tick in-place rewrite of a cached record", async () => {
  const store = await openSessionStore(directory);
  const initial = await store.create({
    workspace: directory,
    title: "fixture",
    model: "fixture",
  });
  await store.save({ ...initial, status: "running", title: "changed" });
  const folder = join(directory, "sessions");
  const name = (await readdir(folder)).find((item) =>
    item.endsWith(".journal"),
  );
  if (!name) throw new Error("Missing journal");
  const path = join(folder, name, "00000001.json");
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace("changed", "damaged"));
  await expect(store.get(initial.id)).rejects.toMatchObject({
    code: "storage",
  });
});
