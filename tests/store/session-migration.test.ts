import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { migrateSessionStorage } from "../../scripts/migrate-session-storage";
import { openSessionStore } from "../../src/store/sessions";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("backs up legacy and journaled sessions before lossless migration without changing settings or lock inodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-session-migration-"));
  directories.push(root);
  const store = await openSessionStore(root);
  const initial = await store.create({
    workspace: root,
    title: "legacy",
    model: "fixture",
  });
  const legacy = {
    ...initial,
    messages: [{ role: "user" as const, content: "retained" }],
  };
  const path = join(root, "sessions", `${initial.id}.json`);
  const original = `${JSON.stringify(legacy)}\n`;
  await writeFile(path, original);
  const journaled = await store.create({
    workspace: root,
    title: "journaled",
    model: "fixture",
  });
  const next = { ...journaled, title: "from delta" };
  await store.save(next);
  await mkdir(join(root, "settings"), { mode: 0o700 });
  const settings = '{"fixture":"retained opaque configuration"}\n';
  await writeFile(join(root, "settings", "state.json"), settings, {
    mode: 0o600,
  });
  await (await store.acquire(initial.id))();
  const inode = (await stat(`${path}.lock`)).ino;
  const result = await migrateSessionStorage(root);
  expect(result.sessions).toBe(2);
  expect(
    await readFile(
      join(result.backup, "sessions", `${initial.id}.json`),
      "utf8",
    ),
  ).toBe(original);
  expect(
    await readFile(join(result.backup, "settings", "state.json"), "utf8"),
  ).toBe(settings);
  expect(await readFile(join(root, "settings", "state.json"), "utf8")).toBe(
    settings,
  );
  expect(JSON.parse(await readFile(path, "utf8"))._journalGeneration).toEqual(
    expect.any(String),
  );
  const reopened = await openSessionStore(root);
  expect(await reopened.get(initial.id)).toEqual(legacy);
  expect(await reopened.get(journaled.id)).toEqual(next);
  expect(await reopened.list()).toHaveLength(2);
  expect((await stat(`${path}.lock`)).ino).toBe(inode);
  expect((await stat(result.backup)).mode & 0o777).toBe(0o700);
});
