import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
import { providerStateSchema } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
it("persists exact assistant continuation and forks child security provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-state-"));
  await mkdir(join(dir, "workspace"));
  const state = providerStateSchema.parse({
    version: 1,
    apiMode: "responses",
    baseUrl: "http://localhost:1234/v1",
    model: "actual",
    output: [
      { type: "reasoning", id: "r1", encrypted_content: "opaque" },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    ],
  });
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "done", providerState: state },
    }),
  };
  const service = await createHarness({
    stateDir: join(dir, "state"),
    providerFactory: (config) => {
      expect(config.apiMode).toBe("responses");
      return provider;
    },
  });
  try {
    await service.updateSettings({
      settings: {
        baseUrl: state.baseUrl,
        model: "actual",
        apiMode: "responses",
      },
    });
    const root = await service.createSession({
      workspace: join(dir, "workspace"),
    });
    const result = await service.run(
      { sessionId: root.id, prompt: "work" },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: "done",
      providerState: state,
    });
    const store = await openSessionStore(join(dir, "state"));
    await store.save({
      ...result,
      parentSessionId: root.id,
      permissionCeiling: "readonly",
      agentTask: "inspect",
      ownership: "src",
    });
    const fork = await service.forkSession(root.id);
    expect(fork.permissionCeiling).toBe("readonly");
    expect(fork.parentSessionId).toBe(root.id);
    expect(fork.agentTask).toBe("inspect");
    expect(fork.messages.at(-1)).toEqual(result.messages.at(-1));
    expect((await service.getSession(fork.id)).messages.at(-1)).toEqual(
      result.messages.at(-1),
    );
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
it("manual compact abort releases lock without waiting for uncooperative provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-summary-abort-"));
  let started = () => {};
  const entered = new Promise<void>((r) => {
    started = r;
  });
  let release = () => {};
  const deferred = new Promise<never>((_r, reject) => {
    release = () => reject(Error("cleanup"));
  });
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async () => {
      started();
      return deferred;
    },
  };
  await mkdir(join(dir, "workspace"));
  const service = await createHarness({
    stateDir: join(dir, "state"),
    providerFactory: () => provider,
  });
  try {
    await service.updateSettings({
      settings: { baseUrl: "http://localhost:1234/v1", model: "actual" },
    });
    const root = await service.createSession({
      workspace: join(dir, "workspace"),
    });
    const controller = new AbortController();
    const work = service.compactSession(root.id, controller.signal);
    await entered;
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "cancelled" });
    expect((await service.renameSession(root.id, "released")).title).toBe(
      "released",
    );
    expect((await service.getSession(root.id)).contextSummary).toBeUndefined();
  } finally {
    release();
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
