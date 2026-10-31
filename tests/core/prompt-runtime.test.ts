import { expect, it, vi } from "vitest";
import { nativeDefinitions, nativeDefinitionsFor } from "../../src/core/agents";
import { projectSummary, summaryBoundary } from "../../src/core/context";
import { buildSystemInstructions } from "../../src/core/prompts";
import { createRootRunBudget } from "../../src/core/run-budget";
import { createAgentRuntime } from "../../src/core/runtime";
import { createRunState } from "../../src/core/runtime-state";
import { prepareStepContext } from "../../src/core/runtime-step-context";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  measureContext,
  resolveContextBudget,
} from "../../src/shared/context-usage";
import type { ModelProvider, SessionStore } from "../../src/shared/contracts";
import {
  type Message,
  defaultPublicSettings,
  sessionIdSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";

// Exercise the real runtime projection, not just the text builder. No disk,
// network, commands or user settings are needed for these provider fixtures.
function fixture(
  state = sessionSnapshotSchema.parse({
    version: 1,
    id: "12345678-1234-4234-8234-123456789abc",
    title: "prompts",
    workspace: "/workspace",
    model: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "idle",
    messages: [],
    events: [],
    changes: [],
  }),
) {
  let current = state;
  const received: (readonly Message[])[] = [];
  const store: SessionStore = {
    list: async () => [],
    get: async () => current,
    create: async () => current,
    save: async (snapshot) => {
      current = sessionSnapshotSchema.parse(snapshot);
    },
    acquire: async () => async () => {},
  };
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages) => {
      received.push(messages);
      return { message: { role: "assistant", content: "done" } };
    },
  };
  const deps = {
    store,
    provider,
    settings: { ...defaultPublicSettings, maxToolCalls: 17 },
    projectInstructions: "PROJECT_V1",
    tools: {
      definitions: [],
      execute: async () => ({ content: "ok", isError: false }),
      dispose: async () => {},
    },
  };
  return {
    deps,
    received,
    state,
    current: () => current,
    runtime: createAgentRuntime(deps),
  };
}

it("uses live permissions for each tool and refreshes the next model request", async () => {
  const f = fixture();
  let permission: "readonly" | "workspace" | "unrestricted" = "workspace";
  let turn = 0;
  const executed: string[] = [];
  const runtime = createAgentRuntime({
    ...f.deps,
    provider: {
      listModels: async () => [],
      complete: async (messages) => {
        if (turn++ === 0)
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: ["one", "two", "three"].map((id) => ({
                id,
                type: "function" as const,
                function: { name: "run_command", arguments: "{}" },
              })),
            },
          };
        expect(messages[0]?.content).toBe(
          buildSystemInstructions({
            session: f.state,
            permission: "readonly",
            mode: undefined,
            maxToolCalls: 17,
            projectInstructions: "PROJECT_V1",
            toolNames: nativeDefinitions.map(
              (definition) => definition.function.name,
            ),
          }),
        );
        return { message: { role: "assistant", content: "done" } };
      },
    },
    tools: {
      ...f.deps.tools,
      execute: async (_call, context) => {
        executed.push(context.permission);
        return { content: "ok", isError: false };
      },
    },
  });
  await runtime.run(
    { sessionId: f.state.id, prompt: "test", permission: "workspace" },
    (event) => {
      if (event.type === "tool_started" && event.call.id === "two")
        permission = "unrestricted";
      if (event.type === "tool_started" && event.call.id === "three")
        permission = "readonly";
    },
    async () => false,
    new AbortController().signal,
    { drainSteering: () => [], getPermission: () => permission },
  );
  expect(executed).toEqual(["workspace", "unrestricted"]);
});

