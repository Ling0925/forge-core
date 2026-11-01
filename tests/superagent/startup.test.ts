import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runtime from "../../src/host/runtime";
import { type WorkerMessage, workerMessageSchema } from "../../src/shared";
import { openSuperAgentStore } from "../../src/store";
import * as api from "../../src/superagent/github-api";
import { payload, timestamp } from "./github-fixture";
import { hostFixture } from "./host-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("applies the configured webhook body limit at host startup", async () => {
  const f = await hostFixture({
    maxBodyBytes: Buffer.byteLength(JSON.stringify(payload)) - 1,
  });
  const store = await openSuperAgentStore(join(f.directory, "state"));
  try {
    expect((await f.send(payload)).status).toBe(413);
    expect(await store.unprocessedDeliveries()).toEqual([]);
    expect(await store.listTriggers()).toEqual([]);
  } finally {
    await store.close();
    await f.close();
  }
});

it.each(["offline", "HTTP 503"])(
  "keeps the host running and reports a catch-up failure (%s) without advancing the cursor",
  async (failure) => {
    const events: WorkerMessage[] = [];
    const createRuntimeHub = runtime.createRuntimeHub;
    vi.spyOn(runtime, "createRuntimeHub").mockImplementation((...args) => {
      const host = createRuntimeHub(...args);
      host.subscribe((message) => events.push(message));
      return host;
    });
    const token = vi
      .spyOn(api, "githubToken")
      .mockResolvedValue("fixture-private-token");
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (!String(input).startsWith("https://api.github.com/"))
        return originalFetch(input, init);
      if (failure === "offline") throw new Error("private network details");
      return new Response("private error body", { status: 503 });
    });
    vi.stubGlobal("fetch", fetch);
    const f = await hostFixture({ since: timestamp });
    const store = await openSuperAgentStore(join(f.directory, "state"));
    try {
      const catchUp = {
        at: expect.any(String),
        error:
          failure === "offline"
            ? "GitHub request failed."
            : "GitHub request failed (HTTP 503).",
      };
      const state = await f.rpc({ method: "getSuperAgentState" });
      expect(state).toMatchObject({
        ok: true,
        result: { enabled: true, catchUp },
      });
      const event = events.find(
        (message) =>
          message.kind === "event" &&
          "type" in message.data &&
          message.data.type === "superagent_catch_up",
      );
      expect(workerMessageSchema.parse(event)).toMatchObject({
        kind: "event",
        data: { type: "superagent_catch_up", catchUp },
      });
      expect(await store.getCursor("github:owner/repo:since")).toBe(timestamp);
      expect((await f.send(payload)).status).toBe(202);
      await vi.waitFor(async () =>
        expect(await store.unprocessedDeliveries()).toEqual([]),
      );
      expect(await f.rpc({ method: "listSessions" })).toMatchObject({
        ok: true,
      });
      expect(token).toHaveBeenCalledOnce();
      expect(
        fetch.mock.calls.filter(([input]) =>
          String(input).startsWith("https://api.github.com/"),
        ),
      ).toHaveLength(1);
    } finally {
      await store.close();
      await f.close();
    }
  },
);
