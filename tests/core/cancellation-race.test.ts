import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { openRunMemory } from "../../src/core/run-memory";
import { createRuntimeHub } from "../../src/host/runtime";
import type { RunEvent } from "../../src/shared";
import { openSessionStore } from "../../src/store";

vi.mock("../../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store")>();
  return { ...actual, openSessionStore: vi.fn(actual.openSessionStore) };
});
vi.mock("../../src/core/run-memory", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/run-memory")>();
  return { ...actual, openRunMemory: vi.fn(actual.openRunMemory) };
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => vi.unstubAllEnvs());

it.each([
  "tool",
  "approval",
  "terminal-save",
  "after-terminal-save",
  "memory",
  "teardown",
] as const)(
  "keeps snapshot, terminal event and queue outcome consistent when cancelled during %s",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "forge-cancel-race-"));
    const stateDir = join(directory, "state");
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    vi.stubEnv("FORGE_HOME", stateDir);
    for (const name of ["FORGE_MODEL", "FORGE_BASE_URL", "FORGE_API_KEY"])
      vi.stubEnv(name, undefined);
    const entered = deferred();
    const release = deferred();
    const block = async () => {
      entered.resolve();
      await release.promise;
    };
    const store = await openSessionStore(stateDir);
    vi.mocked(openSessionStore).mockResolvedValueOnce(store);
    const commit = store.incremental!.commit;
    vi.spyOn(store.incremental!, "commit").mockImplementation(
      async (id, mutation) => {
        const terminal = mutation.metadata.status === "completed";
        if (terminal && phase === "terminal-save") await block();
        const result = await commit(id, mutation);
        if (terminal && phase === "after-terminal-save") await block();
        return result;
      },
    );
    const memory = await openRunMemory(stateDir);
    vi.mocked(openRunMemory).mockResolvedValueOnce(memory);
    if (phase === "memory") {
      const record = memory.record;
      vi.spyOn(memory, "record").mockImplementation(async (snapshot) => {
        await block();
        await record(snapshot);
      });
    }
    const effects = vi.fn();
    const disposed = vi.fn();
    const approvalId = randomUUID();
    let generated = false;
    const harness = await createHarness({
      stateDir,
      providerFactory: () => ({
        listModels: async () => ["fixture"],
        complete: async () => {
          if (!generated && (phase === "tool" || phase === "approval")) {
            generated = true;
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "effect",
                    type: "function",
                    function: { name: "inspect", arguments: "{}" },
                  },
                ],
              },
            };
          }
          return { message: { role: "assistant", content: "done" } };
        },
      }),
      toolFactory: () => ({
        definitions: [
          {
            type: "function",
            function: {
              name: "inspect",
              description: "Fixture effect",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        execute: async (_call, context) => {
          if (phase === "approval") {
            const approved = await context.approve(
              {
                id: approvalId,
                sessionId: context.sessionId,
                toolCallId: context.toolCallId,
                toolName: "inspect",
                description: "Approve fixture effect",
              },
              context.signal,
            );
            await release.promise;
            if (approved) effects();
          } else {
            effects();
            await block();
          }
          return { content: "effect settled", isError: false };
        },
        dispose: async () => {
          if (phase === "teardown") await block();
          disposed();
        },
      }),
    });
    const hub = createRuntimeHub(harness);
    const events: RunEvent[] = [];
    hub.subscribe((message) => {
      if (message.kind !== "event" || !("event" in message.data)) return;
      events.push(message.data);
      if (message.data.event.type === "approval_requested") entered.resolve();
    });
    try {
      await harness.updateSettings({
        settings: { model: "fixture", baseUrl: "http://provider.invalid/v1" },
      });
      const session = await harness.createSession({
        workspace,
        title: "Cancellation race",
      });
      const queue = harness.inputQueue!;
      const inputId = randomUUID();
      await queue.enqueue({
        inputId,
        input: { sessionId: session.id, prompt: "work" },
      });
      await entered.promise;
      const runId = hub.hostState().runs[0]!.runId;
      const expected =
        phase === "tool" || phase === "approval" ? "cancelled" : "completed";
      expect((await harness.getSession(session.id)).status).toBe(
        phase === "after-terminal-save" ||
          phase === "memory" ||
          phase === "teardown"
          ? "completed"
          : phase === "approval"
            ? "awaiting_approval"
            : "running",
      );
      const answered = vi.fn();
      const cancel = hub
        .request({ id: randomUUID(), method: "cancelRun", runId, wait: true })
        .then((response) => {
          answered();
          return response;
        });
      await vi.waitFor(() =>
        expect(hub.hostState().runs[0]?.stopping).toBe(true),
      );
      expect(answered).not.toHaveBeenCalled();
      expect(disposed).not.toHaveBeenCalled();
      expect(
        events.filter(({ event }) => event.type === "run_finished"),
      ).toEqual([]);
      release.resolve();
      expect(await cancel).toMatchObject({ ok: true, result: null });
      expect(disposed).toHaveBeenCalledOnce();
      const snapshot = await harness.getSession(session.id);
      expect(snapshot.status).toBe(expected);
      const terminal = snapshot.events.filter(
        (event) => event.type === "run_finished",
      );
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ status: expected });
      expect(
        events.filter(({ event }) => event.type === "run_finished"),
      ).toEqual([{ runId, event: terminal[0] }]);
      await vi.waitFor(async () => {
        const receipts = await Promise.all(
          (await readdir(join(stateDir, "input-queue/receipts"))).map(
            async (file) =>
              JSON.parse(
                await readFile(
                  join(stateDir, "input-queue/receipts", file),
                  "utf8",
                ),
              ),
          ),
        );
        expect(receipts.find((item) => item.inputId === inputId)).toMatchObject(
          {
            state: "consumed",
            outcome: expected,
          },
        );
      });
      expect((await queue.list(session.id)).paused).toBe(
        expected === "cancelled",
      );
      if (phase === "tool") expect(effects).toHaveBeenCalledOnce();
      if (phase === "approval") {
        expect(effects).not.toHaveBeenCalled();
        expect(
          await hub.request({
            id: randomUUID(),
            method: "answerApproval",
            runId,
            approvalId,
            approved: true,
          }),
        ).toMatchObject({ ok: false, error: { code: "not_found" } });
      }
      const unlock = await store.acquire(session.id);
      await unlock();
    } finally {
      release.resolve();
      await hub.dispose();
      await harness.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
