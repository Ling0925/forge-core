import { describe, expect, it } from "vitest";
import type { ChildOperation } from "../../src/core/agent-operations";
import { createAgentSupervisor } from "../../src/core/agent-supervisor";
import { createApprovalQueue } from "../../src/core/approval-queue";
import type { AgentRuntimeDependencies } from "../../src/shared/contracts";
import {
  defaultPublicSettings,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";

const snapshot = sessionSnapshotSchema.parse({
  version: 1,
  id: "12345678-1234-4234-8234-123456789abc",
  title: "child",
  workspace: "/fixture",
  model: "fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "completed",
  messages: [{ role: "assistant", content: "child result" }],
  events: [],
  changes: [],
});
function fixture(dispose = async () => {}) {
  const deps: AgentRuntimeDependencies = {
    settings: defaultPublicSettings,
    tools: {
      definitions: [],
      execute: async () => ({ content: "ok", isError: false }),
      dispose,
    },
    provider: {
      listModels: async () => [],
      complete: async () => ({ message: { role: "assistant", content: "ok" } }),
    },
    store: {
      list: async () => [],
      get: async () => snapshot,
      create: async () => snapshot,
      save: async () => {},
      acquire: async () => async () => {},
    },
  };
  return createAgentSupervisor({
    deps,
    parentSessionId: snapshot.id,
    parentModel: () => "fixture",
    signal: new AbortController().signal,
    approvalQueue: createApprovalQueue(),
    approve: async () => false,
    emitUpdate: () => {},
    emitApproval: () => {},
    createRuntime: () => ({ run: async () => snapshot }),
  });
}
const child = (work = Promise.resolve(snapshot)): ChildOperation => ({
  controller: new AbortController(),
  work,
  model: "fixture",
  active: false,
  acceptingMessages: false,
  delivered: false,
  writePaths: [],
  messages: [],
  result: snapshot,
});

describe("child supervision boundaries", () => {
  it("retains report delivery until the coordinator confirms its durable commit", async () => {
    const supervisor = fixture();
    const operation = child();
    supervisor.native.children.set(snapshot.id, operation);
    const first = await supervisor.joinPending();
    expect(JSON.parse(first?.reports ?? "[]")[0]).toMatchObject({
      id: snapshot.id,
      summary: "child result",
    });
    expect(operation.delivered).toBe(false);
    // A failed parent save may request the same report again; no evidence is lost.
    expect((await supervisor.joinPending())?.reports).toBe(first?.reports);
    first?.commitDelivery();
    expect(await supervisor.joinPending()).toBeUndefined();
  });

  it("shrinks metadata-heavy pages and commits delivery only for the IDs actually returned", async () => {
    const supervisor = fixture();
    for (let i = 0; i < 65; i++) {
      const operation = child();
      operation.result = { ...snapshot, workspace: `/${"界".repeat(4000)}`, model: `fixture-${i}` };
      supervisor.native.children.set(`child-${i}`, operation);
    }
    const delivered = new Set<string>();
    while (true) {
      const page = await supervisor.joinPending();
      if (!page) break;
      expect(Buffer.byteLength(page.reports)).toBeLessThanOrEqual(65536);
      const reports = JSON.parse(page.reports) as { model: string }[];
      expect(reports.length).toBeGreaterThan(0);
      expect(reports.length).toBeLessThanOrEqual(32);
      expect(delivered.size + reports.length).toBeLessThanOrEqual(65);
      for (const report of reports) {
        expect(delivered.has(report.model)).toBe(false);
        delivered.add(report.model);
      }
      page.commitDelivery();
      expect(supervisor.operations().filter(item => item.delivered)).toHaveLength(delivered.size);
    }
    expect(delivered.size).toBe(65);
  });

  it("aborts owned children but joins their cleanup before parent settlement", async () => {
    const supervisor = fixture();
    let release = () => {};
    const operation = child(
      new Promise((resolve) => {
        release = () => resolve(snapshot);
      }),
    );
    operation.executionError = true;
    supervisor.native.children.set(snapshot.id, operation);
    let settled = false;
    const result = supervisor.settle(true).then((value) => {
      settled = true;
      return value;
    });
    expect(operation.controller.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await result).toEqual({
      snapshots: [snapshot],
      unhandledFailure: true,
    });
  });

  it("never disposes borrowed parent tools after a child runtime returns", async () => {
    let disposals = 0;
    const supervisor = fixture(async () => {
      disposals++;
    });
    await supervisor.native.runChild(
      { sessionId: snapshot.id, prompt: "fixture" },
      async () => false,
      new AbortController().signal,
    );
    expect(disposals).toBe(0);
  });
});
