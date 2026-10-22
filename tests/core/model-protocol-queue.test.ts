import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createRuntimeHub } from "../../src/desktop/runtime";
import { rpcRequestSchema } from "../../src/shared/ipc";
import type { ProviderConfig, ProviderSource } from "../../src/shared/schemas";

it.each([false, true])("binds queued model protocols and blocks later protocol changes (route=%s)", async routed => {
  const home = await mkdtemp(join(tmpdir(), "forge-model-protocol-queue-"));
  const seen: { config: ProviderConfig; model: string }[] = [];
  const service = await createHarness({
    stateDir: home,
    providerFactory: config => ({
      ...(config.apiMode ? { apiMode: config.apiMode } : {}),
      listModels: async () => ["chat-model", "wire"],
      complete: async (_messages, _tools, request) => {
        seen.push({ config, model: request.model });
        return { message: { role: "assistant", content: "OK" } };
      },
    }),
    toolFactory: () => ({ definitions: [], execute: async () => ({ content: "unused", isError: false }), dispose: async () => {} }),
  });
  const runtime = createRuntimeHub(service);
  const rpc = (method: string, fields: object) => runtime.request(rpcRequestSchema.parse({ id: randomUUID(), method, ...fields }));
  const source: ProviderSource = {
    id: "relay", label: "Relay", baseUrl: "https://relay.invalid/v1", model: "chat-model", apiMode: "chat-completions",
    endpoints: { responses: "https://relay.invalid/responses-v1", anthropic: "https://relay.invalid/messages-v1" },
    modelAliases: { alias: "wire" },
    modelSelection: { mode: "all", overrides: { wire: { apiMode: "responses" } } },
  };
  try {
    await service.updateSettings({ source: { type: "save", source, apiKey: "fixture-only" } });
    if (routed) await service.updateSettings({ route: { type: "save", group: {
      id: "pool", label: "Pool", strategy: "order", members: [{ sourceId: "relay", model: "alias" }],
    } } });
    const session = await service.createSession({ workspace: home, title: "Protocol queue regression",
      ...(routed ? { routeGroupId: "pool" } : { providerSourceId: "relay", model: "alias" }),
    });
    expect(await rpc("enqueueInput", { input: { inputId: randomUUID(), input: { sessionId: session.id, prompt: "one", permission: "readonly" } } })).toMatchObject({ ok: true });
    await vi.waitFor(async () => {
      expect(await rpc("listInputs", { sessionId: session.id })).toMatchObject({ ok: true, result: { items: [{ state: "consumed", outcome: "completed" }] } });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: "wire", config: { apiMode: "responses", baseUrl: source.endpoints!.responses } });
    expect((await service.getSession(session.id)).events.filter(event => event.type === "provider_attempt"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ selection: expect.objectContaining({ apiMode: "responses" }) })]));

    // A queued input must not silently use a protocol/endpoint changed after
    // admission. This checks route-member hashes as well as direct bindings.
    await rpc("pauseInputs", { sessionId: session.id });
    expect(await rpc("enqueueInput", { input: { inputId: randomUUID(), input: { sessionId: session.id, prompt: "two", permission: "readonly" } } })).toMatchObject({ ok: true });
    await service.updateSettings({ source: { type: "save", source: {
      ...source, modelSelection: { mode: "all", overrides: { wire: { apiMode: "anthropic" } } },
    } } });
    await rpc("resumeInputs", { sessionId: session.id });
    await vi.waitFor(async () => {
      expect(await rpc("listInputs", { sessionId: session.id })).toMatchObject({ ok: true, result: {
        paused: true, items: [{ state: "consumed" }, { state: "blocked" }],
      } });
    });
    expect(seen).toHaveLength(1);
  } finally {
    await runtime.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
