import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHarness, createSessionWithProfile } from "../../src/core";
import {
  type AgentProfileInput,
  ForgeError,
  type HarnessOptions,
  type HarnessService,
  type LocalToolRegistry,
  type Permission,
  type SessionId,
  agentProfileTemplates,
  defaultPublicSettings,
  defineTool,
} from "../../src/shared";
import { openSessionStore } from "../../src/store";

let directory: string;
let workspace: string;
const services: HarnessService[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-host-seams-"));
  workspace = join(directory, "workspace");
  await mkdir(workspace);
  vi.stubEnv("FORGE_HOME", join(directory, "state"));
  for (const name of ["FORGE_MODEL", "FORGE_BASE_URL", "FORGE_API_KEY"])
    vi.stubEnv(name, undefined);
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const profile: AgentProfileInput = {
  ...agentProfileTemplates[0]!,
  id: "host-profile",
  name: "Host profile",
  instructions: "Profile instructions",
  model: { mode: "inherit" },
  permission: "readonly",
  tools: { mode: "inherit" },
};
const empty = (): LocalToolRegistry => ({
  definitions: [],
  execute: async () => {
    throw new Error("Unexpected tool");
  },
  dispose: async () => {},
});
async function harness(options: HarnessOptions = {}) {
  const service = await createHarness({
    stateDir: join(directory, "state"),
    providerFactory: () => ({
      listModels: async () => ["fixture"],
      complete: async () => ({
        message: { role: "assistant", content: "done" },
      }),
    }),
    toolFactory: empty,
    ...options,
  });
  services.push(service);
  await service.updateSettings({
    settings: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: "fixture",
      defaultPermission: "unrestricted",
    },
  });
  await service.updateSettings({
    agent: { type: "save", profile, expectedRevision: 0 },
  });
  return service;
}
const run = (service: HarnessService, sessionId: SessionId) =>
  service.run(
    { sessionId, prompt: "work", permission: "unrestricted" },
    () => {},
    async () => false,
    new AbortController().signal,
  );

