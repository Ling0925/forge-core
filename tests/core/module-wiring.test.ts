import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
import { openSessionStore } from "../../src/store/sessions";
it("injects instructions and lazy skills and restores selected checkpoint under exclusion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-wiring-"));
  const workspace = join(dir, "workspace");
  await mkdir(join(workspace, ".forge", "skills", "sample"), {
    recursive: true,
  });
  await writeFile(
    join(workspace, "AGENTS.md"),
    "Project convention: verify modifications.",
  );
  await writeFile(
    join(workspace, ".forge", "skills", "sample", "SKILL.md"),
    "---\nname: sample\ndescription: example skill\n---\nLAZY_SKILL_BODY_ONLY",
  );
  await writeFile(join(workspace, "file.txt"), "before");
  let turns = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages, tools) => {
      expect(messages[0]?.content).toContain("Project convention");
      expect(messages[0]?.content).not.toContain("LAZY_SKILL_BODY_ONLY");
      expect(tools.map((t) => t.function.name)).toEqual(
        expect.arrayContaining([
          "load_skill",
          "project_context",
          "mcp_list_tools",
          "mcp_call_tool",
          "update_plan",
        ]),
      );
      return {
        message:
          ++turns === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "edit",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: JSON.stringify({
                        path: "file.txt",
                        content: "after",
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "verified" },
      };
    },
  };
  const service = await createHarness({
    stateDir: join(dir, "state"),
    providerFactory: () => provider,
  });
  try {
    await service.updateSettings({
      settings: { baseUrl: "http://localhost:1234/v1", model: "test" },
    });
    const session = await service.createSession({ workspace });
    const result = await service.run(
      { sessionId: session.id, prompt: "edit", permission: "unrestricted" },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("after");
    const checkpoints = await service.listCheckpoints(session.id);
    expect(checkpoints).toHaveLength(1);
    const checkpoint = checkpoints[0];
    if (!checkpoint) throw Error("Missing checkpoint");
    expect(
      await service.getCheckpointDiff(session.id, checkpoint.id),
    ).toContain("before");
    const store = await openSessionStore(join(dir, "state"));
    const release = await store.acquire(session.id);
    await expect(
      service.restoreCheckpoint(session.id, checkpoint.id),
    ).rejects.toMatchObject({ code: "busy" });
    await release();
    await service.restoreCheckpoint(session.id, checkpoint.id);
    expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("before");
    const catalog = await service.getProjectContext(session.id);
    expect(JSON.stringify(catalog)).toContain("sample");
    expect(JSON.stringify(catalog)).not.toContain("LAZY_SKILL_BODY_ONLY");
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
