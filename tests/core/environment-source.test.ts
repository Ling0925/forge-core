import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createRuntimeHub } from "../../src/host/runtime";
import { rpcRequestSchema } from "../../src/shared/ipc";
import { sessionSnapshotSchema } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";

// FORGE_* overrides win over the stored active source for every path that
// names no source (settings store, listModels, createSession, run, queue and
// compaction); an explicitly pinned source keeps its own endpoint.
afterEach(() => {
  vi.unstubAllEnvs();
});

it("uses the environment provider instead of the stored active source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-env-source-"));
  const seen: string[] = [];
  const summary = JSON.stringify({
    goal: "continue",
    constraints: [],
    decisions: [],
    completed: [],
    nextSteps: [],
    verification: [],
    uncertainties: [],
  });
  for (const name of ["FORGE_BASE_URL", "FORGE_API_KEY", "FORGE_MODEL"])
    vi.stubEnv(name, undefined);
  const service = await createHarness({
    stateDir: join(directory, "state"),
    providerFactory: (config) => ({
      listModels: async () => [],
      complete: async (messages) => {
        seen.push(config.baseUrl);
        const system = String(messages[0]?.content ?? "");
        return {
          message: {
            role: "assistant",
            content: system.startsWith("Summarize") ? summary : "done",
          },
        };
      },
    }),
    toolFactory: () => ({
      definitions: [],
      execute: async () => ({ content: "unused", isError: false }),
      dispose: async () => {},
    }),
  });
  const hub = createRuntimeHub(service);
  const rpc = (method: string, fields: object) =>
    hub.request(
      rpcRequestSchema.parse({ id: randomUUID(), method, ...fields }),
    );
  try {
    await service.updateSettings({
      source: {
        type: "save",
        source: {
          id: "stored",
          label: "Stored",
          baseUrl: "https://stored.invalid/v1",
          model: "stored-model",
        },
        apiKey: "fixture-stored",
      },
    });
    expect((await service.getSettings()).activeSourceId).toBe("stored");
    const pinned = await service.createSession({
      workspace: directory,
      title: "Pinned before the override",
    });
    expect(pinned.providerSourceId).toBe("stored");
    vi.stubEnv("FORGE_BASE_URL", "https://env.invalid/v1");
    vi.stubEnv("FORGE_MODEL", "env-model");
    vi.stubEnv("FORGE_API_KEY", "fixture-env");

    const session = await service.createSession({
      workspace: directory,
      title: "Environment session",
    });
    expect(session.providerSourceId).toBeUndefined();
    const run = (sessionId: typeof session.id) =>
      service.run(
        { sessionId, prompt: "go", permission: "readonly" },
        () => {},
        async () => false,
        new AbortController().signal,
      );
    seen.length = 0;
    await run(session.id);
    expect(seen).toEqual(["https://env.invalid/v1"]);
    expect((await service.getSession(session.id)).providerSourceId).toBe(
      undefined,
    );

    seen.length = 0;
    expect(
      await rpc("enqueueInput", {
        input: {
          inputId: randomUUID(),
          input: {
            sessionId: session.id,
            prompt: "queued",
            permission: "readonly",
          },
        },
      }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(async () => {
      expect(await rpc("listInputs", { sessionId: session.id })).toMatchObject({
        ok: true,
        result: { items: [{ state: "consumed", outcome: "completed" }] },
      });
    });
    expect(seen).toEqual(["https://env.invalid/v1"]);

    seen.length = 0;
    const store = await openSessionStore(join(directory, "state"));
    const current = await service.getSession(session.id);
    await store.save(
      sessionSnapshotSchema.parse({
        ...current,
        messages: [
          { role: "system", content: "system instructions" },
          { role: "user", content: "archived evidence ".repeat(10000) },
          { role: "assistant", content: "done" },
        ],
      }),
    );
    expect(
      (await service.compactSession(session.id)).contextSummary?.fallback,
    ).toBe(false);
    expect(seen).toEqual(["https://env.invalid/v1"]);

    // A session pinned to a source keeps it; the override is a fallback.
    seen.length = 0;
    await run(pinned.id);
    expect(seen).toEqual(["https://stored.invalid/v1"]);
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
