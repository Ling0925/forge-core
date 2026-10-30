import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testScratch } from "../fixtures/scratch";
import { afterEach, expect, it } from "vitest";
import type { AgentProfileInput } from "../../src/shared/agent-profiles";
import { openSettingsStore } from "../../src/store/settings";

// All fixtures live under the ignored test scratch root; nothing reads
// or writes the real FORGE_HOME.
const temp = testScratch("agent-collaboration");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  await mkdir(temp, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(temp, "case-"));
  directories.push(directory);
  return directory;
}

const profile = (
  id: string,
  overrides: Partial<AgentProfileInput> = {},
): AgentProfileInput => ({
  id,
  name: id,
  description: `${id} description`,
  whenToUse: `use ${id}`,
  instructions: `act as ${id}`,
  enabled: true,
  model: { mode: "inherit" },
  permission: "workspace",
  tools: { mode: "restricted", groups: ["read"], mcpServers: [] },
  isolation: "shared",
  ...overrides,
});

const source = (id: string) => ({
  id,
  label: id.toUpperCase(),
  baseUrl: `https://${id}.test/v1`,
  model: `${id}/model`,
  apiMode: "chat-completions" as const,
});

const profilesOf = async (directory: string) => {
  const state = JSON.parse(
    await readFile(join(directory, "settings/state.json"), "utf8"),
  ) as {
    agentProfiles?: readonly {
      id: string;
      revision: number;
      enabled: boolean;
    }[];
    agentProfilesRevision?: number;
    settings: Record<string, unknown>;
  };
  return state;
};

it("publishes an empty profile list for empty and legacy settings without losing legacy values", async () => {
  const empty = await fixture();
  expect(await (await openSettingsStore(empty)).getPublic()).toMatchObject({
    agentProfiles: [],
  });

  // Legacy config.json only: no state.json, no agentProfiles field at all.
  const legacy = await fixture();
  const folder = join(legacy, "settings");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const settings = {
    baseUrl: "https://old.test/v1",
    model: "old/model",
    apiMode: "responses",
    theme: "dark",
    maxOutputTokens: 4096,
  };
  await writeFile(
    join(folder, "config.json"),
    JSON.stringify({ version: 1, settings }),
    { mode: 0o600 },
  );
  await writeFile(
    join(folder, "credential.json"),
    JSON.stringify({ version: 1, apiKey: "fixture-legacy" }),
    { mode: 0o600 },
  );
  const store = await openSettingsStore(legacy);
  expect(await store.getPublic()).toMatchObject({
    agentProfiles: [],
    theme: "dark",
    maxOutputTokens: 4096,
    model: "old/model",
  });
  expect(await store.getProviderConfig()).toMatchObject({
    apiKey: "fixture-legacy",
    baseUrl: "https://old.test/v1",
  });
  // The migration itself stays lazy: it must not invent an agentProfiles field.
  expect(await profilesOf(legacy)).not.toHaveProperty("agentProfiles");
});

it("keeps an existing v2 transaction's sources and settings when it has no profile list", async () => {
  const directory = await fixture();
  const folder = join(directory, "settings");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(
    join(folder, "state.json"),
    JSON.stringify({
      version: 2,
      settings: {
        baseUrl: "https://kept.test/v1",
        model: "kept/model",
        apiMode: "responses",
        theme: "light",
      },
      apiKey: "fixture-kept",
      sources: [
        {
          id: "kept",
          label: "Kept",
          baseUrl: "https://kept.test/v1",
          model: "kept/model",
          apiMode: "responses",
          apiKey: "fixture-kept",
          revision: 4,
        },
      ],
      routeGroups: [],
      activeSourceId: "kept",
    }),
    { mode: 0o600 },
  );
  const store = await openSettingsStore(directory);
  expect(await store.getPublic()).toMatchObject({
    agentProfiles: [],
    theme: "light",
    activeSourceId: "kept",
    routeGroups: [],
  });
  expect((await store.getPublic()).providerSources).toMatchObject([
    { id: "kept", revision: 4 },
  ]);
  // Reading alone must not rewrite the transaction just to add the field.
  const before = await readFile(join(folder, "state.json"), "utf8");
  expect(JSON.parse(before)).not.toHaveProperty("agentProfiles");
});

