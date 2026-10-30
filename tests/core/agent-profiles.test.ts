import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type AgentEnvironment,
  executeAgentOperation,
} from "../../src/core/agent-operations";
import {
  agentAllowsWebSearch,
  isAgentToolAllowed,
} from "../../src/core/agent-profiles";
import { createHarness } from "../../src/core/harness";
import { createAgentRuntime } from "../../src/core/runtime";
import {
  type AgentProfile,
  agentProfileSchema,
  agentProfileTemplates,
} from "../../src/shared/agent-profiles";
import type {
  AgentRuntimeDependencies,
  LocalToolRegistry,
  ModelProvider,
} from "../../src/shared/contracts";
import { type Message, defaultPublicSettings } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { testScratch } from "../fixtures/scratch";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const profile = (patch: Partial<AgentProfile> = {}) =>
  agentProfileSchema.parse({
    ...agentProfileTemplates[0],
    id: "specialist",
    revision: 1,
    instructions: "PRIVATE_ROLE_INSTRUCTIONS",
    model: {
      mode: "fixed",
      providerSourceId: "source-special",
      model: "exact/model-id",
    },
    ...patch,
  });
const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const calls = (...tools: ReturnType<typeof call>[]) => ({
  message: { role: "assistant" as const, content: null, tool_calls: tools },
});
const done = () => ({
  message: { role: "assistant" as const, content: "done" },
});
const empty: LocalToolRegistry = {
  definitions: [],
  execute: async () => ({ content: "ok", isError: false }),
  dispose: async () => {},
};
async function fixture(
  provider: ModelProvider = {
    listModels: async () => [],
    complete: async () => done(),
  },
) {
  const base = testScratch("agent-collaboration");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "profiles-"));
  const store = await openSessionStore(directory);
  const root = await store.create({
    workspace: directory,
    title: "root",
    model: "parent",
    providerSourceId: "source-parent",
  });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const deps: {
    -readonly [K in keyof AgentRuntimeDependencies]: AgentRuntimeDependencies[K];
  } = {
    store,
    provider,
    tools: empty,
    settings: { ...defaultPublicSettings, agentProfiles: [profile()] },
  };
  const env: AgentEnvironment = {
    deps,
    snapshot: root,
    input: { sessionId: root.id, prompt: "task" },
    permission: "unrestricted",
    signal: new AbortController().signal,
    children: new Map(),
    approveChild: () => async () => false,
    runChild: async () => {
      throw Error("Unexpected child construction");
    },
  };
  return { store, root, deps, env };
}

it("provides explicit templates and fail-closed tool groups, including MCP aliases and hosted search", () => {
  expect(agentProfileTemplates.map((profile) => profile.id)).toEqual([
    "explorer",
    "frontend",
    "backend",
    "reviewer",
  ]);
  const restricted = profile({
    permission: "unrestricted",
    tools: {
      mode: "restricted",
      groups: ["read", "mcp"],
      mcpServers: ["allowed"],
    },
  });
  expect(isAgentToolAllowed(restricted, "read_file", {})).toBe(true);
  for (const name of [
    "write_file",
    "run_command",
    "web_fetch",
    "browser_navigate",
    "update_memory",
    "unknown_tool",
  ])
    expect(isAgentToolAllowed(restricted, name, {})).toBe(false);
  expect(isAgentToolAllowed(restricted, "advisor", {})).toBe(true);
  expect(
    isAgentToolAllowed(restricted, "mcp_list_tools", { server: "allowed" }),
  ).toBe(true);
  expect(
    isAgentToolAllowed(restricted, "mcp_list_tools", { server: "other" }),
  ).toBe(false);
  expect(
    isAgentToolAllowed(restricted, "mcp_call_tool", {
      toolName: "mcp__allowed__read",
    }),
  ).toBe(true);
  expect(
    isAgentToolAllowed(restricted, "mcp_call_tool", {
      toolName: "mcp__other__read",
    }),
  ).toBe(false);
  expect(isAgentToolAllowed(restricted, "mcp__other__read", {})).toBe(false);
  expect(agentAllowsWebSearch(restricted)).toBe(false);
  expect(agentAllowsWebSearch(profile({ tools: { mode: "inherit" } }))).toBe(
    true,
  );
  expect(isAgentToolAllowed(undefined, "legacy_tool", {})).toBe(true);
});

it("lists bounded summaries, not instructions, and refuses stale/disabled/missing roles before creating a child", async () => {
  const f = await fixture();
  f.deps.getAgentProfiles = async () => [
    profile(),
    profile({ id: "off", enabled: false }),
  ];
  const listed = JSON.parse(
    (
      await executeAgentOperation(
        "list_agent_profiles",
        { query: "specialist", limit: 1 },
        f.env,
      )
    ).content,
  );
  expect(listed.profiles).toHaveLength(1);
  expect(listed.profiles[0]).toMatchObject({
    id: "specialist",
    revision: 1,
    model: { model: "exact/model-id" },
  });
  expect(JSON.stringify(listed)).not.toContain("PRIVATE_ROLE_INSTRUCTIONS");
  for (const args of [
    { profileId: "missing" },
    { profileId: "off" },
    { profileId: "specialist", profileRevision: 2 },
    { profileId: "specialist", model: "different" },
    { profileRevision: 1 },
  ])
    await expect(
      executeAgentOperation("spawn_agent", { task: "work", ...args }, f.env),
    ).rejects.toMatchObject({ code: "invalid_input" });
  expect(await f.store.list()).toHaveLength(1);
});

