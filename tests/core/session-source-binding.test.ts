import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { HarnessService } from "../../src/shared/contracts";
import { openSessionStore } from "../../src/store/sessions";

let directory = "";
let service: HarnessService;
const requests: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string | null;
}[] = [];
beforeEach(async () => {
  for (const name of ["FORGE_BASE_URL", "FORGE_API_KEY", "FORGE_MODEL"])
    vi.stubEnv(name, undefined);
  requests.length = 0;
  directory = await mkdtemp(join(tmpdir(), "forge-bound-source-"));
  service = await createHarness({
    stateDir: directory,
    providerFactory: (config) => ({
      listModels: async () => [],
      complete: async (messages, _tools, options) => {
        requests.push({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: options.model,
          prompt:
            messages.findLast((message) => message.role === "user")?.content ??
            null,
        });
        if (messages.at(-1)?.content === "spawn-bound-child")
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "spawn-child",
                  type: "function",
                  function: {
                    name: "spawn_agent",
                    arguments: JSON.stringify({
                      task: "child task",
                      model: "child-fixture",
                    }),
                  },
                },
              ],
            },
          };
        return { message: { role: "assistant", content: "done" } };
      },
    }),
    toolFactory: () => ({
      definitions: [],
      execute: async () => ({ content: "unused", isError: true }),
      dispose: async () => {},
    }),
  });
  for (const id of ["a", "b"])
    await service.updateSettings({
      source: {
        type: "save",
        source: {
          id,
          label: id,
          baseUrl: `https://${id}.invalid/v1`,
          model: `${id}-model`,
          apiMode: "chat-completions",
        },
        apiKey: `fixture-${id}`,
      },
    });
});
afterEach(async () => {
  await service?.dispose();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const run = (id: Parameters<HarnessService["getSession"]>[0], prompt: string) =>
  service.run(
    { sessionId: id, prompt, permission: "readonly" },
    () => {},
    async () => false,
    new AbortController().signal,
  );

it("keeps the source and credentials across global source switches, forks and explicit overrides", async () => {
  const session = await service.createSession({
    workspace: directory,
    title: "explicit",
  });
  expect(session.providerSourceId).toBe("a");
  await service.updateSettings({ source: { type: "activate", id: "b" } });
  await run(session.id, "original source");
  expect(requests.at(-1)).toMatchObject({
    baseUrl: "https://a.invalid/v1",
    apiKey: "fixture-a",
    model: "a-model",
  });
  const fork = await service.forkSession(session.id);
  expect(fork.providerSourceId).toBe("a");
  await run(fork.id, "fork source");
  expect(
    requests.find((request) => request.prompt === "fork source")?.baseUrl,
  ).toBe("https://a.invalid/v1");
  const selected = await service.createSession({
    workspace: directory,
    title: "selected",
    providerSourceId: "a",
  });
  expect(selected.model).toBe("a-model");
  const changed = await service.run(
    {
      sessionId: selected.id,
      prompt: "explicit change",
      providerSourceId: "b",
      model: "b-model",
    },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(changed.providerSourceId).toBe("b");
  expect(
    requests.find((request) => request.prompt === "explicit change"),
  ).toMatchObject({ baseUrl: "https://b.invalid/v1", apiKey: "fixture-b" });
});

it("binds legacy sessions once and fails rather than falling back when their source is removed", async () => {
  const store = await openSessionStore(directory);
  const old = await store.create({
    workspace: directory,
    title: "legacy",
    model: "a-model",
  });
  expect((await run(old.id, "first legacy run")).providerSourceId).toBe("a");
  await service.updateSettings({ source: { type: "activate", id: "b" } });
  await service.updateSettings({ source: { type: "remove", id: "a" } });
  const count = requests.length;
  await expect(run(old.id, "must not reach b")).rejects.toBeDefined();
  expect(requests.length).toBe(count);
  expect((await store.get(old.id)).providerSourceId).toBe("a");
  await expect(
    service.createSession({
      workspace: directory,
      providerSourceId: "missing",
    }),
  ).rejects.toBeDefined();
});
it("inherits the pinned source into independently persisted child sessions", async () => {
  const parent = await service.createSession({
    workspace: directory,
    title: "parent",
  });
  await service.updateSettings({ source: { type: "activate", id: "b" } });
  const result = await run(parent.id, "spawn-bound-child");
  expect(result.status).toBe("completed");
  const child = (await service.listSessions()).find(
    (item) => item.parentSessionId === parent.id,
  );
  expect(child?.providerSourceId).toBe("a");
  expect(
    requests.find((request) => request.model === "child-fixture"),
  ).toMatchObject({ baseUrl: "https://a.invalid/v1", apiKey: "fixture-a" });
});