it("rejects a stored profile that pins a source which is not present", async () => {
  const directory = await fixture();
  const folder = join(directory, "settings");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(
    join(folder, "state.json"),
    JSON.stringify({
      version: 2,
      settings: { baseUrl: "", model: "", theme: "system" },
      apiKey: "",
      sources: [],
      agentProfiles: [
        {
          id: "backend",
          name: "backend",
          description: "backend description",
          whenToUse: "use backend",
          instructions: "act as backend",
          enabled: true,
          model: {
            mode: "fixed",
            providerSourceId: "gone",
            model: "gone/model",
          },
          permission: "workspace",
          tools: { mode: "inherit" },
          isolation: "shared",
          revision: 2,
        },
      ],
      agentProfilesRevision: 2,
    }),
    { mode: 0o600 },
  );
  // Never fall back to the active or any other source: corrupt state is loud.
  await expect(openSettingsStore(directory)).rejects.toMatchObject({
    code: "storage",
  });
});

it("creates, updates, disables and deletes one profile without rewriting its siblings", async () => {
  const directory = await fixture();
  const store = await openSettingsStore(directory);
  await store.update({ settings: { theme: "dark" } });

  const created = await store.update({
    agent: { type: "save", profile: profile("explorer"), expectedRevision: 0 },
  });
  expect(created.agentProfiles).toMatchObject([
    { id: "explorer", enabled: true, revision: 1 },
  ]);
  await store.update({
    agent: { type: "save", profile: profile("reviewer"), expectedRevision: 0 },
  });
  expect(
    (await store.getPublic()).agentProfiles?.map((item) => item.id),
  ).toEqual(["explorer", "reviewer"]);

  const updated = await store.update({
    agent: {
      type: "save",
      profile: profile("explorer", { name: "Explorer v2", enabled: false }),
      expectedRevision: 1,
    },
  });
  expect(
    updated.agentProfiles?.find((item) => item.id === "explorer"),
  ).toMatchObject({ name: "Explorer v2", enabled: false, revision: 3 });
  // Sibling profile and unrelated settings are untouched by the single-item edit.
  expect(
    updated.agentProfiles?.find((item) => item.id === "reviewer"),
  ).toMatchObject({ revision: 2, enabled: true });
  expect(updated.theme).toBe("dark");

  const removed = await store.update({
    agent: { type: "remove", id: "explorer", expectedRevision: 3 },
  });
  expect(removed.agentProfiles?.map((item) => item.id)).toEqual(["reviewer"]);

  // Persisted across a reopen, still without touching ordinary settings.
  const reopened = await openSettingsStore(directory);
  expect(await reopened.getPublic()).toMatchObject({
    theme: "dark",
    agentProfiles: [{ id: "reviewer", revision: 2 }],
  });
});

it("rejects a stale profile revision instead of overwriting a concurrent role", async () => {
  const directory = await fixture();
  const one = await openSettingsStore(directory);
  const two = await openSettingsStore(directory);
  await one.update({
    agent: { type: "save", profile: profile("explorer"), expectedRevision: 0 },
  });
  await two.update({
    agent: {
      type: "save",
      profile: profile("explorer", { name: "FROM TWO" }),
      expectedRevision: 1,
    },
  });
  await expect(
    one.update({
      agent: {
        type: "save",
        profile: profile("explorer", { name: "FROM ONE" }),
        expectedRevision: 1,
      },
    }),
  ).rejects.toThrow("已被其他窗口或 CLI 修改");
  expect((await one.getPublic()).agentProfiles).toMatchObject([
    { id: "explorer", name: "FROM TWO", revision: 2 },
  ]);
  // A stale delete for the same role is refused too.
  await expect(
    one.update({
      agent: { type: "remove", id: "explorer", expectedRevision: 1 },
    }),
  ).rejects.toThrow("已被其他窗口或 CLI 修改");
  expect((await one.getPublic()).agentProfiles).toHaveLength(1);
});

