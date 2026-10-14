import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { projectSummary, summarize } from "../../src/core/context";
import { createHarness } from "../../src/core/harness";
import { compactContext } from "../../src/core/runtime";
import type { ModelProvider } from "../../src/shared/contracts";
import type { Message } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
const prefix =
  "All spawned children joined. Integrate these bounded results, do not replay actions; inspect child sessions if needed:";
it("tags only generated reconciliation and preserves origin through reopen, fork and context projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-origin-"));
  const home = join(dir, "state");
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  let turns = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages, _tools, options) => {
      if (options.model === "child")
        return { message: { role: "assistant", content: "child evidence" } };
      if (++turns === 1)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "spawn",
                type: "function",
                function: {
                  name: "spawn_agent",
                  arguments: JSON.stringify({
                    task: "inspect",
                    model: "child",
                  }),
                },
              },
            ],
          },
        };
      if (turns === 2)
        return { message: { role: "assistant", content: "preliminary" } };
      expect(messages.at(-1)).toMatchObject({
        role: "user",
        origin: "agent_reconciliation",
      });
      expect(messages.at(-1)?.content).toContain("child evidence");
      return { message: { role: "assistant", content: "reconciled answer" } };
    },
  };
  const service = await createHarness({
    stateDir: home,
    providerFactory: () => provider,
    toolFactory: async () => ({
      definitions: [],
      execute: async () => ({ content: "", isError: false }),
      dispose: async () => {},
    }),
  });
  try {
    await service.updateSettings({
      settings: { baseUrl: "http://localhost:1234/v1", model: "parent" },
    });
    const root = await service.createSession({ workspace });
    const result = await service.run(
      { sessionId: root.id, prompt: prefix },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: "reconciled answer",
    });
    const users = result.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({ role: "user", content: prefix });
    expect(users[1]).toMatchObject({ origin: "agent_reconciliation" });
    const reopened = await openSessionStore(home);
    const persisted = await reopened.get(root.id);
    expect(persisted.messages).toEqual(result.messages);
    const fork = await service.forkSession(root.id);
    expect((await reopened.get(fork.id)).messages).toEqual(result.messages);
    expect(projectSummary(fork)).toEqual(result.messages);
    // A summary before the internal record leaves its exact metadata in the projected tail.
    const index = fork.messages.findIndex(
      (m) => m.role === "user" && m.origin === "agent_reconciliation",
    );
    const compacted = await summarize(
      fork,
      {
        listModels: async () => [],
        complete: async (messages) => {
          expect(messages[1]?.content).not.toContain(
            '"origin":"agent_reconciliation"',
          );
          return {
            message: { role: "assistant", content: "semantic prior memory" },
          };
        },
      },
      new AbortController().signal,
      index,
    );
    expect(projectSummary(compacted)).toContainEqual(users[1]);
    // Summarizing the full transcript retains typed provenance in the semantic input.
    await summarize(
      fork,
      {
        listModels: async () => [],
        complete: async (messages) => {
          expect(messages[1]?.content).toContain(
            '"origin":"agent_reconciliation"',
          );
          return { message: { role: "assistant", content: "full memory" } };
        },
      },
      new AbortController().signal,
      fork.messages.length,
    );
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
it("does not use an internal record as a human turn boundary during bounded compaction", () => {
  const internal: Message = {
    role: "user",
    origin: "agent_reconciliation",
    content: `${prefix} child evidence`,
  };
  const messages: Message[] = [
    { role: "system", content: "system" },
    { role: "user", content: "old human" },
    { role: "assistant", content: "x".repeat(300) },
    internal,
    { role: "assistant", content: "old reconciled answer" },
    { role: "user", content: "current human" },
    { role: "assistant", content: "current answer" },
  ];
  const expected = [messages[0], messages[5], messages[6]];
  const result = compactContext(
    messages,
    JSON.stringify(expected).length + JSON.stringify(internal).length + 50,
  );
  expect(result.messages).toEqual(expected);
  expect(result.removedMessages).toBe(4);
});
