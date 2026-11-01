import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type HostEvent, hostEventSchema } from "../../src/shared";
import { call, done, hold } from "./fixture";
import { payload } from "./github-fixture";
import { hostFixture } from "./host-fixture";

it("runs signed GitHub work through Router, Worker, suggestions and approved outbox over the real host", async () => {
  const routed = new Set<string>();
  const sent = new Set<string>();
  const events: HostEvent[] = [];
  const f = await hostFixture({
    providerFactory: () => ({
      listModels: async () => ["fixture"],
      complete: async (messages, tools, options) => {
        if (tools.some((tool) => tool.function.name === "superagent_route")) {
          const text = messages
            .filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n");
          for (const [id, number] of [
            [201, 1],
            [202, 2],
          ] as const) {
            const trigger = `gh:comment:${id}`;
            if (text.includes(trigger) && !routed.has(trigger)) {
              routed.add(trigger);
              return call("superagent_route", {
                decisions: [
                  {
                    type: "new",
                    threads: [`gh:owner/repo#${number}`],
                    triggers: [trigger],
                    brief: `Investigate ${number}`,
                  },
                ],
              });
            }
          }
        }
        if (
          tools.some((tool) => tool.function.name === "superagent_send") &&
          !sent.has(options.sessionId!)
        ) {
          sent.add(options.sessionId!);
          return call("superagent_send", {
            kind: "comment",
            target: { thread: "gh:owner/repo#1" },
            body: { text: "Investigation ready" },
          });
        }
        return done;
      },
    }),
  });
  const socket = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/events?clientId=${f.auth["X-Forge-Client"]}&cursor=0`,
    { headers: f.auth },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("message", (data) => {
        const batch = JSON.parse(data.toString());
        events.push(
          ...batch.events.map((event: unknown) => hostEventSchema.parse(event)),
        );
        socket.send(JSON.stringify({ cursor: batch.cursor }));
        resolve();
      });
    });
    expect((await f.send(payload, "unsigned", false)).status).toBe(401);
    expect(await f.rpc({ method: "listSuperAgentTriggers" })).toMatchObject({
      ok: true,
      result: [],
    });
    expect((await f.send(payload, "signed")).status).toBe(202);
    expect((await f.send(payload, "signed")).status).toBe(409);
    await vi.waitFor(
      async () => {
        expect(await f.rpc({ method: "listWorkItems" })).toMatchObject({
          ok: true,
          result: [{ status: "running", workerSessionId: expect.any(String) }],
        });
        expect(
          await f.rpc({ method: "listOutbox", state: "pending" }),
        ).toMatchObject({
          ok: true,
          result: [{ kind: "comment", state: "pending" }],
        });
      },
      { timeout: 15000 },
    );
    const works = await f.rpc({ method: "listWorkItems" });
    if (!works.ok || works.method !== "listWorkItems")
      throw new Error("Missing work items");
    const worker = (await f.harness.listSessions()).find(
      (session) => session.id === works.result[0]!.workerSessionId,
    )!;
    expect(worker.agentRole?.kind).toBe("worker");
    expect(worker.workspace).not.toBe(f.workspace);
    expect(worker.originWorkspace).toBe(f.workspace);
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            "event" in event &&
            event.event.type === "run_started" &&
            event.event.sessionId === worker.id,
        ),
      ).toBe(true),
    );
    expect(f.outbox.execute).not.toHaveBeenCalled();
    const outbox = await f.rpc({ method: "listOutbox" });
    if (!outbox.ok || outbox.method !== "listOutbox")
      throw new Error("Missing outbox");
    expect(
      await f.rpc({
        method: "decideOutbox",
        outboxId: outbox.result[0]!.id,
        approve: true,
      }),
    ).toMatchObject({ ok: true, result: { state: "sent" } });
    expect(f.outbox.execute).toHaveBeenCalledOnce();
    expect(
      await f.rpc({
        method: "decideOutbox",
        outboxId: outbox.result[0]!.id,
        approve: true,
      }),
    ).toMatchObject({ ok: false });
    expect(f.outbox.execute).toHaveBeenCalledOnce();
    const nonExplicit = {
      ...payload,
      issue: { ...payload.issue, id: 102, number: 2 },
      comment: { ...payload.comment, id: 202, body: "A useful improvement" },
    };
    expect((await f.send(nonExplicit)).status).toBe(202);
    await vi.waitFor(
      async () =>
        expect(
          await f.rpc({ method: "listSuggestions", state: "pending" }),
        ).toMatchObject({
          ok: true,
          result: [{ state: "pending", triggerIds: ["gh:comment:202"] }],
        }),
      { timeout: 15000 },
    );
    expect(await f.rpc({ method: "listWorkItems" })).toMatchObject({
      ok: true,
      result: [expect.any(Object)],
    });
    const suggestions = await f.rpc({ method: "listSuggestions" });
    if (!suggestions.ok || suggestions.method !== "listSuggestions")
      throw new Error("Missing suggestions");
    expect(
      await f.rpc({
        method: "decideSuggestion",
        suggestionId: suggestions.result[0]!.id,
        accept: true,
      }),
    ).toMatchObject({
      ok: true,
      result: { state: "accepted", workId: expect.any(String) },
    });
    await vi.waitFor(
      async () => {
        const result = await f.rpc({ method: "listWorkItems" });
        expect(
          result.ok &&
            result.method === "listWorkItems" &&
            result.result.filter((work) => work.workerSessionId),
        ).toHaveLength(2);
        expect(sent.size).toBe(2);
      },
      { timeout: 15000 },
    );
    expect(f.outbox.execute).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      for (const type of [
        "superagent_trigger",
        "superagent_work",
        "superagent_suggestion",
        "superagent_outbox",
      ])
        expect(
          events.some((event) => "type" in event && event.type === type),
        ).toBe(true);
    });
  } finally {
    socket.terminate();
    await f.close();
  }
}, 45000);

it("carries queued and steered delivery metadata through the real host", async () => {
  let routed = false;
  const gate = hold();
  const f = await hostFixture({
    providerFactory: () => ({
      listModels: async () => ["fixture"],
      complete: async (...args) => {
        const [messages, tools] = args;
        if (
          tools.some((tool) => tool.function.name === "superagent_route") &&
          !routed
        ) {
          routed = true;
          expect(messages).toContainEqual(
            expect.objectContaining({
              role: "user",
              origin: "superagent",
              superagent: {
                kind: "route_batch",
                triggerIds: ["gh:comment:201"],
              },
            }),
          );
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
        if (tools.some((tool) => tool.function.name === "superagent_report"))
          return gate.step(...args);
        return done;
      },
    }),
  });
  try {
    expect((await f.send(payload)).status).toBe(202);
    await gate.entered;
    const works = await f.rpc({ method: "listWorkItems" });
    if (!works.ok || works.method !== "listWorkItems")
      throw new Error("Missing work items");
    const work = works.result[0]!;
    const worker = (await f.harness.listSessions()).find(
      (session) => session.id === work.workerSessionId,
    )!;
    expect((await f.harness.getSession(worker.id)).messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        origin: "superagent",
        superagent: {
          kind: "work_brief",
          workId: work.id,
          triggerIds: ["gh:comment:201"],
        },
      }),
    );
    expect(
      (
        await f.send({
          ...payload,
          comment: { ...payload.comment, id: 202, body: "More details" },
        })
      ).status,
    ).toBe(202);
    const update = expect.objectContaining({
      role: "user",
      origin: "superagent",
      superagent: {
        kind: "work_updates",
        workId: work.id,
        triggerIds: ["gh:comment:202"],
      },
    });
    await vi.waitFor(async () =>
      expect((await f.harness.getSession(worker.id)).pendingSteering).toEqual([
        update,
      ]),
    );
    gate.release();
    await vi.waitFor(async () => {
      const session = await f.harness.getSession(worker.id);
      expect(session.status).toBe("completed");
      expect(session.messages).toContainEqual(update);
    });
  } finally {
    gate.release();
    await f.close();
  }
});
