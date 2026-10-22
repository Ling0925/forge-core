import { describe, expect, it } from "vitest";
import { createApprovalQueue } from "../../src/core/approval-queue";
import {
  executeReadBatch,
  executeToolCall,
  planReadBatch,
} from "../../src/core/tool-executor";
import type { LocalToolRegistry } from "../../src/shared/contracts";
import {
  type ApprovalRequest,
  type ToolCall,
  type Usage,
  sessionIdSchema,
} from "../../src/shared/schemas";
import type { ToolHookService } from "../../src/shared/tool-hooks";

const sessionId = sessionIdSchema.parse("12345678-1234-4234-8234-123456789abc");
const call: ToolCall = {
  id: "call",
  type: "function",
  function: { name: "write_file", arguments: "{}" },
};
const request: ApprovalRequest = {
  id: sessionId,
  sessionId,
  toolCallId: call.id,
  toolName: call.function.name,
  description: "fixture",
};
function latch() {
  let release = () => {};
  const work = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { work, release };
}
function options(execute: LocalToolRegistry["execute"]) {
  return {
    call,
    sessionId,
    workspace: "/fixture",
    tools: { definitions: [], execute, dispose: async () => {} },
    signal: new AbortController().signal,
    permission: () => "unrestricted" as const,
    check: () => {},
    checkpointApproval: async (_status: "running" | "awaiting_approval") => {},
    requestApproval: async () => true,
    diagnostics: () => {},
  };
}

describe("tool execution ownership", () => {
  it("joins checkpoint cleanup even if an adapter throws synchronously after requesting approval", async () => {
    const cleanup = latch();
    const entered = latch();
    const order: string[] = [];
    let settled = false;
    const work = executeToolCall({
      ...options((_call, context) => {
        void context.approve(request, context.signal).catch(() => {});
        throw new Error("adapter failed");
      }),
      checkpointApproval: async (status) => {
        order.push(status);
        if (status === "running") {
          entered.release();
          await cleanup.work;
          order.push("cleanup finished");
        }
      },
    }).catch((error) => {
      settled = true;
      return error;
    });
    await entered.work;
    expect(settled).toBe(false);
    cleanup.release();
    expect(await work).toMatchObject({ message: "adapter failed" });
    expect(order).toEqual(["awaiting_approval", "running", "cleanup finished"]);
  });

  it("returns result before the coordinator explicitly invokes post-commit hooks", async () => {
    const order: string[] = [];
    const hooks: ToolHookService = {
      configured: true,
      hookCount: 1,
      beforeTool: async () => {
        order.push("gate");
        return { allowed: true, diagnostics: [] };
      },
      afterTool: async () => {
        order.push("after");
        return [];
      },
      toolError: async () => [],
      runEnd: async () => [],
      dispose: async () => {},
    };
    const executed = await executeToolCall({
      ...options(async () => {
        order.push("execute");
        return { content: "ok", isError: false };
      }),
      hooks,
    });
    expect(order).toEqual(["gate", "execute"]);
    expect(executed.result).toEqual({ content: "ok", isError: false });
    order.push("commit");
    await executed.afterCommit?.();
    expect(order).toEqual(["gate", "execute", "commit", "after"]);
  });

  it("keeps the root approval slot serial and recovers after a rejected handler", async () => {
    const queue = createApprovalQueue();
    const entered = latch();
    const release = latch();
    const order: number[] = [];
    const first = queue
      .enqueue(async () => {
        order.push(1);
        entered.release();
        await release.work;
        throw new Error("failed");
      })
      .catch(() => false);
    const second = queue.enqueue(() => {
      order.push(2);
      return true;
    });
    await entered.work;
    expect(order).toEqual([1]);
    release.release();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(order).toEqual([1, 2]);
  });
});

it("forwards reported and missing auxiliary usage through serial tool execution", async () => {
  const usage: Usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
  const observed: (Usage | undefined)[] = [];
  await executeToolCall({
    ...options(async (_call, context) => {
      context.onModelUsage?.(usage);
      context.onModelUsage?.(undefined);
      return { content: "done", isError: false };
    }),
    onModelUsage: (value) => observed.push(value),
  });
  expect(observed).toEqual([usage, undefined]);
});

it("preserves readonly memory-read admission and usage observers in concurrent batches", async () => {
  const calls = ["get_memory", "search_memory"].map((name, i) => ({
    ...call,
    id: `read-${i}`,
    function: { name, arguments: "{}" },
  }));
  const usage: Usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
  const observed: (Usage | undefined)[] = [];
  const tools: LocalToolRegistry = {
    definitions: [],
    isConcurrencySafe: () => true,
    dispose: async () => {},
    execute: async (_call, context) => {
      context.onModelUsage?.(usage);
      return { content: "memory", isError: false };
    },
  };
  const planned = planReadBatch(calls, 0, {
    hasHooks: false,
    permission: () => "readonly",
    tools,
  });
  expect(planned).toEqual(calls);
  const result = await executeReadBatch(planned, {
    tools,
    sessionId,
    workspace: "/fixture",
    permission: () => "readonly",
    signal: new AbortController().signal,
    onModelUsage: (value) => observed.push(value),
  });
  expect(result.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(observed).toEqual([usage, usage]);
});
