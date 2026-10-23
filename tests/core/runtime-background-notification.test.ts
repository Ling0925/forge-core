import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type {
  LocalToolRegistry,
  ModelProvider,
  RunControl,
} from "../../src/shared/contracts";
import {
  type AgentEvent,
  type Message,
  type SessionSnapshot,
  defaultPublicSettings,
} from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-bg-notify-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const answer = (content: string) => ({
  message: { role: "assistant" as const, content },
});
const now = () => new Date().toISOString();

async function setup() {
  const store = await openSessionStore(directory);
  const root = await store.create({
    workspace: directory,
    title: "root",
    model: "parent",
  });
  const requests: (readonly Message[])[] = [];
  const permissions: string[] = [];
  let turns = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages) => {
      requests.push(messages);
      turns += 1;
      if (turns === 1)
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [call("read-1", "read_file", { path: "note.txt" })],
          },
        };
      return answer("noticed");
    },
  };
  const tools: LocalToolRegistry = {
    definitions: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "fixture read",
          parameters: {},
        },
      },
    ],
    execute: async (_call, context) => {
      permissions.push(context.permission);
      return { content: "fixture content", isError: false };
    },
    dispose: async () => {},
  };
  const runtime = createAgentRuntime({
    store,
    provider,
    tools,
    settings: defaultPublicSettings,
  });
  return { store, root, runtime, requests, permissions };
}

async function seed(
  store: Awaited<ReturnType<typeof setup>>["store"],
  root: SessionSnapshot,
  events: AgentEvent[],
) {
  const persisted = await store.get(root.id);
  const seeded: SessionSnapshot = {
    ...persisted,
    status: "idle",
    events: [...persisted.events, ...events],
    updatedAt: now(),
  };
  await store.save(seeded);
  return seeded;
}

const control = (overrides: Partial<RunControl> = {}): RunControl => ({
  drainSteering: () => [],
  ...overrides,
});

const notification = (sessionId: SessionSnapshot["id"]) => ({
  sessionId,
  prompt:
    "Background task 11111111-1111-4111-8111-111111111111 (forge_memory) is completed.",
  permission: "unrestricted" as const,
  mode: "build" as const,
});

it("tags the initial notification prompt as an internal result, not a human turn", async () => {
  const f = await setup();
  const result = await f.runtime.run(
    notification(f.root.id),
    () => {},
    async () => false,
    new AbortController().signal,
    control({
      inputOrigin: "background_task",
      getPermission: () => "unrestricted",
    }),
  );
  expect(result.status).toBe("completed");
  expect(
    result.messages.findLast((message) => message.role === "user"),
  ).toMatchObject({
    origin: "agent_reconciliation",
    content: notification(f.root.id).prompt,
  });
  const sent = f.requests[0] ?? [];
  expect(sent.findLast((message) => message.role === "user")).toMatchObject({
    origin: "agent_reconciliation",
  });
});

it("defaults a notification with no run history to readonly", async () => {
  const f = await setup();
  const result = await f.runtime.run(
    notification(f.root.id),
    () => {},
    async () => false,
    new AbortController().signal,
    control({
      inputOrigin: "background_task",
      getPermission: () => "unrestricted",
    }),
  );
  expect(
    result.events.find((event) => event.type === "run_started"),
  ).toMatchObject({
    permission: "readonly",
  });
  expect(f.permissions).toEqual(["readonly"]);
});

it("caps a late notification at the last actual run permission", async () => {
  const f = await setup();
  await seed(f.store, f.root, [
    {
      type: "run_started",
      sessionId: f.root.id,
      timestamp: now(),
      model: "parent",
      permission: "workspace",
    },
    {
      type: "run_finished",
      sessionId: f.root.id,
      timestamp: now(),
      status: "completed",
      turns: 1,
      toolCalls: 0,
    },
  ]);
  const result = await f.runtime.run(
    notification(f.root.id),
    () => {},
    async () => false,
    new AbortController().signal,
    control({
      inputOrigin: "background_task",
      getPermission: () => "unrestricted",
    }),
  );
  // The dynamic getPermission override cannot widen the persisted cap.
  expect(
    result.events.find((event) => event.type === "run_started"),
  ).toMatchObject({
    permission: "workspace",
  });
  expect(f.permissions).toEqual(["workspace"]);
});

it("honors the most recent persisted permission change and never exceeds it", async () => {
  const f = await setup();
  await seed(f.store, f.root, [
    {
      type: "run_started",
      sessionId: f.root.id,
      timestamp: now(),
      model: "parent",
      permission: "unrestricted",
    },
    {
      type: "permission_changed",
      sessionId: f.root.id,
      timestamp: now(),
      permission: "readonly",
    },
  ]);
  const result = await f.runtime.run(
    notification(f.root.id),
    () => {},
    async () => false,
    new AbortController().signal,
    control({
      inputOrigin: "background_task",
      getPermission: () => "unrestricted",
    }),
  );
  expect(
    result.events.filter((event) => event.type === "run_started").at(-1),
  ).toMatchObject({ permission: "readonly" });
  expect(f.permissions).toEqual(["readonly"]);
});

it("keeps ordinary runs unaffected by the notification cap", async () => {
  const f = await setup();
  await seed(f.store, f.root, [
    {
      type: "run_started",
      sessionId: f.root.id,
      timestamp: now(),
      model: "parent",
      permission: "readonly",
    },
  ]);
  const result = await f.runtime.run(
    {
      sessionId: f.root.id,
      prompt: "ordinary request",
      permission: "workspace",
    },
    () => {},
    async () => false,
    new AbortController().signal,
    control({ getPermission: () => "unrestricted" }),
  );
  expect(
    result.events.filter((event) => event.type === "run_started").at(-1),
  ).toMatchObject({ permission: "unrestricted" });
  expect(
    result.messages.findLast((message) => message.role === "user"),
  ).not.toHaveProperty("origin");
});

it.each(["failed", "cancelled", "interrupted", "running"] as const)(
  "does not revive a high permission from an unsafe %s predecessor",
  async (status) => {
    const f = await setup();
    const seeded = await seed(f.store, f.root, [
      {
        type: "run_started",
        sessionId: f.root.id,
        timestamp: now(),
        model: "parent",
        permission: "unrestricted",
      },
    ]);
    await f.store.save({ ...seeded, status });
    await f.runtime.run(
      notification(f.root.id),
      () => {},
      async () => false,
      new AbortController().signal,
      control({
        inputOrigin: "background_task",
        getPermission: () => "unrestricted",
      }),
    );
    expect(f.permissions).toEqual(["readonly"]);
  },
);

it("freezes host changes and persists the final effective permission", async () => {
  const f = await setup();
  let permission: "readonly" | "unrestricted" = "unrestricted";
  let frozen = false;
  const snapshot = await f.runtime.run(
    { sessionId: f.root.id, prompt: "normal run" },
    (event) => {
      if (event.type === "tool_finished") permission = "readonly";
    },
    async () => false,
    new AbortController().signal,
    control({
      getPermission: () => permission,
      onFinalizing: () => {
        frozen = true;
      },
    }),
  );
  expect(frozen).toBe(true);
  expect(
    snapshot.events.findLast((event) => event.type === "permission_changed"),
  ).toMatchObject({ permission: "readonly" });
  expect(
    (await f.store.get(f.root.id)).events.findLast(
      (event) => event.type === "permission_changed",
    ),
  ).toMatchObject({ permission: "readonly" });
});
