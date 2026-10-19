import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openSettingsStore } from "../../src/store/settings";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const source = (id: string) => ({
  id, label: id, baseUrl: `https://${id}.test/v1`, model: `${id}/model`,
  apiMode: "responses", apiKey: `fixture-${id}`,
});
const legacy = () => ({
  version: 1,
  settings: { baseUrl: "https://b.test/v1", model: "b/model", apiMode: "responses", theme: "dark", maxOutputTokens: 4096 },
  apiKey: "fixture-b",
  sources: [source("a"), source("b"), { ...source("c"), revision: 7 }, { ...source("d"), revision: 0 }],
  activeSourceId: "b",
});
async function fixture(state: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "forge-revision-migration-"));
  directories.push(directory);
  await mkdir(join(directory, "settings"), { mode: 0o700 });
  const path = join(directory, "settings/state.json");
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  return { directory, path };
}

it("migrates missing source revisions under concurrent opens without changing existing values or unrelated files", async () => {
  const original = legacy();
  const { directory, path } = await fixture(original);
  const untouched = ["settings/config.json", "settings/credential.json", "sessions/existing.json"];
  await mkdir(join(directory, "sessions"), { mode: 0o700 });
  for (const name of untouched) await writeFile(join(directory, name), `preserve ${name}\n`, { mode: 0o600 });

  const stores = await Promise.all([openSettingsStore(directory), openSettingsStore(directory)]);

  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    ...original,
    sources: [{ ...source("a"), revision: 1 }, { ...source("b"), revision: 1 }, { ...source("c"), revision: 7 }, { ...source("d"), revision: 0 }],
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  for (const store of stores) {
    expect(await store.getPublic()).toMatchObject({ activeSourceId: "b", model: "b/model", theme: "dark", maxOutputTokens: 4096 });
    expect(await store.getProviderConfig("a")).toMatchObject({ baseUrl: "https://a.test/v1", apiKey: "fixture-a" });
    expect(await store.getProviderConfig()).toMatchObject({ baseUrl: "https://b.test/v1", apiKey: "fixture-b" });
    expect(JSON.stringify(await store.getPublic())).not.toContain("fixture-");
  }
  for (const name of untouched) expect(await readFile(join(directory, name), "utf8")).toBe(`preserve ${name}\n`);
});

it("does not rewrite a transaction whose sources already have revisions", async () => {
  const state = { ...legacy(), sources: [{ ...source("b"), revision: 9 }] };
  const { directory, path } = await fixture(state);
  const before = await stat(path);

  await openSettingsStore(directory);
  await openSettingsStore(directory);

  expect(await readFile(path, "utf8")).toBe(JSON.stringify(state));
  expect((await stat(path)).ino).toBe(before.ino);
});

it.each([null, -1, 1.5, "1"])("rejects an invalid revision %j without modifying the transaction", async (revision) => {
  const state = { ...legacy(), sources: [{ ...source("b"), revision }] };
  const { directory, path } = await fixture(state);

  await expect(openSettingsStore(directory)).rejects.toMatchObject({ code: "storage" });

  expect(await readFile(path, "utf8")).toBe(JSON.stringify(state));
});
