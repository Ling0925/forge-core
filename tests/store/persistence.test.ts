import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionId } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { openSettingsStore } from "../../src/store/settings";

const forgeEnvironment = [
  "FORGE_BASE_URL",
  "FORGE_MODEL",
  "FORGE_API_KEY",
] as const;
function unsetForgeEnvironment() {
  for (const name of forgeEnvironment)
    Reflect.deleteProperty(process.env, name);
}

describe("private persistence", () => {
  let directory = "";
  const saved = {
    base: process.env.FORGE_BASE_URL,
    model: process.env.FORGE_MODEL,
    key: process.env.FORGE_API_KEY,
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "forge-store-"));
    unsetForgeEnvironment();
  });
  afterEach(async () => {
    for (const [name, value] of [
      ["FORGE_BASE_URL", saved.base],
      ["FORGE_MODEL", saved.model],
      ["FORGE_API_KEY", saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  it("roundtrips without recovering live state and enforces modes", async () => {
    const store = await openSessionStore(directory);
    const first = await store.create({
      workspace: directory,
      title: "first",
      model: "test-model",
    });
    const release = await store.acquire(first.id);
    await store.save({ ...first, status: "running" });
    expect((await store.get(first.id)).status).toBe("running");
    expect((await store.list())[0]?.status).toBe("running");
    const other = await openSessionStore(directory);
    await expect(other.acquire(first.id)).rejects.toMatchObject({
      code: "busy",
    });
    expect((await stat(join(directory, "sessions"))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(directory, "sessions", `${first.id}.json`))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(directory, "sessions", `${first.id}.json.lock`))).mode &
        0o777,
    ).toBe(0o600);
    await release();
    await release();
    const next = await other.acquire(first.id);
    await next();
  });
  it("rejects missing, corrupt, future-version and symlink records", async () => {
    const store = await openSessionStore(directory);
    await expect(store.get(parseSessionId(randomUUID()))).rejects.toMatchObject(
      { code: "not_found" },
    );
    const snapshot = await store.create({
      workspace: directory,
      title: "record",
      model: "model",
    });
    const path = join(directory, "sessions", `${snapshot.id}.json`);
    await writeFile(path, JSON.stringify({ ...snapshot, version: 2 }));
    await expect(store.get(snapshot.id)).rejects.toMatchObject({
      code: "storage",
    });
    await writeFile(path, "{");
    expect(await store.list()).toEqual([]);
    await expect(store.get(snapshot.id)).rejects.toMatchObject({ code: "storage" });
    await rm(path);
    await symlink(join(directory, "absent"), path);
    await expect(store.get(snapshot.id)).rejects.toMatchObject({
      code: "storage",
    });
  });
  it("has one simultaneous winner and no cancelled lock", async () => {
    const store = await openSessionStore(directory);
    const snapshot = await store.create({
      workspace: directory,
      title: "record",
      model: "model",
    });
    const results = await Promise.allSettled([
      store.acquire(snapshot.id),
      store.acquire(snapshot.id),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    for (const result of results)
      if (result.status === "fulfilled") await result.value();
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.acquire(snapshot.id, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    const release = await store.acquire(snapshot.id);
    await release();
  });
  it("reclaims a provably dead owner, but not a live one", async () => {
    const store = await openSessionStore(directory);
    const snapshot = await store.create({
      workspace: directory,
      title: "record",
      model: "model",
    });
    const path = join(directory, "sessions", `${snapshot.id}.json.lock`);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        token: randomUUID(),
        pid: 2147483647,
        start: null,
      }),
      { mode: 0o600 },
    );
    const release = await store.acquire(snapshot.id);
    await release();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        token: randomUUID(),
        pid: process.pid,
        start: null,
      }),
      { mode: 0o600 },
    );
    await expect(store.acquire(snapshot.id)).rejects.toMatchObject({
      code: "busy",
    });
  });
  it("boots unset and supports endpoint-first configuration and separated credentials", async () => {
    const settings = await openSettingsStore(directory);
    expect(await settings.getPublic()).toMatchObject({
      baseUrl: "",
      model: "",
      isConfigured: false,
    });
    await settings.update({
      settings: { baseUrl: "https://example.invalid" },
      apiKey: "test-only-secret",
    });
    expect(await settings.getProviderConfig()).toMatchObject({
      baseUrl: "https://example.invalid",
    });
    expect((await settings.getPublic()).isConfigured).toBe(false);
    await settings.update({ settings: { model: "chosen" } });
    expect((await settings.getProviderConfig()).apiKey).toBe(
      "test-only-secret",
    );
    const publicValue = await settings.getPublic();
    expect(publicValue.isConfigured).toBe(true);
    expect(JSON.stringify(publicValue)).not.toContain("test-only-secret");
    expect(
      await readFile(join(directory, "settings", "config.json"), "utf8"),
    ).not.toContain("test-only-secret");
    const sessions = await openSessionStore(directory);
    const snapshot = await sessions.create({
      workspace: directory,
      title: "safe",
      model: "chosen",
    });
    expect(
      await readFile(
        join(directory, "sessions", `${snapshot.id}.json`),
        "utf8",
      ),
    ).not.toContain("test-only-secret");
    expect(
      (await stat(join(directory, "settings", "credential.json"))).mode & 0o777,
    ).toBe(0o600);
    await settings.update({ apiKey: "" });
    expect((await settings.getPublic()).hasApiKey).toBe(false);
  });
  it("validates explicit environment overrides without persisting them", async () => {
    const settings = await openSettingsStore(directory);
    process.env.FORGE_BASE_URL = "https://example.invalid";
    process.env.FORGE_MODEL = "overlay";
    process.env.FORGE_API_KEY = "temporary-test-key";
    expect(await settings.getPublic()).toMatchObject({
      model: "overlay",
      hasApiKey: true,
      isConfigured: true,
    });
    await settings.update({ settings: { theme: "dark" } });
    Reflect.deleteProperty(process.env, "FORGE_MODEL");
    Reflect.deleteProperty(process.env, "FORGE_API_KEY");
    expect(await settings.getPublic()).toMatchObject({
      model: "",
      hasApiKey: false,
      theme: "dark",
    });
    process.env.FORGE_BASE_URL = "not a URL";
    await expect(settings.getPublic()).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
