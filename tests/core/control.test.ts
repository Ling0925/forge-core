import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
const barrier = () => {
  let release = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
};
const empty = {
  definitions: [],
  execute: async () => ({ content: "", isError: false }),
  dispose: async () => {},
};
it("targets child without cancelling sibling, then root stop joins remaining work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-control-"));
  await mkdir(join(dir, "workspace"));
  const a = barrier();
  const b = barrier();
  let turns = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (_m, _t, o) => {
      if (o.model !== "root") {
        (o.model === "a" ? a : b).release();
        return new Promise(() => {});
      }
      return {
        message:
          ++turns === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: ["a", "b"].map((model) => ({
                  id: model,
                  type: "function" as const,
                  function: {
                    name: "spawn_agent",
                    arguments: JSON.stringify({ task: model, model }),
                  },
                })),
              }
            : { role: "assistant", content: "final" },
      };
    },
  };
  let disposedTools = 0;
  let createdTools = 0;
  const harness = await createHarness({
    stateDir: join(dir, "state"),
    providerFactory: () => provider,
    toolFactory: async () => {
      createdTools++;
      return {
        ...empty,
        dispose: async () => {
          disposedTools++;
        },
      };
    },
  });
  const external = await createHarness({
    stateDir: join(dir, "state"),
    providerFactory: () => provider,
    toolFactory: async () => empty,
  });
  try {
    await harness.updateSettings({
      settings: { baseUrl: "http://localhost:1234/v1", model: "root" },
    });
    const root = await harness.createSession({
      workspace: join(dir, "workspace"),
    });
    const work = harness.run(
      { sessionId: root.id, prompt: "delegate" },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    await Promise.all([a.promise, b.promise]);
    const children = (await harness.listSessions()).filter(
      (s) => s.parentSessionId === root.id,
    );
    const childA = children.find((c) => c.model === "a");
    const childB = children.find((c) => c.model === "b");
    if (!childA || !childB) throw Error("Missing children");
    expect(await external.cancelSession(root.id)).toBe(false);
    expect(await harness.cancelSession(childA.id)).toBe(true);
    expect(createdTools).toBe(3);
    expect(disposedTools).toBe(1);
    expect((await harness.getSession(childA.id)).status).toBe("cancelled");
    expect((await harness.getSession(childB.id)).status).toBe("running");
    expect(await harness.cancelSession(root.id)).toBe(true);
    expect((await work).status).toBe("cancelled");
    expect(disposedTools).toBe(3);
    expect((await harness.getSession(childB.id)).status).toBe("cancelled");
    expect(await harness.cancelSession(root.id)).toBe(false);
  } finally {
    await harness.dispose();
    await external.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
it("cancelSession aborts manual compaction and releases lock without provider cooperation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-compact-control-"));
  await mkdir(join(dir, "workspace"));
  const entered = barrier();
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async () => {
      entered.release();
      return new Promise(() => {});
    },
  };
  const h = await createHarness({
    stateDir: join(dir, "state"),
    providerFactory: () => provider,
  });
  try {
    await h.updateSettings({
      settings: { baseUrl: "http://localhost:1234/v1", model: "root" },
    });
    const session = await h.createSession({
      workspace: join(dir, "workspace"),
    });
    const work = h.compactSession(session.id);
    const rejected = expect(work).rejects.toMatchObject({ code: "cancelled" });
    await entered.promise;
    expect(await h.cancelSession(session.id)).toBe(true);
    await rejected;
    expect((await h.renameSession(session.id, "released")).status).toBe("idle");
    expect(await h.cancelSession(session.id)).toBe(false);
  } finally {
    await h.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
it("projects current AGENTS context while retaining historical first system message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-context-refresh-"));
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "AGENTS.md"), "FIRST_CONVENTION");
  const seen: string[] = [];
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages) => {
      seen.push(messages[0]?.content ?? "");
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const h = await createHarness({
    stateDir: join(dir, "state"),
    providerFactory: () => provider,
    toolFactory: async () => empty,
  });
  try {
    await h.updateSettings({
      settings: { baseUrl: "http://localhost:1234/v1", model: "root" },
    });
    const session = await h.createSession({ workspace });
    await h.run(
      { sessionId: session.id, prompt: "first" },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    const historical = (await h.getSession(session.id)).messages[0];
    await writeFile(join(workspace, "AGENTS.md"), "SECOND_CONVENTION");
    await h.run(
      { sessionId: session.id, prompt: "second" },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(seen[0]).toContain("FIRST_CONVENTION");
    expect(seen[1]).toContain("SECOND_CONVENTION");
    expect(seen[1]).not.toContain("FIRST_CONVENTION");
    expect((await h.getSession(session.id)).messages[0]).toEqual(historical);
  } finally {
    await h.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