it("refreshes mode, effective permissions and project context without rewriting history", async () => {
  const f = fixture();
  const run = (mode: "plan" | "build") =>
    f.runtime.run(
      { sessionId: f.state.id, prompt: mode, mode, permission: "unrestricted" },
      () => {},
      async () => false,
      new AbortController().signal,
    );
  expect((await run("plan")).status).toBe("completed");
  const persisted = f.current().messages[0];
  const expected = (
    mode: "plan" | "build",
    permission: "readonly" | "unrestricted",
    projectInstructions: string,
  ) =>
    buildSystemInstructions({
      session: f.state,
      mode,
      permission,
      projectInstructions,
      maxToolCalls: 17,
      toolNames: nativeDefinitions.map(
        (definition) => definition.function.name,
      ),
    });
  expect(f.received[0]?.[0]?.content).toBe(
    expected("plan", "readonly", "PROJECT_V1"),
  );
  f.deps.projectInstructions = "PROJECT_V2";
  expect((await run("build")).status).toBe("completed");
  const latest = f.received[1]?.[0]?.content;
  expect(latest).toBe(expected("build", "unrestricted", "PROJECT_V2"));
  expect(f.current().messages[0]).toEqual(persisted);
  expect(
    f.received[1]?.filter((message) => message.role === "system"),
  ).toHaveLength(1);
});

it("uses inherited child ceilings and scope when projecting a legacy summarized session", async () => {
  const legacy: Message[] = [
    { role: "system", content: "legacy prompt" },
    { role: "user", content: "old task" },
    { role: "assistant", content: "old result" },
  ];
  const f = fixture({
    ...fixture().state,
    messages: legacy,
    parentSessionId: sessionIdSchema.parse(
      "22345678-1234-4234-8234-123456789abc",
    ),
    permissionCeiling: "readonly",
    agentTask: "inspect prompts",
    ownership: "src/core",
    contextSummary: {
      boundary: 3,
      content: "prior work, do not replay",
      fallback: false,
    },
  });
  const result = await f.runtime.run(
    {
      sessionId: f.state.id,
      prompt: "continue",
      mode: "build",
      permission: "unrestricted",
    },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(f.received[0]?.[0]?.content).toBe(
    buildSystemInstructions({
      session: f.state,
      permission: "readonly",
      mode: "build",
      maxToolCalls: 17,
      projectInstructions: "PROJECT_V1",
      toolNames: nativeDefinitionsFor(true, false).map(
        (definition) => definition.function.name,
      ),
    }),
  );
  expect(f.received[0]?.[1]?.content).toContain("prior work, do not replay");
  expect(result.messages.slice(0, legacy.length)).toEqual(legacy);
});

it("projects registry-specific guidance unchanged across tool turns", async () => {
  const f = fixture();
  f.deps.provider.complete = async (messages) => {
    f.received.push(messages);
    return f.received.length === 1
      ? {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "read",
                type: "function",
                function: { name: "publish_file", arguments: "{}" },
              },
            ],
          },
        }
      : { message: { role: "assistant", content: "done" } };
  };
  const runtime = createAgentRuntime({
    ...f.deps,
    tools: {
      ...f.deps.tools,
      definitions: [
        {
          type: "function",
          function: {
            name: "publish_file",
            description: "fixture",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    },
  });
  const result = await runtime.run(
    { sessionId: f.state.id, prompt: "inspect" },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(f.received).toHaveLength(2);
  expect(f.received[0]?.[0]?.content).toContain("publish_file");
  expect(f.received[0]?.[0]?.content).not.toContain("web_fetch");
  expect(f.received[1]?.[0]).toEqual(f.received[0]?.[0]);
});

it.each([false, true])(
  "reuses projected instructions until their text changes (leading system: %s)",
  async (leadingSystem) => {
    const messages: Message[] = [
      ...(leadingSystem
        ? [{ role: "system" as const, content: "obsolete rules" }]
        : []),
      { role: "user", content: "old request" },
      { role: "system", content: "additional rules" },
      { role: "assistant", content: "old result" },
    ];
    const f = fixture({
      ...fixture().state,
      messages,
      contextSummary: {
        boundary: leadingSystem ? 1 : 0,
        content: "prior work",
        fallback: false,
      },
    });
    f.deps.provider.complete = async (incoming) => {
      const currentInstructions = buildSystemInstructions({
        session: f.current(),
        permission: "workspace",
        mode: "build",
        projectInstructions: f.deps.projectInstructions,
        toolNames: nativeDefinitionsFor(false, false).map(
          (definition) => definition.function.name,
        ),
        canDelegate: true,
      });
      const projected = projectSummary(f.current()).map((message, index) =>
        index === 0 && message.role === "system"
          ? { role: "system" as const, content: currentInstructions }
          : message,
      );
      expect(incoming).toEqual(
        projected[0]?.role === "system"
          ? projected
          : [{ role: "system", content: currentInstructions }, ...projected],
      );
      f.received.push(incoming);
      return f.received.length < 4
        ? {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `inspect-${f.received.length}`,
                  type: "function",
                  function: { name: "inspect", arguments: "{}" },
                },
              ],
            },
          }
        : { message: { role: "assistant", content: "done" } };
    };
    f.deps.tools.execute = async () => {
      if (f.received.length === 2) f.deps.projectInstructions = "PROJECT_V2";
      return { content: "ok", isError: false };
    };
    const result = await f.runtime.run(
      {
        sessionId: f.state.id,
        prompt: "continue",
        mode: "build",
        permission: "workspace",
      },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(f.received).toHaveLength(4);
    expect(f.received[1]?.[0]).toBe(f.received[0]?.[0]);
    expect(f.received[2]?.[0]).not.toBe(f.received[1]?.[0]);
    expect(f.received[3]?.[0]).toBe(f.received[2]?.[0]);
    expect(f.received[0]?.[0]?.content).toContain("PROJECT_V1");
    expect(f.received[2]?.[0]?.content).toContain("PROJECT_V2");
    expect(result.messages.slice(0, messages.length)).toEqual(messages);
  },
);

