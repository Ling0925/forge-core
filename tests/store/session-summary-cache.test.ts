import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as io from "../../src/store/io";
import { openSessionStore } from "../../src/store/sessions";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-summary-cache-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const writer = await openSessionStore(directory);
  const initial = await writer.create({
    workspace: directory,
    title: "original",
    model: "fixture",
  });
  return {
    writer,
    initial,
    reader: await openSessionStore(directory),
    basePath: join(directory, "sessions", `${initial.id}.json`),
    indexPath: join(directory, "sessions", "summaries", `${initial.id}.json`),
  };
}

it("reuses unchanged summary indexes without reading or rewriting them", async () => {
  const { reader, indexPath } = await fixture();
  const before = await readFile(indexPath, "utf8");
  const read = vi.spyOn(io, "readJson");
  const first = await reader.list();
  expect(read.mock.calls).toEqual([[indexPath, 65536]]);
  read.mockClear();
  expect(await reader.list()).toEqual(first);
  expect(await reader.list()).toEqual(first);
  expect(read).not.toHaveBeenCalled();
  expect(Object.isFrozen(first[0])).toBe(true);
  expect(await (await openSessionStore(directory)).list()).toEqual(first);
  expect(await readFile(indexPath, "utf8")).toBe(before);
});

it("picks up an index rebuilt by another store with unchanged base and journal stamps", async () => {
  const { reader, writer, indexPath } = await fixture();
  const original = JSON.parse(await readFile(indexPath, "utf8"));
  await io.atomicJson(indexPath, {
    ...original,
    summary: { ...original.summary, title: "indexed title" },
  });
  expect(await reader.list()).toMatchObject([{ title: "indexed title" }]);
  await rm(indexPath);
  const rebuilt = await writer.list();
  expect(JSON.parse(await readFile(indexPath, "utf8"))).toEqual(original);

  const read = vi.spyOn(io, "readJson");
  expect(await reader.list()).toEqual(rebuilt);
  expect(read.mock.calls).toEqual([[indexPath, 65536]]);
  read.mockClear();
  expect(await reader.list()).toEqual(rebuilt);
  expect(read).not.toHaveBeenCalled();
});

it.each(["same", "another"] as const)(
  "invalidates the cached index after the %s store writes it",
  async (source) => {
    const { reader, writer, initial, indexPath } = await fixture();
    await reader.list();
    await (source === "same" ? reader : writer).save({
      ...initial,
      title: "saved title",
    });

    const read = vi.spyOn(io, "readJson");
    const summaries = await reader.list();
    expect(summaries).toMatchObject([{ title: "saved title" }]);
    expect(read.mock.calls).toEqual([[indexPath, 65536]]);
    read.mockClear();
    expect(await reader.list()).toEqual(summaries);
    expect(read).not.toHaveBeenCalled();
    expect(await (await openSessionStore(directory)).list()).toEqual(summaries);
  },
);

it.each(["base", "journal"] as const)(
  "loads the session when the %s changes while the cached index stays unchanged",
  async (changed) => {
    const { reader, writer, initial, basePath, indexPath } = await fixture();
    await reader.list();
    const before = await readFile(indexPath, "utf8");
    const atomicJson = io.atomicJson;
    const write = vi
      .spyOn(io, "atomicJson")
      .mockImplementation(async (path, value, limit) => {
        if (path !== indexPath) await atomicJson(path, value, limit);
      });
    await writer.save({
      ...initial,
      title: "unindexed title",
      status: changed === "base" ? "completed" : "running",
    });
    write.mockRestore();
    expect(await readFile(indexPath, "utf8")).toBe(before);

    const read = vi.spyOn(io, "readJson");
    const summaries = await reader.list();
    expect(summaries).toMatchObject([{ title: "unindexed title" }]);
    expect(read.mock.calls.some(([path]) => path === basePath)).toBe(true);
    expect(read.mock.calls.some(([path]) => path === indexPath)).toBe(false);
    expect(await (await openSessionStore(directory)).list()).toEqual(summaries);
    await reader.list();
    read.mockClear();
    expect(await reader.list()).toEqual(summaries);
    expect(read).not.toHaveBeenCalled();
  },
);

it("does not cache old contents under the stamp of a concurrent index replacement", async () => {
  const { reader, indexPath } = await fixture();
  const original = JSON.parse(await readFile(indexPath, "utf8"));
  const readJson = io.readJson;
  const read = vi
    .spyOn(io, "readJson")
    .mockImplementationOnce(async (path, limit) => {
      const raw = await readJson(path, limit);
      await io.atomicJson(indexPath, {
        ...original,
        summary: { ...original.summary, title: "replacement title" },
      });
      return raw;
    });
  expect(await reader.list()).toMatchObject([{ title: "original" }]);
  const summaries = await reader.list();
  expect(summaries).toMatchObject([{ title: "replacement title" }]);
  expect(read.mock.calls).toEqual([
    [indexPath, 65536],
    [indexPath, 65536],
  ]);
  read.mockClear();
  expect(await reader.list()).toEqual(summaries);
  expect(read).not.toHaveBeenCalled();
  expect(await (await openSessionStore(directory)).list()).toEqual(summaries);
});

it.each(["missing", "json", "schema", "id"] as const)(
  "rebuilds a cached index after it becomes invalid (%s)",
  async (invalid) => {
    const { reader, basePath, indexPath } = await fixture();
    const expected = await reader.list();
    const original = JSON.parse(await readFile(indexPath, "utf8"));
    if (invalid === "missing") await rm(indexPath);
    else if (invalid === "json") await writeFile(indexPath, "{");
    else if (invalid === "schema")
      await io.atomicJson(indexPath, { ...original, version: 2 });
    else
      await io.atomicJson(indexPath, {
        ...original,
        summary: { ...original.summary, id: randomUUID() },
      });

    const read = vi.spyOn(io, "readJson");
    expect(await reader.list()).toEqual(expected);
    expect(read.mock.calls.some(([path]) => path === basePath)).toBe(true);
    expect(JSON.parse(await readFile(indexPath, "utf8"))).toEqual(original);
    expect(await (await openSessionStore(directory)).list()).toEqual(expected);
  },
);

it("excludes deleted sessions and reloads a recreated base", async () => {
  const { reader, basePath } = await fixture();
  const original = JSON.parse(await readFile(basePath, "utf8"));
  await reader.list();
  await rm(basePath);
  expect(await reader.list()).toEqual([]);
  await io.atomicJson(basePath, { ...original, title: "recreated title" });
  const summaries = await reader.list();
  expect(summaries).toMatchObject([{ title: "recreated title" }]);
  expect(await (await openSessionStore(directory)).list()).toEqual(summaries);
});