it("keeps revisions monotonic across delete and re-create so an old window cannot revive a role", async () => {
  const directory = await fixture();
  const store = await openSettingsStore(directory);
  await store.update({
    agent: { type: "save", profile: profile("explorer"), expectedRevision: 0 },
  });
  expect((await store.getPublic()).agentProfiles?.[0]?.revision).toBe(1);
  await store.update({
    agent: { type: "remove", id: "explorer", expectedRevision: 1 },
  });
  // The removal still advances the counter, so a re-created id gets a fresh
  // revision rather than restarting at 1.
  const recreated = await store.update({
    agent: { type: "save", profile: profile("explorer"), expectedRevision: 0 },
  });
  const revision = recreated.agentProfiles?.[0]?.revision ?? 0;
  expect(revision).toBe(3);
  expect((await profilesOf(directory)).agentProfilesRevision).toBe(3);
  // A browser still holding the pre-delete revision 1 must not overwrite it.
  await expect(
    store.update({
      agent: {
        type: "save",
        profile: profile("explorer", { name: "STALE" }),
        expectedRevision: 1,
      },
    }),
  ).rejects.toThrow("已被其他窗口或 CLI 修改");
  expect((await store.getPublic()).agentProfiles).toMatchObject([
    { id: "explorer", name: "explorer", revision: 3 },
  ]);
  // Deleting the re-created role with its current revision succeeds.
  await store.update({
    agent: { type: "remove", id: "explorer", expectedRevision: revision },
  });
  expect((await store.getPublic()).agentProfiles).toEqual([]);
});

it("pins a fixed profile to an existing source without copying credentials", async () => {
  const directory = await fixture();
  const store = await openSettingsStore(directory);
  await store.update({
    source: { type: "save", source: source("a"), apiKey: "fixture-a" },
  });

  // A source id that does not exist is rejected, never silently re-routed.
  await expect(
    store.update({
      agent: {
        type: "save",
        profile: profile("backend", {
          model: {
            mode: "fixed",
            providerSourceId: "missing",
            model: "x/model",
          },
        }),
        expectedRevision: 0,
      },
    }),
  ).rejects.toThrow("模型来源不存在");
  expect((await store.getPublic()).agentProfiles).toEqual([]);

  const saved = await store.update({
    agent: {
      type: "save",
      profile: profile("backend", {
        model: { mode: "fixed", providerSourceId: "a", model: "a/model" },
      }),
      expectedRevision: 0,
    },
  });
  expect(saved.agentProfiles?.[0]?.model).toEqual({
    mode: "fixed",
    providerSourceId: "a",
    model: "a/model",
  });
  const stored = await readFile(join(directory, "settings/state.json"), "utf8");
  const persisted = JSON.parse(stored) as {
    agentProfiles: readonly unknown[];
  };
  expect(persisted.agentProfiles).toMatchObject([
    { id: "backend", model: { providerSourceId: "a" } },
  ]);
  // Credentials stay with the provider source and are never copied into a role.
  expect(JSON.stringify(persisted.agentProfiles)).not.toContain("fixture-a");
  expect(JSON.stringify(await store.getPublic())).not.toContain("fixture-a");
});

it("rejects mixed profile/source writes and a delete of an already-removed profile", async () => {
  const directory = await fixture();
  const store = await openSettingsStore(directory);
  await store.update({
    agent: { type: "save", profile: profile("explorer"), expectedRevision: 0 },
  });
  // Cross-referencing profile and source edits in one call would be
  // order-dependent, so the write is refused and nothing is committed.
  await expect(
    store.update({
      agent: {
        type: "save",
        profile: profile("backend", {
          model: { mode: "fixed", providerSourceId: "a", model: "a/model" },
        }),
        expectedRevision: 0,
      },
      source: { type: "save", source: source("a"), apiKey: "fixture-a" },
    }),
  ).rejects.toThrow("不能与来源操作同时提交");
  expect(
    (await store.getPublic()).agentProfiles?.map((item) => item.id),
  ).toEqual(["explorer"]);
  expect((await store.getPublic()).providerSources).toEqual([]);

  await store.update({
    agent: { type: "remove", id: "explorer", expectedRevision: 1 },
  });
  await expect(
    store.update({
      agent: { type: "remove", id: "explorer", expectedRevision: 2 },
    }),
  ).rejects.toMatchObject({ code: "not_found" });
});

