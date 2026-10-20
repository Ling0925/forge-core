import { expect, it, vi } from "vitest";
import { providerStateScope, scopeProviderState } from "../../src/provider/state-scope";
import type { Message, ProviderConfig } from "../../src/shared/schemas";
import type { ModelProvider } from "../../src/shared/contracts";

const config: ProviderConfig = { baseUrl: "http://fixture.test/v1", apiMode: "responses", apiKey: "fixture-private-key", requestTimeoutMs: 1000, sourceId: "source", credentialId: "key" };
const message = { role: "assistant" as const, content: "semantic answer", tool_calls: [{ id: "tool", type: "function" as const, function: { name: "read_file", arguments: '{"path":"a"}' } }], providerState: { version: 1 as const, apiMode: "responses" as const, baseUrl: config.baseUrl, model: "model", output: [{ type: "reasoning", encrypted_content: "opaque-fixture" }] } };
const request = { model: "model", signal: new AbortController().signal, onText: () => {} };

it("retains opaque state only for the same identity while preserving tool semantics", async () => {
  const complete = vi.fn<ModelProvider["complete"]>(async () => ({ message }));
  const provider = scopeProviderState({ listModels: async () => [], complete }, config);
  const first = await provider.complete([], [], request);
  expect(first.message.providerState?.credentialScope).toBe(providerStateScope(config));
  await provider.complete([first.message], [], request);
  expect(complete.mock.calls.at(-1)?.[0]).toEqual([first.message]);
  const changed = scopeProviderState({ listModels: async () => [], complete }, { ...config, apiKey: "different-key" });
  await changed.complete([first.message, { role: "tool", tool_call_id: "tool", content: "done" }], [], request);
  expect(complete.mock.calls.at(-1)?.[0]).toEqual([{ role: "assistant", content: "semantic answer", tool_calls: message.tool_calls }, { role: "tool", tool_call_id: "tool", content: "done" }]);
  expect(JSON.stringify(first.message)).not.toContain("fixture-private-key");
});

it("does not trust unscoped legacy state when its credential identity is unknown", async () => {
  const complete = vi.fn<ModelProvider["complete"]>(async () => ({ message: { role: "assistant", content: "OK" } }));
  const provider = scopeProviderState({ listModels: async () => [], complete }, config);
  await provider.complete([message], [], request);
  const sent = complete.mock.calls[0]?.[0] as Message[];
  expect(sent[0]).not.toHaveProperty("providerState");
  expect(sent[0]).toHaveProperty("tool_calls", message.tool_calls);
});

it("scopes identical credential IDs by source, endpoint, protocol and private header", () => {
  const original = providerStateScope(config);
  for (const changed of [{ sourceId: "other" }, { credentialId: "other" }, { baseUrl: "http://other.test/v1" }, { apiMode: "anthropic" as const }, { headers: { Authorization: "private-other" } }]) expect(providerStateScope({ ...config, ...changed })).not.toBe(original);
  expect(providerStateScope({ ...config, headers: { "X-A": "a", "X-B": "b" } })).toBe(providerStateScope({ ...config, headers: { "x-b": "b", "x-a": "a" } }));
});

it("keeps refreshed tokens for a known account principal but separates other accounts", () => {
  const account = { platform: "codex" as const, accessToken: "one", accountId: "tenant-one" };
  const original = providerStateScope({ ...config, account });
  expect(providerStateScope({ ...config, apiKey: "two", account: { ...account, accessToken: "two" } })).toBe(original);
  expect(providerStateScope({ ...config, account: { ...account, accountId: "tenant-two" } })).not.toBe(original);
});