it("freezes exact role/source/instructions and clamps permission, even if configuration changes during the child", async () => {
  let turn = 0;
  const saved = profile();
  let current: readonly AgentProfile[] = [saved];
  let observedChild = false;
  const parent: ModelProvider = {
    listModels: async () => [],
    complete: async (messages) => {
      expect(messages[0]?.content).not.toContain("PRIVATE_ROLE_INSTRUCTIONS");
      if (++turn === 1)
        return calls(
          call("spawn", "spawn_agent", {
            task: "investigate",
            profileId: "specialist",
            profileRevision: 1,
          }),
        );
      return done();
    },
  };
  const f = await fixture(parent);
  f.deps.getAgentProfiles = async () => current;
  f.deps.childContextFactory = async (_workspace, input) => {
    expect(input).toMatchObject({
      model: "exact/model-id",
      providerSourceId: "source-special",
      permission: "readonly",
    });
    return {
      tools: empty,
      instructions: "Project rules",
      providerSourceId: "source-special",
      provider: {
        listModels: async () => [],
        complete: async (messages, definitions, options) => {
          observedChild = true;
          current = [
            profile({
              revision: 2,
              enabled: false,
              name: "Changed",
              instructions: "Changed role",
            }),
          ];
          expect(options.model).toBe("exact/model-id");
          expect(messages[0]?.content).toContain("PRIVATE_ROLE_INSTRUCTIONS");
          expect(messages[0]?.content).toContain("readonly");
          expect(
            definitions.some((tool) => tool.function.name === "spawn_agent"),
          ).toBe(false);
          expect(
            definitions.some((tool) => tool.function.name === "advisor"),
          ).toBe(true);
          return done();
        },
      },
    };
  };
  const completed = await createAgentRuntime(f.deps).run(
    { sessionId: f.root.id, prompt: "delegate", permission: "unrestricted" },
    () => {},
    async () => false,
    AbortSignal.timeout(5000),
  );
  expect(completed.status).toBe("completed");
  expect(observedChild).toBe(true);
  const child = (await f.store.list()).find(
    (session) => session.parentSessionId === f.root.id,
  )!;
  expect(child).toMatchObject({
    agentProfileId: "specialist",
    agentProfileName: saved.name,
    model: "exact/model-id",
    providerSourceId: "source-special",
  });
  expect((await f.store.get(child.id)).agentProfile).toEqual(saved);
  expect((await f.store.get(child.id)).permissionCeiling).toBe("readonly");
}, 10000);