it("refuses to remove a source a fixed profile still references and asks for a profile edit", async () => {
  const directory = await fixture();
  const store = await openSettingsStore(directory);
  await store.update({
    source: { type: "save", source: source("a"), apiKey: "fixture-a" },
  });
  await store.update({
    source: { type: "save", source: source("b"), apiKey: "fixture-b" },
  });
  await store.update({
    agent: {
      type: "save",
      profile: profile("backend", {
        name: "后端",
        model: { mode: "fixed", providerSourceId: "a", model: "a/model" },
      }),
      expectedRevision: 0,
    },
  });
  await expect(
    store.update({ source: { type: "remove", id: "a" } }),
  ).rejects.toThrow("请先修改或删除这些智能体配置");
  expect(
    (await store.getPublic()).providerSources?.map((item) => item.id),
  ).toEqual(["a", "b"]);

  // Inherited profiles do not block removal of an unused source.
  await store.update({ source: { type: "remove", id: "b" } });
  expect(
    (await store.getPublic()).providerSources?.map((item) => item.id),
  ).toEqual(["a"]);

  // Once the profile is gone, the source can be removed normally.
  await store.update({
    agent: { type: "remove", id: "backend", expectedRevision: 1 },
  });
  await store.update({ source: { type: "remove", id: "a" } });
  expect((await store.getPublic()).providerSources).toEqual([]);
});

it("validates the stored profile schema and rolls back a rejected transaction", async () => {
  const directory = await fixture();
  const store = await openSettingsStore(directory);
  await store.update({
    agent: { type: "save", profile: profile("explorer"), expectedRevision: 0 },
  });
  const before = await readFile(join(directory, "settings/state.json"), "utf8");

  // Unknown fields and over-long collections fail before write.
  await expect(
    store.update({
      agent: {
        type: "save",
        // Runtime-unsafe extra field, exactly what a stale renderer may send.
        profile: { ...profile("reviewer"), apiKey: "fixture-leak" } as never,
        expectedRevision: 0,
      },
    }),
  ).rejects.toThrow("Settings failed validation");
  await expect(
    store.update({
      agent: {
        type: "save",
        profile: profile("Bad Id"),
        expectedRevision: 0,
      },
    }),
  ).rejects.toThrow("Settings failed validation");
  expect(await readFile(join(directory, "settings/state.json"), "utf8")).toBe(
    before,
  );

  for (let index = 1; index < 64; index += 1) {
    await store.update({
      agent: {
        type: "save",
        profile: profile(`role-${index}`),
        expectedRevision: 0,
      },
    });
  }
  expect((await store.getPublic()).agentProfiles).toHaveLength(64);
  await expect(
    store.update({
      agent: {
        type: "save",
        profile: profile("overflow"),
        expectedRevision: 0,
      },
    }),
  ).rejects.toThrow("最多 64");
  expect((await store.getPublic()).agentProfiles).toHaveLength(64);
});

it("serializes concurrent profile edits across stores without losing either role", async () => {
  const directory = await fixture();
  const one = await openSettingsStore(directory);
  const two = await openSettingsStore(directory);
  await Promise.all([
    one.update({
      agent: {
        type: "save",
        profile: profile("explorer"),
        expectedRevision: 0,
      },
    }),
    two.update({
      agent: {
        type: "save",
        profile: profile("reviewer"),
        expectedRevision: 0,
      },
    }),
  ]);
  const merged = (await one.getPublic()).agentProfiles ?? [];
  expect(merged.map((item) => item.id).sort()).toEqual(["explorer", "reviewer"]);
  // Revisions come from one shared counter, so they never collide.
  expect(new Set(merged.map((item) => item.revision)).size).toBe(2);
  expect((await profilesOf(directory)).agentProfilesRevision).toBe(2);
});