it("creates a top-level session with a frozen profile and the existing worktree path", async () => {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: "pipe",
    })
      .toString()
      .trim();
  git("init", "-q");
  await writeFile(join(workspace, "tracked.txt"), "committed");
  git("add", "tracked.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const head = git("rev-parse", "HEAD");
  await writeFile(join(workspace, "tracked.txt"), "dirty");
  const service = await harness();
  await service.updateSettings({
    source: {
      type: "save",
      source: {
        id: "profile-source",
        label: "Profile source",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "selected-model",
      },
      apiKey: "fixture-provider-secret",
    },
  });
  const saved = await service.updateSettings({
    agent: {
      type: "save",
      profile: {
        ...profile,
        model: {
          mode: "fixed",
          providerSourceId: "profile-source",
          model: "selected-model",
        },
        permission: "workspace",
        isolation: "worktree",
      },
      expectedRevision: 1,
    },
  });
  const session = await service.createSessionWithProfile({
    workspace,
    title: "Worker",
    profileId: profile.id,
    agentRole: { kind: "worker", ownerId: "owner" },
  });
  expect(session.parentSessionId).toBeUndefined();
  expect(session.agentProfile).toEqual(saved.agentProfiles?.[0]);
  expect(session).toMatchObject({
    model: "selected-model",
    providerSourceId: "profile-source",
    permissionCeiling: "workspace",
    agentRole: { kind: "worker", ownerId: "owner" },
    agentWorktree: { repository: workspace, baseRevision: head },
  });
  expect(session.workspace).toBe(session.agentWorktree?.worktree);
  expect(await readFile(join(session.workspace, "tracked.txt"), "utf8")).toBe(
    "committed",
  );
  expect(await readFile(join(workspace, "tracked.txt"), "utf8")).toBe("dirty");
  expect(JSON.stringify(session)).not.toContain("fixture-provider-secret");
  await service.updateSettings({
    agent: {
      type: "save",
      profile: { ...profile, instructions: "Updated profile" },
      expectedRevision: 2,
    },
  });
  expect((await service.getSession(session.id)).agentProfile).toEqual(
    session.agentProfile,
  );
  expect(
    (await service.listSessions()).find((item) => item.id === session.id)
      ?.agentRole,
  ).toEqual(session.agentRole);
  const inherited = await service.createSessionWithProfile({
    workspace,
    profileId: profile.id,
    isolation: "shared",
  });
  expect(inherited.workspace).toBe(workspace);
  expect(inherited.model).toBe("fixture");
  expect(inherited.agentWorktree).toBeUndefined();
  await expect(
    service.createSessionWithProfile({ workspace, profileId: "missing" }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

it("keeps role metadata immutable in both snapshot and incremental writes and rejects it from public creation", async () => {
  const service = await harness();
  const role = { kind: "router" as const, ownerId: "owner" };
  const session = await service.createSessionWithProfile({
    workspace,
    profileId: profile.id,
    agentRole: role,
  });
  role.ownerId = "changed-after-creation";
  expect(session.agentRole?.ownerId).toBe("owner");
  expect(Object.isFrozen(session.agentRole)).toBe(true);
  await expect(
    service.createSession({ workspace, agentRole: role } as never),
  ).rejects.toThrow();
  const store = await openSessionStore(join(directory, "state"));
  for (const agentRole of [
    undefined,
    { kind: "worker" as const, ownerId: "owner" },
    { kind: "router" as const, ownerId: "different" },
  ]) {
    await expect(store.save({ ...session, agentRole })).rejects.toMatchObject({
      code: "invalid_input",
    });
  }
  const versioned = await store.incremental!.read(session.id);
  const { messages, events, changes, ...metadata } = versioned.snapshot;
  await expect(
    store.incremental!.commit(session.id, {
      baseRevision: versioned.revision,
      metadata: {
        ...metadata,
        agentRole: { kind: "worker", ownerId: "owner" },
      },
      messages: { keep: messages.length, append: [] },
      events: { keep: events.length, append: [] },
      changes: { keep: changes.length, append: [] },
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  const ordinary = await service.createSession({ workspace });
  await expect(
    store.save({
      ...ordinary,
      agentRole: { kind: "router", ownerId: "owner" },
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await service.renameSession(session.id, "Renamed");
  expect((await service.getSession(session.id)).agentRole).toEqual({
    kind: "router",
    ownerId: "owner",
  });
});

it.each(["workspace", "readonly"] as const)(
  "merges host tools per session and enforces the %s ceiling",
  async (ceiling) => {
    const permissions: { name: string; permission: Permission }[] = [];
    const disposed: string[] = [];
    const registry = (name: string): LocalToolRegistry => ({
      definitions: [defineTool(name, name, z.object({}).strict())],
      execute: async (_call, context) => {
        permissions.push({ name, permission: context.permission });
        return { content: name, isError: false };
      },
      dispose: async () => {
        disposed.push(name);
      },
    });
    const seen: string[][] = [];
    const calls = new Map<string, number>();
    const sessionTools = vi.fn<NonNullable<HarnessOptions["sessionTools"]>>(
      (session) => (session.agentRole ? registry("host_tool") : undefined),
    );
    const service = await harness({
      toolFactory: () => registry("base_tool"),
      sessionTools,
      providerFactory: () => ({
        listModels: async () => [],
        complete: async (_messages, tools, options) => {
          const step = calls.get(options.sessionId!) ?? 0;
          calls.set(options.sessionId!, step + 1);
          if (step > 0)
            return { message: { role: "assistant", content: "done" } };
          const names = tools.map((tool) => tool.function.name);
          seen.push(names);
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: names
                .filter((name) => ["base_tool", "host_tool"].includes(name))
                .map((name) => ({
                  id: name,
                  type: "function",
                  function: { name, arguments: "{}" },
                })),
            },
          };
        },
      }),
    });
    await service.updateSettings({
      agent: {
        type: "save",
        profile: { ...profile, permission: ceiling },
        expectedRevision: 1,
      },
    });
    const session = await service.createSessionWithProfile({
      workspace,
      title: "Tools",
      profileId: profile.id,
      agentRole: { kind: "worker", ownerId: "owner" },
    });
    const result = await run(service, session.id);
    expect(result.status).toBe("completed");
    expect(seen[0]).toEqual(
      expect.arrayContaining(["base_tool", "host_tool", "history_read"]),
    );
    if (ceiling === "readonly") {
      expect(permissions).toEqual([]);
      expect(
        result.messages
          .filter((message) => message.role === "tool")
          .every((message) =>
            message.content?.includes("Core readonly policy denies"),
          ),
      ).toBe(true);
    } else
      expect(permissions).toEqual([
        { name: "base_tool", permission: "workspace" },
        { name: "host_tool", permission: "workspace" },
      ]);
    expect(disposed.sort()).toEqual(["base_tool", "host_tool"]);
    const ordinary = await service.createSession({
      workspace,
      title: "Ordinary",
    });
    await run(service, ordinary.id);
    expect(seen[1]).not.toContain("host_tool");
    expect(sessionTools.mock.calls.map(([snapshot]) => snapshot.id)).toEqual([
      session.id,
      ordinary.id,
    ]);
  },
);

it.each(["allowed", "denied", "absent"] as const)(
  "enforces %s host authorization for cross-session history_read",
  async (authorization) => {
    const allowed = vi.fn<NonNullable<HarnessOptions["canReadSession"]>>(
      async (reader, target) =>
        reader.agentRole?.ownerId === "owner" &&
        target === targetId &&
        authorization === "allowed",
    );
    let step = 0;
    const service = await harness({
      ...(authorization === "absent" ? {} : { canReadSession: allowed }),
      providerFactory: () => ({
        listModels: async () => [],
        complete: async () => {
          if (step++ > 0)
            return { message: { role: "assistant", content: "done" } };
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "read",
                  type: "function",
                  function: {
                    name: "history_read",
                    arguments: JSON.stringify({
                      sessionId: targetId,
                      id: "m1",
                    }),
                  },
                },
              ],
            },
          };
        },
      }),
    });
    const target = await service.createSession({ workspace, title: "Target" });
    const targetId = target.id;
    const store = await openSessionStore(join(directory, "state"));
    await store.save({
      ...target,
      messages: [{ role: "user", content: "Target history content" }],
    });
    const reader = await service.createSessionWithProfile({
      workspace,
      title: "Reader",
      profileId: profile.id,
      agentRole: { kind: "router", ownerId: "owner" },
    });
    const result = await run(service, reader.id);
    const tool = result.messages.find((message) => message.role === "tool");
    if (authorization === "allowed")
      expect(tool?.content).toContain("Target history content");
    else {
      expect(tool?.content).toContain("not authorized");
      expect(JSON.stringify(result)).not.toContain("Target history content");
    }
    expect(allowed).toHaveBeenCalledTimes(authorization === "absent" ? 0 : 1);
  },
);

it("retains local worktree failure classification on profile session creation", async () => {
  const store = await openSessionStore(join(directory, "state"));
  const failure = new ForgeError("tool", "Fixture worktree failure");
  await expect(
    createSessionWithProfile(
      {
        store,
        settings: {
          ...defaultPublicSettings,
          model: "fixture",
          agentProfiles: [{ ...profile, revision: 1, permission: "workspace" }],
        },
        agentWorktrees: {
          create: async () => {
            throw failure;
          },
        },
      },
      { workspace, profileId: profile.id, isolation: "worktree" },
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  expect(await store.list()).toMatchObject([
    { status: "failed", agentProfileId: profile.id },
  ]);
});
