import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { openSettingsStore } from "../../src/store/settings";

/**
 * Choosing a model already identifies the provider source that serves it, so a
 * user must never have to "activate" a source by hand. These cover the store
 * fallback and the harness inference that make that true end to end.
 */
const directories: string[] = [];
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-source-follow-"));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("keeps the remembered source usable and hands it on when removed", async () => {
  const store = await openSettingsStore(await fixture());
  const source = (id: string, model: string) => ({
    id,
    label: id.toUpperCase(),
    baseUrl: `https://${id}.test/v1`,
    model,
    apiMode: "chat-completions" as const,
  });
  await store.update({
    source: { type: "save", source: source("a", "a/model") },
  });
  // The first saved source becomes the fallback without a separate activation.
  expect((await store.getPublic()).activeSourceId).toBe("a");
  await store.update({
    source: { type: "save", source: source("b", "b/model") },
  });
  expect((await store.getPublic()).activeSourceId).toBe("a");
  // Remembering a different source needs no default model gate any more.
  await store.update({
    source: { type: "save", source: { ...source("b", ""), model: "" } },
  });
  await store.update({ source: { type: "activate", id: "b" } });
  expect((await store.getPublic()).activeSourceId).toBe("b");
  await store.update({ source: { type: "remove", id: "b" } });
  expect((await store.getPublic()).activeSourceId).toBe("a");
  expect(await store.getProviderConfig()).toMatchObject({
    baseUrl: "https://a.test/v1",
  });
});

it("infers the picker's source from the model and remembers it for the next run", async () => {
  const directory = await fixture();
  const seen: { model: string; baseUrl: string }[] = [];
  const service = await createHarness({
    stateDir: directory,
    providerFactory: (config) => ({
      listModels: async () => [],
      complete: async (_messages, _tools, options) => {
        seen.push({ model: options.model, baseUrl: config.baseUrl });
        return { message: { role: "assistant", content: "done" } };
      },
    }),
    toolFactory: () => ({
      definitions: [],
      execute: async () => ({ content: "unused", isError: true }),
      dispose: async () => {},
    }),
  });
  try {
    for (const [id, model] of [
      ["a", "a-model"],
      ["b", "b-model"],
    ] as const)
      await service.updateSettings({
        source: {
          type: "save",
          source: {
            id,
            label: id,
            baseUrl: `https://${id}.invalid/v1`,
            model,
            apiMode: "chat-completions",
          },
          apiKey: `fixture-${id}`,
        },
      });
    const first = await service.createSession({ workspace: directory });
    expect(first.providerSourceId).toBe("a");

    // A session keeps its pinned source when only a model is supplied: the
    // renderer always sends the picked model's source with it.
    const kept = await service.run(
      { sessionId: first.id, prompt: "stay on a", model: "b-model" },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(kept.providerSourceId).toBe("a");
    expect(seen.at(-1)).toEqual({
      model: "b-model",
      baseUrl: "https://a.invalid/v1",
    });

    // The renderer's actual call shape: model and its source travel together.
    const moved = await service.run(
      {
        sessionId: first.id,
        prompt: "switch by model",
        model: "b-model",
        providerSourceId: "b",
      },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(moved.providerSourceId).toBe("b");
    expect(seen.at(-1)).toEqual({
      model: "b-model",
      baseUrl: "https://b.invalid/v1",
    });
    // Remembering the fallback means the next new session starts on B as well.
    expect((await service.getSettings()).activeSourceId).toBe("b");
    expect(
      (await service.createSession({ workspace: directory })).providerSourceId,
    ).toBe("b");

    // A new session also pins the model's own source, without an explicit id.
    expect(
      (await service.createSession({ workspace: directory, model: "a-model" }))
        .providerSourceId,
    ).toBe("a");
  } finally {
    await service.dispose();
  }
});