it.each([false, true])(
  "reuses instructions across compaction candidates (leading system: %s)",
  async (leadingSystem) => {
    const messages: Message[] = leadingSystem
      ? [
          { role: "system", content: "obsolete rules" },
          { role: "system", content: "additional rules" },
        ]
      : [];
    for (let index = 0; index < 6; index++)
      messages.push(
        { role: "user", content: `request-${index}` },
        { role: "assistant", content: `result-${index}` },
      );
    const f = fixture({ ...fixture().state, messages });
    const windowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
    const budget = resolveContextBudget(windowTokens, defaultPublicSettings);
    const rootBudget = createRootRunBudget({ rootSessionId: f.state.id });
    let previousSystem: Message | undefined;
    for (const currentInstructions of ["current rules", ""]) {
      const replace = (messages: readonly Message[]): Message[] =>
        messages.map((message, index) =>
          index === 0 && message.role === "system"
            ? { role: "system", content: currentInstructions }
            : message,
        );
      const expected: Message[][] = [];
      const boundary = summaryBoundary(
        f.state,
        (candidate) => {
          const projected = replace(candidate);
          expected.push(projected);
          return measureContext(projected, windowTokens).usedTokens;
        },
        0,
      );
      const contextSize = vi.fn(
        (messages: readonly Message[]) =>
          measureContext(messages, windowTokens).usedTokens,
      );
      const run = { ...createRunState(), snapshot: f.state };
      await prepareStepContext(
        {
          run,
          deps: f.deps,
          signal: new AbortController().signal,
          rootBudget,
          save: async () => {},
          event: () => {},
          onModelUsage: () => {},
        },
        {
          project: (state) => replace(projectSummary(state)),
          contextSize,
          calibratedSize: () => budget.limit + 1,
          rawLimit: budget.limit,
          rawTarget: 0,
          budget,
          windowTokens,
          definitions: [],
          currentInstructions,
        },
      );
      const candidates = contextSize.mock.calls
        .slice(0, expected.length)
        .map(([messages]) => messages);
      expect(candidates.length).toBeGreaterThan(1);
      expect(candidates).toEqual(expected);
      expect(run.snapshot.contextSummary?.boundary).toBe(boundary);
      if (leadingSystem) {
        const system = candidates[0]?.[0];
        expect(system).not.toBe(previousSystem);
        for (const candidate of candidates) expect(candidate[0]).toBe(system);
        previousSystem = system;
      }
    }
    rootBudget.close();
  },
);
