import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { connectLocalHost, createLocalHost } from "../../src/host";
import { type HostEvent, createTransportBridge } from "../../src/shared";
import { openSuperAgentStore } from "../../src/store";
import { call, done } from "./fixture";
import { payload } from "./github-fixture";
import { hostFixture } from "./host-fixture";

it("round-trips work controls and decisions via Web RPC and broadcasts to local transport", async () => {
  let routed = false;
  const f = await hostFixture({
    providerFactory: () => ({
      listModels: async () => ["fixture"],
      complete: async (_messages, tools) => {
        if (
          !routed &&
          tools.some((tool) => tool.function.name === "superagent_route")
        ) {
          routed = true;
          return call("superagent_route", {
            decisions: [
              {
                type: "new",
                threads: ["gh:owner/repo#1"],
                triggers: ["gh:comment:201"],
                brief: "Investigate",
              },
            ],
          });
        }
        return done;
      },
    }),
  });
  const local = await createLocalHost({
    runtime: f.runtime,
    socketPath: join(f.directory, "host.sock"),
  });
  const events: HostEvent[] = [];
  const client = await connectLocalHost({
    socketPath: local.path,
  });
  const bridge = createTransportBridge({
    request: (request) => client.request(request),
    onEvent: (listener) => {
      client.subscribe(listener);
    },
  });
  bridge.onEvent((event) => events.push(event));
  const store = await openSuperAgentStore(join(f.directory, "state"));
  try {
    expect(await f.rpc({ method: "getSuperAgentState" })).toMatchObject({
      ok: true,
      result: { enabled: true, workspace: f.workspace, routerSessionId: null },
    });
    expect(await bridge.listWorkItems!()).toEqual([]);
    expect((await f.send(payload)).status).toBe(202);
    await vi.waitFor(
      async () => {
        expect(await f.rpc({ method: "listWorkItems" })).toMatchObject({
          ok: true,
          result: [
            {
              workerSessionId: expect.any(String),
              routerSessionId: expect.any(String),
              pendingStatus: null,
            },
          ],
        });
        expect(f.runtime.hostState().runs).toEqual([]);
      },
      { timeout: 15000 },
    );
    const [work] = await store.workItems.list();
    expect(
      await f.rpc({ method: "getWorkItem", workId: work!.id }),
    ).toMatchObject({ ok: true, result: { id: work!.id } });
    expect(
      await f.rpc({
        method: "listSuperAgentTriggers",
        query: { threadIds: ["gh:owner/repo#1"] },
      }),
    ).toMatchObject({
      ok: true,
      result: [{ id: "gh:comment:201", disposition: "assigned" }],
    });
    expect(
      await f.rpc({
        method: "stopWorkItem",
        workId: work!.id,
        reason: "User stopped",
      }),
    ).toMatchObject({ ok: true, result: { status: "stopped" } });
    const resumed = await f.rpc({ method: "resumeWorkItem", workId: work!.id });
    expect(resumed, JSON.stringify(resumed)).toMatchObject({
      ok: true,
      result: { status: "running" },
    });
    const suggestion = await store.createSuggestion({
      threadIds: ["gh:owner/repo#1"],
      triggerIds: ["gh:comment:201"],
      brief: "Suggestion",
    });
    expect(
      await f.rpc({
        method: "decideSuggestion",
        suggestionId: suggestion.id,
        accept: false,
      }),
    ).toMatchObject({ ok: true, result: { state: "rejected" } });
    expect(
      await f.rpc({ method: "listSuggestions", state: "rejected" }),
    ).toMatchObject({ ok: true, result: [{ id: suggestion.id }] });
    const out = await store.createOutboxItem({
      workId: work!.id,
      kind: "comment",
      target: { thread: "gh:owner/repo#1" },
      body: { text: "Ready" },
    });
    expect(
      await f.rpc({ method: "decideOutbox", outboxId: out.id, approve: false }),
    ).toMatchObject({ ok: true, result: { state: "rejected" } });
    expect(
      await f.rpc({ method: "listOutbox", state: "rejected" }),
    ).toMatchObject({ ok: true, result: [{ id: out.id }] });
    expect(f.outbox.execute).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            "type" in event &&
            event.type === "superagent_outbox" &&
            event.item.state === "rejected",
        ),
      ).toBe(true),
    );
  } finally {
    await client.close();
    await local.close();
    await store.close();
    await f.close();
  }
}, 30000);

it("returns a clear existing error kind for every disabled RPC", async () => {
  const f = await hostFixture({ enabled: false });
  try {
    expect(f.webhook).toBeUndefined();
    for (const input of [
      { method: "getSuperAgentState" },
      { method: "listSuperAgentTriggers" },
      { method: "listWorkItems" },
      { method: "getWorkItem", workId: "missing" },
      { method: "stopWorkItem", workId: "missing", reason: "Stop" },
      { method: "resumeWorkItem", workId: "missing" },
      { method: "listSuggestions" },
      { method: "decideSuggestion", suggestionId: "missing", accept: true },
      { method: "listOutbox" },
      { method: "decideOutbox", outboxId: "missing", approve: true },
    ])
      expect(await f.rpc(input)).toMatchObject({
        ok: false,
        error: {
          code: "not_found",
          message: "Super-agent is disabled on this host.",
        },
      });
  } finally {
    await f.close();
  }
});

it.each([
  "url",
  "projectId",
  "accountable",
  "token",
  "reconnectDelay",
] as const)(
  "requires board.%s when the board backend is selected",
  async (field) => {
    const board = {
      url: "http://board.invalid",
      projectId: "project",
      accountable: "human",
      token: "private-board-token",
      reconnectDelay: 1500,
    };
    const { [field]: _missing, ...configured } = board;
    await expect(
      hostFixture({
        config: {
          enabled: true,
          workspace: ".",
          routerProfileId: "router",
          workerProfileId: "worker",
          github: {
            login: "forge-bot",
            repos: ["owner/repo"],
            webhookSecret: "fixture-secret",
            webhook: { port: 0 },
          },
          workItems: { backend: "board" },
          board: configured,
        },
      }),
    ).rejects.toThrow(`Missing required settings: superAgent.board.${field}.`);
  },
);

it("forces enablement for this host without persisting the flag", async () => {
  const f = await hostFixture({ enabled: false, force: true });
  try {
    expect(f.webhook).toBeDefined();
    expect(await f.rpc({ method: "getSuperAgentState" })).toMatchObject({
      ok: true,
      result: { enabled: true },
    });
    expect((await f.harness.getSettings()).superAgent?.enabled).toBe(false);
  } finally {
    await f.close();
  }
});

it("names missing startup settings", async () => {
  await expect(hostFixture({ config: { enabled: true } })).rejects.toThrow(
    "Missing required settings: superAgent.workspace, superAgent.routerProfileId, superAgent.workerProfileId, superAgent.github.login, superAgent.github.repos, superAgent.github.webhookSecret, superAgent.github.webhook.port.",
  );
});
