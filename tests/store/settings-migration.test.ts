import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  afterRead: async (_path: string): Promise<void> => {},
}));
vi.mock("../../src/store/io", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/store/io")>();
  return {
    ...original,
    readJson: async (path: string, limit?: number): Promise<unknown> => {
      const value = await original.readJson(path, limit);
      await hooks.afterRead(path);
      return value;
    },
  };
});
import { openSettingsStore } from "../../src/store/settings";

function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
let directory = "";
afterEach(async () => {
  hooks.afterRead = async () => {};
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("migrates before exposing readers and keeps pairs coherent across a deterministically paused read", async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-migration-"));
  const folder = join(directory, "settings");
  await mkdir(folder, { mode: 0o700 });
  const configPath = join(folder, "config.json");
  const keyPath = join(folder, "credential.json");
  const statePath = join(folder, "state.json");
  const oldPair = { baseUrl: "https://old.invalid", apiKey: "fake-old-key" };
  const newPair = { baseUrl: "https://new.invalid", apiKey: "fake-new-key" };
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      settings: { baseUrl: oldPair.baseUrl, model: "test", maxTurns: 27 },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    keyPath,
    JSON.stringify({ version: 1, apiKey: oldPair.apiKey }),
    { mode: 0o600 },
  );
  const reader = await openSettingsStore(directory);
  // Opening alone, with no update, must publish authoritative private state.
  expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  const writer = await openSettingsStore(directory);
  const entered = barrier();
  const resume = barrier();
  let armed = true;
  const projectionReads: string[] = [];
  hooks.afterRead = async (path) => {
    if (path === configPath || path === keyPath) projectionReads.push(path);
    if (path === statePath && armed) {
      armed = false;
      entered.release();
      await resume.promise;
    }
  };
  const pausedRead = reader.getProviderConfig();
  try {
    await entered.promise;
    // Reader has captured old state; writer commits both new values and updates
    // projections before the reader resumes, recreating the reported schedule.
    await writer.update({
      settings: { baseUrl: newPair.baseUrl },
      apiKey: newPair.apiKey,
    });
  } finally {
    resume.release();
  }
  expect(await pausedRead).toMatchObject(oldPair);
  expect(await reader.getProviderConfig()).toMatchObject(newPair);
  expect(await reader.getPublic()).toMatchObject({ maxTurns: 27 });
  expect(projectionReads).toEqual([]);
  // Missing authoritative state must fail, not resurrect a mixed legacy pair.
  await rm(statePath);
  await writeFile(
    configPath,
    JSON.stringify({ version: 1, settings: { baseUrl: oldPair.baseUrl } }),
  );
  await expect(reader.getProviderConfig()).rejects.toMatchObject({
    code: "not_found",
  });
});
