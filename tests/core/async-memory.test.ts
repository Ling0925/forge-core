import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createWorkerController } from "../../src/host/controller";
import type { HarnessService, ModelProvider } from "../../src/shared/contracts";
import type { WorkerMessage } from "../../src/shared/ipc";
import type {
  Message,
  ProviderResponse,
  SessionId,
} from "../../src/shared/schemas";
import { openMemoryStore } from "../../src/store/memory";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };
const answer = (content: string): ProviderResponse => ({
  message: { role: "assistant", content },
  usage,
});
const call = (name: string, args: object): ProviderResponse => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
  usage,
});
const toolValue = (messages: readonly Message[]) => {
  const last = messages.findLast((message) => message.role === "tool");
  return JSON.parse(JSON.parse(last?.content ?? "{}").content);
};
let home: string;
let workspace: string;
let harness: HarnessService;
let controller: ReturnType<typeof createWorkerController>;
let sent: WorkerMessage[];
let sessionId: SessionId;
let synthesis: ReturnType<typeof deferred>;
let requests: number;
const getInputQueue = () => {
  if (!harness.inputQueue) throw new Error("Expected the host input queue.");
  return harness.inputQueue;
};
async function setup(complete: ModelProvider["complete"]) {
  harness = await createHarness({
    stateDir: home,
    providerFactory: () => ({
      listModels: async () => ["fixture-model"],
      complete,
    }),
  });
  await harness.updateSettings({
    apiKey: "fixture-only-key",
    settings: { model: "fixture-model", baseUrl: "https://example.test/v1" },
  });
  const session = await harness.createSession({
    workspace,
    title: "Async integration fixture",
  });
  sessionId = session.id;
  controller = createWorkerController(harness, (message) => sent.push(message));
  return session.id;
}
const finished = () =>
  sent.filter(
    (message) =>
      message.kind === "event" && message.data.event.type === "run_finished",
  );
