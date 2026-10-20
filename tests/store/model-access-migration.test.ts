import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openSettingsStore } from "../../src/store/settings";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = { id: "relay", label: "Relay", baseUrl: "http://localhost:1234/v1", model: "vendor/a/b", apiMode: "responses" as const };
const old = { version: 1, settings: { baseUrl: source.baseUrl, model: source.model, apiMode: source.apiMode }, apiKey: "fixture-old", sources: [{ ...source, apiKey: "fixture-old", revision: 4 }], activeSourceId: source.id };
async function fixture(value: unknown = old) {
  const root = await mkdtemp(join(tmpdir(), "forge-access-")); roots.push(root);
  await mkdir(join(root, "settings"), { mode: 0o700 });
  await writeFile(join(root, "settings/state.json"), JSON.stringify(value), { mode: 0o600 });
  return { root, path: join(root, "settings/state.json") };
}
const key = (id: string, apiKey?: string, enabled = true) => ({ id, label: id, type: "api-key" as const, enabled, ...(apiKey === undefined ? {} : { apiKey }) });

it("keeps v1 untouched on read, backs it up only at first extended write, and preserves bindings", async () => {
  const { root, path } = await fixture();
  const store = await openSettingsStore(root);
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(old));
  expect(await store.getProviderConfig("relay")).toMatchObject({ baseUrl: source.baseUrl, apiKey: "fixture-old", apiMode: "responses" });
  await store.update({ source: { type: "save", source: { ...source, activeCredentialId: "default" }, credentials: [key("default"), key("second", "fixture-second")], expectedRevision: 4 } });
  const migrated = JSON.parse(await readFile(path, "utf8"));
  expect(migrated.version).toBe(2);
  expect(migrated.activeSourceId).toBe("relay");
  expect(migrated.sources[0].model).toBe("vendor/a/b");
  expect(JSON.parse(await readFile(join(root, "settings/state.v1.backup.json"), "utf8"))).toEqual(old);
  expect((await stat(join(root, "settings/state.v1.backup.json"))).mode & 0o777).toBe(0o600);
  const reopened = await openSettingsStore(root);
  expect((await reopened.getProviderConfig("relay", "default")).apiKey).toBe("fixture-old");
  expect((await reopened.getProviderConfig("relay", "second")).apiKey).toBe("fixture-second");
  await reopened.update({ settings: { theme: "dark" } });
  expect(JSON.parse(await readFile(join(root, "settings/state.v1.backup.json"), "utf8"))).toEqual(old);
  expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
});
it("preserves secrets on credential edits, isolates protocol endpoints, and projects no private connection values", async () => {
  const { root } = await fixture(); const store = await openSettingsStore(root);
  await store.update({ source: { type: "save", source: { ...source, endpoints: { responses: "https://responses.test/api" } },
    credentials: [key("default"), key("other", "fixture-other")], connection: { headers: { "X-Private": "fixture-header" }, extraBody: { vendor: "fixture-body" }, proxyUrl: "http://user:fixture-proxy@localhost:8080", auth: { type: "header", header: "X-Auth", prefix: "fixture-prefix" } } } });
  const publicText = JSON.stringify(await store.getPublic());
  for (const secret of ["fixture-old", "fixture-other", "fixture-header", "fixture-body", "fixture-proxy", "fixture-prefix"]) expect(publicText).not.toContain(secret);
  expect(await store.getProviderConfig("relay", "other")).toMatchObject({ baseUrl: "https://responses.test/api", apiKey: "fixture-other", headers: { "X-Private": "fixture-header" } });
  await store.update({ source: { type: "save", source, credentials: [key("default", undefined, false), { ...key("other"), label: "Renamed" }] } });
  expect((await store.getProviderConfig("relay")).apiKey).toBe("fixture-other");
  await expect(store.getProviderConfig("relay", "default")).rejects.toMatchObject({ code: "invalid_input" });
});
it("commits imports atomically and validates route/credential references without leaking secrets", async () => {
  const { root, path } = await fixture(); const store = await openSettingsStore(root);
  await store.update({ sources: [{ type: "save", source: { ...source, id: "local" }, apiKey: "" }, { type: "save", source, credentials: [key("default")] }],
    route: { type: "save", group: { id: "route", label: "Route", strategy: "rotate", members: [{ sourceId: "relay", model: "vendor/a/b", credentialId: "default" }, { sourceId: "local", model: "local/model" }] } } });
  const before = await readFile(path, "utf8");
  await expect(store.update({ sources: [{ type: "save", source: { ...source, id: "new" }, apiKey: "fixture-new" }, { type: "save", source, expectedRevision: 999 }] })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await readFile(path, "utf8")).toBe(before);
  await expect(store.update({ source: { type: "remove", id: "relay" } })).rejects.toThrow("路由仍引用");
  expect(await readFile(path, "utf8")).toBe(before);
  await store.update({ route: { type: "remove", id: "route" }, source: { type: "remove", id: "relay" } });
  expect((await store.getPublic()).providerSources?.map(item => item.id)).toEqual(["local"]);
  expect((await store.getProviderConfig("local")).apiKey).toBe("");
});
it("serializes refresh rotation across store instances and never exposes tokens", async () => {
  const { root } = await fixture(); const first = await openSettingsStore(root); const second = await openSettingsStore(root);
  await first.update({ source: { type: "save", source, credentials: [{ id: "account", label: "Account", type: "account", enabled: true, account: { platform: "codex", accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: Date.now() - 1 } }] } });
  const refresh = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { platform: "codex" as const, accessToken: "fixture-new-access", refreshToken: "fixture-new-refresh", expiresAt: Date.now() + 3600000 }; });
  await Promise.all([first.refreshAccount!("relay", "account", refresh), second.refreshAccount!("relay", "account", refresh)]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect((await first.getProviderConfig("relay", "account")).account?.refreshToken).toBe("fixture-new-refresh");
  expect(JSON.stringify(await first.getPublic())).not.toContain("fixture-");
});
it("rejects malformed or future state without replacing it", async () => {
  for (const value of [{ ...old, version: 99 }, { ...old, sources: [{ ...old.sources[0], revision: -1 }] }]) {
    const { root, path } = await fixture(value);
    await expect(openSettingsStore(root)).rejects.toMatchObject({ code: "storage" });
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(value));
  }
});
it("does not commit a migration if writing its backup fails", async () => {
  const { root, path } = await fixture(); const store = await openSettingsStore(root);
  await mkdir(join(root, "settings/state.v1.backup.json"), { mode: 0o700 });
  await expect(store.update({ source: { type: "save", source, credentials: [key("default")] } })).rejects.toMatchObject({ code: "storage" });
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(old));
});