it("inherits the exact parent selection and keeps a live parent permission getter", async () => {
  const f = await fixture();
  f.deps.getAgentProfiles = async () => [
    profile({ model: { mode: "inherit" }, permission: "workspace" }),
  ];
  let selected: Parameters<AgentEnvironment["runChild"]>[0] | undefined;
  let inherited: string | undefined;
  f.env.runChild = async (input, _approve, _signal, control) => {
    selected = input;
    f.env.permission = "readonly";
    inherited = control?.getPermission?.();
    return f.store.get(input.sessionId);
  };
  await expect(
    executeAgentOperation(
      "spawn_agent",
      { task: "bad override", profileId: "specialist", model: "other" },
      f.env,
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const started = JSON.parse(
    (
      await executeAgentOperation(
        "spawn_agent",
        { task: "inherit", profileId: "specialist" },
        f.env,
      )
    ).content,
  );
  await f.env.children.get(started.childSessionId)?.work;
  expect(selected).toMatchObject({
    model: "parent",
    providerSourceId: "source-parent",
    permission: "workspace",
  });
  expect(inherited).toBe("readonly");
  expect((await f.store.get(started.childSessionId)).permissionCeiling).toBe(
    "workspace",
  );
});

it("fails a fixed-source child without silently constructing a fallback", async () => {
  let turn = 0;
  let constructions = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async () =>
      ++turn === 1
        ? calls(
            call("spawn", "spawn_agent", {
              task: "work",
              profileId: "specialist",
            }),
          )
        : done(),
  };
  const f = await fixture(provider);
  f.deps.childContextFactory = async () => {
    constructions++;
    throw Error("source unavailable");
  };
  const completed = await createAgentRuntime(f.deps).run(
    { sessionId: f.root.id, prompt: "delegate" },
    () => {},
    async () => false,
    AbortSignal.timeout(5000),
  );
  expect(completed.status).toBe("failed");
  expect(constructions).toBe(1);
  const child = (await f.store.list()).find(
    (session) => session.parentSessionId === f.root.id,
  )!;
  expect(child).toMatchObject({
    status: "failed",
    model: "exact/model-id",
    providerSourceId: "source-special",
  });
});

it("rejects manual fixed-model changes before any provider generation", async () => {
  let generations = 0;
  const f = await fixture({
    listModels: async () => [],
    complete: async () => {
      generations++;
      return done();
    },
  });
  await f.store.save({
    ...f.root,
    agentProfile: profile(),
    model: "exact/model-id",
    providerSourceId: "source-special",
  });
  const completed = await createAgentRuntime(f.deps).run(
    { sessionId: f.root.id, prompt: "continue", model: "other/model" },
    () => {},
    async () => false,
    AbortSignal.timeout(5000),
  );
  expect(completed.status).toBe("failed");
  expect(
    completed.events.some(
      (event) => event.type === "error" && event.error.code === "invalid_input",
    ),
  ).toBe(true);
  expect(generations).toBe(0);
});

it("uses the configured source through the real Harness even when two sources expose the same model", async () => {
  const f = await fixture();
  let parentTurns = 0;
  const seen: string[] = [];
  const service = await createHarness({
    stateDir: join(f.root.workspace, "harness"),
    providerFactory: (config) => ({
      listModels: async () => [],
      complete: async () => {
        seen.push(config.baseUrl);
        if (config.baseUrl === "https://source-special.invalid/v1")
          return done();
        if (++parentTurns === 1)
          return calls(
            call("spawn", "spawn_agent", {
              task: "inspect",
              profileId: "specialist",
            }),
          );
        return done();
      },
    }),
    toolFactory: () => empty,
  });
  try {
    for (const id of ["source-parent", "source-special"])
      await service.updateSettings({
        source: {
          type: "save",
          source: {
            id,
            label: id,
            model: "exact/model-id",
            baseUrl: `https://${id}.invalid/v1`,
            apiMode: "chat-completions",
          },
        },
      });
    const { revision: _revision, ...input } = profile();
    await service.updateSettings({
      agent: { type: "save", profile: input, expectedRevision: 0 },
    });
    const parent = await service.createSession({
      workspace: f.root.workspace,
      title: "Parent fixture",
      model: "exact/model-id",
      providerSourceId: "source-parent",
    });
    const completed = await service.run(
      { sessionId: parent.id, prompt: "delegate" },
      () => {},
      async () => false,
      AbortSignal.timeout(7000),
    );
    expect(completed.status).toBe("completed");
    expect(seen).toContain("https://source-special.invalid/v1");
    const child = (await service.listSessions()).find(
      (session) => session.parentSessionId === parent.id,
    )!;
    expect(child).toMatchObject({
      providerSourceId: "source-special",
      model: "exact/model-id",
      agentProfileId: "specialist",
    });
    const before = seen.length;
    await expect(
      service.run(
        {
          sessionId: child.id,
          prompt: "switch source",
          providerSourceId: "source-parent",
        },
        () => {},
        async () => false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(seen).toHaveLength(before);
  } finally {
    await service.dispose();
  }
}, 12000);

it("denies forged restricted calls before execution and keeps hosted search disabled", async () => {
  let turn = 0;
  const executed: string[] = [];
  const provider: ModelProvider = {
    apiMode: "responses",
    listModels: async () => [],
    complete: async (messages, definitions, options) => {
      expect(options.webSearch).toBe("disabled");
      expect(
        definitions.some((tool) => tool.function.name === "write_file"),
      ).toBe(false);
      if (++turn === 1)
        return calls(
          call("read-a", "read_file", { path: "a" }),
          call("read-b", "read_file", { path: "b" }),
          call("write", "write_file", { path: "x", content: "bad" }),
          call("mcp", "mcp_call_tool", {
            toolName: "mcp__other__unsafe",
            arguments_json: "{}",
          }),
          call("spawn", "spawn_agent", { task: "bypass" }),
        );
      const results = messages
        .filter(
          (message): message is Extract<Message, { role: "tool" }> =>
            message.role === "tool",
        )
        .map((message) => JSON.parse(message.content));
      expect(results.map((result) => result.isError)).toEqual([
        false,
        false,
        true,
        true,
        true,
      ]);
      return done();
    },
  };
  const f = await fixture(provider);
  // Standalone continuation has no live advisor port; its original role still constrains tools.
  await f.store.save({
    ...f.root,
    parentSessionId: f.root.id,
    agentProfile: profile({
      permission: "unrestricted",
      tools: {
        mode: "restricted",
        groups: ["read", "mcp"],
        mcpServers: ["allowed"],
      },
    }),
    permissionCeiling: "unrestricted",
  });
  f.deps.tools = {
    ...empty,
    definitions: ["read_file", "write_file", "mcp_call_tool"].map((name) => ({
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object", properties: {} },
      },
    })),
    isConcurrencySafe: (tool) => tool.function.name === "read_file",
    execute: async (tool) => {
      executed.push(tool.function.name);
      return { content: "ok", isError: false };
    },
  };
  const completed = await createAgentRuntime(f.deps).run(
    { sessionId: f.root.id, prompt: "continue", permission: "unrestricted" },
    () => {},
    async () => false,
    AbortSignal.timeout(5000),
  );
  expect(completed.status).toBe("completed");
  expect(executed).toEqual(["read_file", "read_file"]);
  expect(await f.store.list()).toHaveLength(1);
}, 10000);