const startRun = async (
  prompt = "forge 用户明确要求整理长期约定，其他工作可以并行",
  permission = "unrestricted",
) => {
  await controller.handle({
    id: randomUUID(),
    method: "startRun",
    input: { sessionId, prompt, permission },
  });
};
const infer = async (
  messages: readonly Message[],
): Promise<ProviderResponse> => {
  requests++;
  await synthesis.promise;
  const content = messages[1]?.content;
  if (!content) throw new Error("Expected synthesis evidence input.");
  const ref = JSON.parse(content).evidence[0].ref;
  return {
    message: {
      role: "assistant",
      content: JSON.stringify({
        memories: [
          {
            tags: ["forge"],
            summary: "forge 约定",
            details: "已明确的长期约定。",
            refs: [ref],
          },
        ],
      }),
    },
    usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
  };
};
const receipts = async () => {
  const files = (await readdir(join(home, "async-tasks"))).filter((file) =>
    file.endsWith(".json"),
  );
  return Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(join(home, "async-tasks", file), "utf8")),
    ),
  );
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "forge-async-memory-home-"));
  workspace = await mkdtemp(join(tmpdir(), "forge-async-memory-workspace-"));
  synthesis = deferred();
  requests = 0;
  sent = [];
});
afterEach(async () => {
  await controller?.dispose();
  synthesis.resolve();
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("async memory through the real harness and host queue", () => {
  it.each([false, true])(
    "continues independent work and wakes exactly once (completion while busy=%s)",
    async (busy) => {
      const independent = deferred();
      let turns = 0;
      let id = "";
      await setup(async (messages, tools) => {
        if (!tools.length) return infer(messages);
        turns++;
        if (turns === 1)
          return call("forge_memory", {
            query: "forge",
            keywords: ["forge"],
            background: true,
          });
        if (turns === 2) {
          id = toolValue(messages).id;
          if (busy) await independent.promise;
          return answer("其他工作已完成，记忆任务仍在后台。");
        }
        if (turns === 3) {
          const notice = messages.findLast(
            (message) => message.role === "user",
          );
          expect(notice).toMatchObject({
            origin: "agent_reconciliation",
            content: expect.stringContaining(id),
          });
          expect(
            tools.some((tool) => tool.function.name === "async_task"),
          ).toBe(true);
          return call("async_task", { action: "read", id });
        }
        expect(toolValue(messages)).toMatchObject({
          status: "completed",
          usage: { totalTokens: 55 },
          usageComplete: true,
        });
        expect(JSON.parse(toolValue(messages).output).content.created).toEqual([
          0,
        ]);
        return answer("后台记忆已完成，新增 1 条。");
      });
      await startRun();
      await vi.waitFor(() => expect(id).not.toBe(""));
      expect(requests).toBe(1);
      if (busy) {
        synthesis.resolve();
        await vi.waitFor(async () =>
          expect((await getInputQueue().list(sessionId)).items).toHaveLength(1),
        );
        expect(finished()).toHaveLength(0);
        expect(turns).toBe(2);
        independent.resolve();
      } else {
        await vi.waitFor(() => expect(finished()).toHaveLength(1));
        expect((await receipts())[0].status).toBe("running");
        synthesis.resolve();
      }
      await vi.waitFor(() => expect(finished()).toHaveLength(2));
      const queue = await getInputQueue().list(sessionId);
      await vi.waitFor(async () =>
        expect((await getInputQueue().list(sessionId)).items[0]?.state).toBe(
          "consumed",
        ),
      );
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]?.origin).toBe("background_task");
      expect(turns).toBe(4);
      expect(requests).toBe(1);
      for (const message of finished())
        if (message.kind === "event")
          expect(message.data.event).toMatchObject({
            status: "completed",
            usage: { totalTokens: 24 },
            usageComplete: true,
          });
      const memories = await openMemoryStore(home);
      try {
        expect((await memories.get(0))?.summary).toBe("forge 约定");
      } finally {
        await memories.close();
      }
    },
  );

  it("a later readonly run revokes pending writes but can read the async failure notification", async () => {
    let turns = 0;
    let id = "";
    await setup(async (messages, tools) => {
      if (!tools.length) return infer(messages);
      turns++;
      if (turns === 1)
        return call("forge_memory", { query: "forge", background: true });
      if (turns === 2) {
        id = toolValue(messages).id;
        return answer("任务已提交。");
      }
      if (turns === 3) return answer("只读检查已完成。");
      if (turns === 4) return call("async_task", { action: "read", id });
      expect(toolValue(messages)).toMatchObject({
        status: "failed",
        resultIsError: true,
      });
      return answer("后台合成未写入：权限已变为只读。");
    });
    await startRun();
    await vi.waitFor(() => expect(finished()).toHaveLength(1));
    await startRun("现在只允许只读检查", "readonly");
    await vi.waitFor(() => expect(finished()).toHaveLength(2));
    synthesis.resolve();
    await vi.waitFor(() => expect(finished()).toHaveLength(3));
    const started = sent
      .filter(
        (message) =>
          message.kind === "event" && message.data.event.type === "run_started",
      )
      .at(-1);
    if (started?.kind === "event")
      expect(started.data.event).toMatchObject({ permission: "readonly" });
    const memories = await openMemoryStore(home);
    try {
      expect(await memories.get(0)).toBeUndefined();
    } finally {
      await memories.close();
    }
    expect(requests).toBe(1);
  });

  it("persists an in-flight permission downgrade before a later completion wake", async () => {
    const independent = deferred();
    let turns = 0;
    let id = "";
    await setup(async (messages, tools) => {
      if (!tools.length) return infer(messages);
      turns++;
      if (turns === 1)
        return call("forge_memory", { query: "forge", background: true });
      if (turns === 2) {
        id = toolValue(messages).id;
        await independent.promise;
        return answer("主工作已结束。");
      }
      if (turns === 3) return call("async_task", { action: "read", id });
      expect(toolValue(messages)).toMatchObject({ status: "failed" });
      return answer("权限收紧，未写入记忆。");
    });
    await startRun();
    await vi.waitFor(() => expect(id).not.toBe(""));
    const run = controller.hostState().runs[0];
    if (!run) throw new Error("Expected an active run.");
    const runId = run.runId;
    const requestId = randomUUID();
    await controller.handle({
      id: requestId,
      method: "setRunPermission",
      runId,
      permission: "readonly",
    });
    expect(
      sent.find(
        (message) =>
          message.kind === "response" && message.response.id === requestId,
      ),
    ).toMatchObject({
      response: { ok: true, result: "readonly" },
    });
    independent.resolve();
    await vi.waitFor(() => expect(finished()).toHaveLength(1));
    expect(
      (await harness.getSession(sessionId)).events.findLast(
        (event) => event.type === "permission_changed",
      ),
    ).toMatchObject({ permission: "readonly" });
    synthesis.resolve();
    await vi.waitFor(() => expect(finished()).toHaveLength(2));
    const started = sent
      .filter(
        (message) =>
          message.kind === "event" && message.data.event.type === "run_started",
      )
      .at(-1);
    if (started?.kind === "event")
      expect(started.data.event).toMatchObject({ permission: "readonly" });
    expect((await receipts())[0].status).toBe("failed");
  });

  it("cancels an idle session's background inference, joins it and never wakes or writes", async () => {
    let turns = 0;
    await setup(async (messages, tools) => {
      if (!tools.length) return infer(messages);
      return ++turns === 1
        ? call("forge_memory", { query: "forge", background: true })
        : answer("任务已提交。");
    });
    await startRun();
    await vi.waitFor(() => expect(finished()).toHaveLength(1));
    expect(await harness.cancelSession(sessionId)).toBe(true);
    expect((await receipts())[0]).toMatchObject({
      status: "cancelled",
      notification: "suppressed",
      usageComplete: false,
    });
    synthesis.resolve();
    expect((await getInputQueue().list(sessionId)).items).toEqual([]);
    const memories = await openMemoryStore(home);
    try {
      expect(await memories.get(0)).toBeUndefined();
    } finally {
      await memories.close();
    }
    expect(turns).toBe(2);
  });

  it("rejects host permission changes after terminal permission has been frozen", async () => {
    const frozen = deferred();
    const finish = deferred();
    await setup(async () => answer("unused"));
    vi.spyOn(harness, "run").mockImplementation(
      async (_input, _event, _approve, _signal, control) => {
        control?.onFinalizing?.();
        frozen.resolve();
        await finish.promise;
        return {
          ...(await harness.getSession(sessionId)),
          status: "completed",
        };
      },
    );
    try {
      await startRun();
      await frozen.promise;
      const run = controller.hostState().runs[0];
      if (!run) throw new Error("Expected an active run.");
      const runId = run.runId;
      const id = randomUUID();
      await controller.handle({
        id,
        method: "setRunPermission",
        runId,
        permission: "unrestricted",
      });
      expect(
        sent.find(
          (message) =>
            message.kind === "response" && message.response.id === id,
        ),
      ).toMatchObject({
        response: { ok: false, error: { code: "not_found" } },
      });
    } finally {
      finish.resolve();
    }
    await vi.waitFor(() => expect(finished()).toHaveLength(1));
  });

  it("transfers a child's async tool to the host and wakes its main session after both runs finish", async () => {
    let rootTurns = 0;
    let childTurns = 0;
    let id = "";
    let child: string | undefined;
    await setup(async (messages, tools, options) => {
      if (!tools.length) return infer(messages);
      if (options.sessionId !== sessionId) {
        child = options.sessionId;
        return ++childTurns === 1
          ? call("forge_memory", { query: "forge", background: true })
          : answer("子任务已提交异步记忆整理。");
      }
      rootTurns++;
      const notice = messages.findLast((message) => message.role === "user");
      if (notice?.content?.startsWith("Background task")) {
        if (messages.at(-1)?.role === "tool") {
          expect(toolValue(messages)).toMatchObject({
            sessionId: child,
            wakeSessionId: sessionId,
            status: "completed",
          });
          return answer("子任务的后台结果已读取。");
        }
        return call("async_task", { action: "read", id });
      }
      if (rootTurns === 1)
        return call("spawn_agent", {
          task: "forge 整理约定，使用后台记忆任务",
          model: "fixture-model",
        });
      return answer("子代理已完成提交，主会话无需等待后台推理。");
    });
    await startRun();
    await vi.waitFor(() => expect(finished()).toHaveLength(1));
    const receipt = (await receipts())[0];
    id = receipt.id;
    expect(receipt).toMatchObject({
      status: "running",
      sessionId: child,
      wakeSessionId: sessionId,
    });
    synthesis.resolve();
    await vi.waitFor(() => expect(finished()).toHaveLength(2));
    expect((await getInputQueue().list(sessionId)).items).toHaveLength(1);
    expect(childTurns).toBe(2);
    expect(requests).toBe(1);
  });
});
