import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";
import type { Message } from "../../src/shared/schemas";
import { providerStateSchema } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
it("persists valid fork memory and projects it only when its complete boundary is included", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-fork-summary-"));
  const home = join(dir, "state");
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  let providerCalls = 0;
  let toolFactories = 0;
  let toolExecutions = 0;
  const projections: (readonly Message[])[] = [];
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages) => {
      providerCalls++;
      projections.push(messages);
      return {
        message: { role: "assistant", content: "continued without replay" },
      };
    },
  };
  const options = {
    stateDir: home,
    providerFactory: () => provider,
    toolFactory: async () => {
      toolFactories++;
      return {
        definitions: [],
        execute: async () => {
          toolExecutions++;
          return { content: "", isError: false };
        },
        dispose: async () => {},
      };
    },
  };
  let service = await createHarness(options);
  try {
    await service.updateSettings({
      settings: {
        baseUrl: "http://localhost:1234/v1",
        model: "actual",
        contextBudgetChars: 100000,
      },
    });
    const source = await service.createSession({ workspace });
    const store = await openSessionStore(home);
    const state = providerStateSchema.parse({
      version: 1,
      apiMode: "responses",
      baseUrl: "http://localhost:1234/v1",
      model: "actual",
      output: [
        {
          type: "reasoning",
          id: "opaque",
          encrypted_content: "exact-continuation",
        },
      ],
    });
    const messages: Message[] = [
      { role: "system", content: "stable prefix" },
      { role: "user", content: "before-summary-history" },
      {
        role: "assistant",
        content: null,
        providerState: state,
        tool_calls: [
          {
            id: "effect",
            type: "function",
            function: {
              name: "write_file",
              arguments: '{"path":"done.txt","content":"already written"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "effect",
        content: "effect already completed",
      },
      { role: "assistant", content: "past final", providerState: state },
      { role: "user", content: "included-tail" },
      { role: "assistant", content: "tail final", providerState: state },
    ];
    const summary = {
      content:
        "Semantic memory of completed write; inspect effects, never replay",
      boundary: 5,
      fallback: false,
    };
    await store.save({
      ...source,
      messages,
      contextSummary: summary,
      parentSessionId: source.id,
      permissionCeiling: "readonly",
      agentTask: "inspect",
      ownership: "src",
    });
    const full = await service.forkSession(source.id);
    const atBoundary = await service.forkSession(source.id, 5);
    const earlier = await service.forkSession(source.id, 2);
    expect(providerCalls).toBe(0);
    expect(toolFactories).toBe(0);
    expect(toolExecutions).toBe(0);
    expect(full.contextSummary).toEqual(summary);
    expect(atBoundary.contextSummary).toEqual(summary);
    expect(earlier.contextSummary).toBeUndefined();
    expect(full.messages).toEqual(messages);
    expect(earlier.messages).toEqual(messages.slice(0, 2));
    expect(full).toMatchObject({
      parentSessionId: source.id,
      permissionCeiling: "readonly",
      agentTask: "inspect",
      ownership: "src",
      forkedFrom: source.id,
    });
    await expect(service.forkSession(source.id, 3)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await service.dispose();
    service = await createHarness(options);
    const reopened = await openSessionStore(home);
    expect((await reopened.get(full.id)).contextSummary).toEqual(summary);
    expect((await reopened.get(full.id)).messages).toEqual(messages);
    expect((await reopened.get(earlier.id)).contextSummary).toBeUndefined();
    const diagnostics = await service.getDiagnostics(full.id);
    expect(diagnostics.projectedChars).toBeLessThan(
      diagnostics.transcriptChars,
    );
    for (const id of [full.id, earlier.id])
      expect(
        (
          await service.run(
            { sessionId: id, prompt: "continue inspection" },
            () => {},
            async () => false,
            new AbortController().signal,
          )
        ).status,
      ).toBe("completed");
    expect(providerCalls).toBe(2);
    expect(toolExecutions).toBe(0);
    const fullProjection = projections[0] ?? [];
    expect(
      fullProjection.some((m) => m.content?.includes(summary.content)),
    ).toBe(true);
    expect(fullProjection.some((m) => m.content === "included-tail")).toBe(
      true,
    );
    expect(
      fullProjection.some((m) => m.content === "before-summary-history"),
    ).toBe(false);
    expect(fullProjection.some((m) => m.role === "tool")).toBe(false);
    expect(fullProjection.find((m) => m.content === "tail final")?.role).toBe(
      "assistant",
    );
    expect(
      fullProjection.find((m) => m.content === "tail final"),
    ).toMatchObject({ providerState: state });
    const earlyProjection = projections[1] ?? [];
    expect(
      earlyProjection.some((m) => m.content?.includes(summary.content)),
    ).toBe(false);
    expect(
      earlyProjection.some((m) => m.content === "before-summary-history"),
    ).toBe(true);
    expect(earlyProjection.some((m) => m.content === "included-tail")).toBe(
      false,
    );
    for (const boundary of [3, 99]) {
      await store.save({
        ...source,
        messages,
        contextSummary: { ...summary, boundary },
      });
      expect(
        (await service.forkSession(source.id)).contextSummary,
      ).toBeUndefined();
    }
    await expect(
      store.save({
        ...source,
        messages,
        contextSummary: { ...summary, boundary: -1 },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
