import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ModelProvider } from "../../src/shared/contracts";
const context = vi.hoisted(() => ({ calls: 0, failAt: 1, disposed: 0 }));
vi.mock("../../src/context/index", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/context/index")>();
  return {
    ...original,
    createProjectContext: async (
      ...args: Parameters<typeof original.createProjectContext>
    ) => {
      const service = await original.createProjectContext(...args);
      const index = ++context.calls;
      return {
        ...service,
        refresh: async () => {
          if (index === context.failAt) throw Error("refresh failure");
          await service.refresh();
        },
        dispose: async () => {
          context.disposed++;
          await service.dispose();
        },
      };
    },
  };
});
import { createHarness } from "../../src/core/harness";
for (const failAt of [1, 2])
  it(`disposes partial tool/context ownership when ${failAt === 1 ? "root" : "child"} context refresh fails`, async () => {
    context.calls = 0;
    context.disposed = 0;
    context.failAt = failAt;
    const dir = await mkdtemp(join(tmpdir(), "forge-construction-"));
    await mkdir(join(dir, "workspace"));
    let created = 0;
    let disposed = 0;
    let turns = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async () => ({
        message:
          ++turns === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "spawn",
                    type: "function",
                    function: {
                      name: "spawn_agent",
                      arguments: JSON.stringify({ task: "child" }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "done" },
      }),
    };
    const h = await createHarness({
      stateDir: join(dir, "state"),
      providerFactory: () => provider,
      toolFactory: async () => {
        created++;
        return {
          definitions: [],
          execute: async () => ({ content: "", isError: false }),
          dispose: async () => {
            disposed++;
          },
        };
      },
    });
    try {
      await h.updateSettings({
        settings: { baseUrl: "http://localhost:1234/v1", model: "root" },
      });
      const session = await h.createSession({
        workspace: join(dir, "workspace"),
      });
      const work = h.run(
        { sessionId: session.id, prompt: "work" },
        () => {},
        async () => false,
        new AbortController().signal,
      );
      if (failAt === 1) await expect(work).rejects.toThrow("refresh failure");
      else {
        expect((await work).status).toBe("failed");
        const children = (await h.listSessions()).filter(
          (s) => s.parentSessionId === session.id,
        );
        expect(children).toHaveLength(1);
        expect(children[0]?.status).toBe("failed");
      }
      expect(created).toBe(failAt);
      expect(disposed).toBe(created);
      expect(context.disposed).toBe(created);
      expect(await h.cancelSession(session.id)).toBe(false);
    } finally {
      await h.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
