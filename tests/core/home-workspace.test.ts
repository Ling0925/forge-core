import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProjectContext } from "../../src/context/project-context";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createCheckpointStore } from "../../src/store/checkpoints";
import { createLocalToolRegistry } from "../../src/tools/local";
import { createWorkspacePathGuard } from "../../src/tools/path-guard";

it("runs readonly without tools when a home-shaped workspace contains managed state, then edits and restores", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-home-regression-"));
  const state = join(home, ".local", "share", "forge");
  let editing = false;
  let turns = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async () => ({
      message:
        editing && ++turns <= 2
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: turns === 1 ? "read" : "edit",
                  type: "function",
                  function: turns === 1
                    ? { name: "read_file", arguments: JSON.stringify({ path: "ordinary.txt" }) }
                    : {
                        name: "edit_file",
                        arguments: JSON.stringify({
                          path: "ordinary.txt",
                          old_text: "before",
                          new_text: "after",
                        }),
                      },
                },
              ],
            }
          : { role: "assistant", content: "READY" },
    }),
  };
  const service = await createHarness({
    stateDir: state,
    providerFactory: () => provider,
  });
  try {
    await service.updateSettings({
      settings: { baseUrl: "http://localhost:1234/v1", model: "fixture" },
    });
    await writeFile(join(home, "ordinary.txt"), "before");
    const session = await service.createSession({ workspace: home });
    const run = (permission: "readonly" | "unrestricted") =>
      service.run(
        { sessionId: session.id, prompt: "Reply READY", permission },
        () => {},
        async () => false,
        new AbortController().signal,
      );
    const first = await run("readonly");
    expect(first.status).toBe("completed");
    expect(first.messages.at(-1)?.content).toBe("READY");
    expect(await service.listCheckpoints(session.id)).toEqual([]);
    expect(
      (await service.getDiagnostics(session.id)).messageCount,
    ).toBeGreaterThan(0);
    editing = true;
    expect((await run("unrestricted")).status).toBe("completed");
    expect(await readFile(join(home, "ordinary.txt"), "utf8")).toBe("after");
    const [checkpoint] = await service.listCheckpoints(session.id);
    if (!checkpoint) throw new Error("expected checkpoint");
    expect(
      await service.getCheckpointDiff(session.id, checkpoint.id),
    ).toContain("before");
    await service.restoreCheckpoint(session.id, checkpoint.id);
    expect(await readFile(join(home, "ordinary.txt"), "utf8")).toBe("before");
    await service.getProjectContext(session.id);
  } finally {
    await service.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

it("excludes all managed state from tools/context and keeps arbitrary nested checkpoint construction fail-closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-protected-regression-"));
  const state = join(home, "managed");
  await mkdir(join(state, "skills", "private"), {
    recursive: true,
    mode: 0o700,
  });
  const marker = "PRIVATE_FIXTURE_CONTENT_NEVER_RETURN";
  await writeFile(join(state, "session.json"), marker);
  await writeFile(join(state, "AGENTS.md"), marker);
  await writeFile(
    join(state, "skills", "private", "SKILL.md"),
    `---\nname: private\ndescription: ${marker}\n---\n${marker}`,
  );
  await symlink(state, join(home, "alias"));
  const checkpointDirectory = join(state, "checkpoints");
  await expect(
    createCheckpointStore(home, checkpointDirectory),
  ).rejects.toThrow();
  await expect(
    createCheckpointStore(home, join(home, "unsafe"), {
      protectedStateRoot: state,
    }),
  ).rejects.toThrow();
  const store = await createCheckpointStore(home, checkpointDirectory, {
    protectedStateRoot: state,
  });
  const tools = await createLocalToolRegistry(home, {
    protectedRoots: [state],
    checkpointStore: store,
  });
  const context: ToolContext = {
    sessionId: parseSessionId(randomUUID()),
    toolCallId: "fixture",
    workspace: home,
    permission: "unrestricted",
    signal: new AbortController().signal,
    onEvent: () => {},
    approve: async () => true,
  };
  const execute = (name: string, args: object) =>
    tools.execute(
      {
        id: "fixture",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
      context,
    );
  const project = await createProjectContext(home, {
    protectedRoots: [state],
    extraSkillDirectories: [
      join(state, "skills"),
      join(home, "alias", "skills"),
    ],
  });
  try {
    for (const path of [
      "managed/session.json",
      "alias/session.json",
      "managed/checkpoints/new.json",
    ]) {
      for (const [name, args] of [
        ["read_file", { path }],
        ["write_file", { path, content: "overwrite" }],
        ["edit_file", { path, old_text: marker, new_text: "overwrite" }],
        ["list_files", { path }],
        ["search_files", { path, query: marker }],
        ["make_directory", { path }],
      ] as const) {
        const result = await execute(name, args);
        expect(result.isError, `${name}: ${path}`).toBe(true);
        expect(result.content).not.toContain(marker);
      }
    }
    const listing = await execute("list_files", { path: ".", recursive: true });
    expect(listing.isError).toBe(false);
    expect(listing.content).not.toContain("managed");
    expect(listing.content).not.toContain("alias");
    const search = await execute("search_files", { query: marker });
    expect(search.isError).toBe(false);
    expect(search.content).not.toContain(marker);
    expect(
      (
        await execute("write_file", {
          path: "ordinary.txt",
          content: "visible",
        })
      ).isError,
    ).toBe(false);
    expect(
      (await execute("read_file", { path: "ordinary.txt" })).content,
    ).toContain("visible");
    const [checkpoint] = await store.list();
    if (!checkpoint) throw new Error("expected ordinary checkpoint");
    await store.restore(checkpoint.id, { isSessionActive: async () => false });
    await expect(readFile(join(home, "ordinary.txt"))).rejects.toThrow();
    await expect(
      store.begin({
        path: "managed/session.json",
        sessionId: "s",
        toolCallId: "t",
        before: Buffer.from(marker),
        after: Buffer.from("overwrite"),
      }),
    ).rejects.toThrow();
    // Simulate a persisted legacy record whose target later becomes protected.
    const recordPath = join(checkpointDirectory, `${checkpoint.id}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.path = "managed/session.json";
    record.state = "completed";
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    await expect(store.getDiff(checkpoint.id)).rejects.toThrow();
    await expect(
      store.restore(checkpoint.id, { isSessionActive: async () => false }),
    ).rejects.toThrow();
    await project.refresh();
    expect(JSON.stringify(project.getCatalog())).not.toContain(marker);
    expect(await project.resolveInstructions("managed")).toEqual([]);
    const aliasGuard = await createWorkspacePathGuard(join(home, "alias"), [
      state,
    ]);
    await expect(aliasGuard.resolveRead("session.json")).rejects.toMatchObject({
      code: "PROTECTED_PATH",
    });
    expect(await readFile(join(state, "session.json"), "utf8")).toBe(marker);
  } finally {
    await project.dispose();
    await tools.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
