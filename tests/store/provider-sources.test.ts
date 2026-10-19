import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { openSettingsStore } from "../../src/store/settings";
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const fixture = async () => { const dir = await mkdtemp(join(tmpdir(), 'forge-source-store-')); dirs.push(dir); return dir; };
const source = (id: string) => ({ id, label: id.toUpperCase(), baseUrl: `https://${id}.test/v1`, model: `${id}/model`, apiMode: 'chat-completions' as const });
it('persists Anthropic protocol and output limits through source activation and reopen', async () => {
  const dir = await fixture();
  const store = await openSettingsStore(dir);
  await store.update({ settings: { maxOutputTokens: 4096 } });
  await store.update({ source: { type: 'save', source: { ...source('claude'), apiMode: 'anthropic' }, apiKey: 'fixture-claude' } });
  const reopened = await openSettingsStore(dir);
  expect(await reopened.getProviderConfig()).toMatchObject({ apiMode: 'anthropic', maxOutputTokens: 4096 });
  expect(await reopened.getProviderConfig('claude')).toMatchObject({ apiMode: 'anthropic', maxOutputTokens: 4096 });
  expect(JSON.stringify(await reopened.getPublic())).not.toContain('fixture-claude');
});
it('migrates legacy transaction without exposing keys and preserves source on reopen', async () => {
  const dir = await fixture(); await mkdir(join(dir, 'settings'), { mode: 0o700 });
  await writeFile(join(dir, 'settings/state.json'), JSON.stringify({ version: 1, settings: { baseUrl: 'https://old.test/v1', model: 'old/model', apiMode: 'responses' }, apiKey: 'fixture-old' }), { mode: 0o600 });
  const store = await openSettingsStore(dir);
  expect((await store.getPublic()).providerSources).toEqual([{ id: 'default', label: 'Default', baseUrl: 'https://old.test/v1', model: 'old/model', apiMode: 'responses', revision: 1, hasApiKey: true }]);
  expect(await store.getProviderConfig('default')).toMatchObject({ apiKey: 'fixture-old', apiMode: 'responses' });
  const again = await openSettingsStore(dir);
  expect((await again.getPublic()).activeSourceId).toBe('default');
  expect(JSON.stringify(await again.getPublic())).not.toContain('fixture-old');
});
it('isolates save/activation/keys, rejects mixed operations and protects endpoint changes', async () => {
  const store = await openSettingsStore(await fixture());
  await store.update({ source: { type: 'save', source: source('a'), apiKey: 'fixture-a' } });
  await store.update({ source: { type: 'save', source: source('b'), apiKey: 'fixture-b' } });
  expect((await store.getPublic()).activeSourceId).toBe('a');
  await store.update({ source: { type: 'save', source: { ...source('b'), label: 'Changed' } } });
  expect((await store.getProviderConfig('b')).apiKey).toBe('fixture-b');
  await expect(store.update({ source: { type: 'save', source: { ...source('b'), baseUrl: 'https://other.test/v1' } } })).rejects.toThrow('重新提供新地址的密钥');
  await expect(store.update({ source: { type: 'activate', id: 'b' }, settings: { theme: 'dark' } })).rejects.toThrow('不能与普通设置或密钥更新同时提交');
  await store.update({ source: { type: 'activate', id: 'b' } });
  expect(await store.getProviderConfig()).toMatchObject({ baseUrl: source('b').baseUrl, apiKey: 'fixture-b' });
  // Removing the fallback source is allowed: the fallback moves to the survivor
  // so no manual "switch source first" step is required.
  await store.update({ source: { type: 'remove', id: 'b' } });
  expect((await store.getPublic()).activeSourceId).toBe('a');
  expect(await store.getProviderConfig()).toMatchObject({ baseUrl: source('a').baseUrl, apiKey: 'fixture-a' });
  await store.update({ source: { type: 'save', source: source('b'), apiKey: '' } });
  expect((await store.getProviderConfig('b')).apiKey).toBe('');
  expect((await store.getProviderConfig()).apiKey).toBe('fixture-a');
  await store.update({ source: { type: 'remove', id: 'a' } });
  await expect(store.getProviderConfig('a')).rejects.toThrow('未找到该模型来源');
  // Removing the fallback hands it to the survivor rather than leaving a gap.
  expect((await store.getPublic()).activeSourceId).toBe('b');
  await store.update({ source: { type: 'remove', id: 'b' } });
  // With no source left the legacy pair is cleared instead of staying usable.
  const empty = await store.getPublic();
  expect(empty.activeSourceId).toBeUndefined();
  expect(empty.providerSources).toEqual([]);
  expect(empty.baseUrl).toBe('');
  await expect(store.getProviderConfig()).rejects.toBeDefined();
});
it('keeps legacy CLI updates in sync and serializes independent store writers', async () => {
  const dir = await fixture(); const one = await openSettingsStore(dir); const two = await openSettingsStore(dir);
  await one.update({ settings: { baseUrl: 'https://old.test/v1', model: 'legacy' }, apiKey: 'fixture-legacy' });
  expect((await one.getPublic()).activeSourceId).toBe('default');
  await Promise.all([
    one.update({ source: { type: 'save', source: source('a'), apiKey: 'fixture-a' } }),
    two.update({ source: { type: 'save', source: source('b'), apiKey: 'fixture-b' } }),
  ]);
  expect((await one.getPublic()).providerSources).toHaveLength(3);
  await two.update({ settings: { model: 'new-model' } });
  expect((await one.getPublic()).providerSources?.find(s => s.id === 'default')?.model).toBe('new-model');
  expect((await one.getProviderConfig()).apiKey).toBe('fixture-legacy');
  const projection = await readFile(join(dir, 'settings/config.json'), 'utf8');
  expect(projection).not.toContain('fixture-');
});
it('retains environment precedence but explicit sources never mix environment credentials', async () => {
  const store = await openSettingsStore(await fixture());
  await store.update({ source: { type: 'save', source: source('a'), apiKey: 'fixture-a' } });
  vi.stubEnv('FORGE_BASE_URL', 'https://env.test/v1'); vi.stubEnv('FORGE_API_KEY', 'fixture-env'); vi.stubEnv('FORGE_MODEL', 'env/model');
  expect(await store.getPublic()).toMatchObject({ environmentOverride: true, baseUrl: 'https://env.test/v1', model: 'env/model' });
  expect(await store.getProviderConfig()).toMatchObject({ apiKey: 'fixture-env', baseUrl: 'https://env.test/v1' });
  expect(await store.getProviderConfig('a')).toMatchObject({ apiKey: 'fixture-a', baseUrl: source('a').baseUrl });
});
it('rejects a stale revision instead of overwriting a concurrent source edit', async () => {
  const dir = await fixture();
  const one = await openSettingsStore(dir);
  const two = await openSettingsStore(dir);
  await one.update({ source: { type: 'save', source: source('a'), apiKey: 'fixture-a' } });
  const seen = (await one.getPublic()).providerSources?.[0]!.revision;
  expect(seen).toBe(1);
  await two.update({
    source: { type: 'save', source: { ...source('a'), label: 'FROM TWO' }, expectedRevision: seen },
  });
  await expect(
    one.update({
      source: { type: 'save', source: { ...source('a'), label: 'FROM ONE' }, expectedRevision: seen },
    }),
  ).rejects.toThrow('已被其他窗口或 CLI 修改');
  expect((await one.getPublic()).providerSources?.[0]).toMatchObject({ label: 'FROM TWO', revision: 2 });
});
it('refuses to remove a source that sessions still reference until they are acknowledged', async () => {
  const dir = await fixture();
  let pinned: string[] = [];
  const store = await openSettingsStore(dir, { referencedSessions: async () => pinned });
  await store.update({ source: { type: 'save', source: source('a'), apiKey: 'fixture-a' } });
  await store.update({ source: { type: 'save', source: source('b'), apiKey: 'fixture-b' } });
  await store.update({ source: { type: 'activate', id: 'b' } });
  pinned = ['sess-1', 'sess-2'];
  await expect(store.update({ source: { type: 'remove', id: 'a' } })).rejects.toThrow('仍有 2 个会话绑定此来源');
  expect((await store.getPublic()).providerSources).toHaveLength(2);
  await expect(
    store.update({ source: { type: 'remove', id: 'a', forgottenSessionIds: ['sess-1'] } }),
  ).rejects.toThrow('sess-2');
  await store.update({
    source: { type: 'remove', id: 'a', forgottenSessionIds: ['sess-1', 'sess-2'] },
  });
  expect((await store.getPublic()).providerSources?.map(item => item.id)).toEqual(['b']);
});
