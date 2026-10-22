import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRootRunBudget } from "../../src/core/run-budget";
import { rootBudgetSnapshotSchema } from "../../src/shared/run-budget";

describe("unlimited root run ledger", () => {
  it("records all concurrent child attempts without a shared admission ceiling", async () => {
    const budget = createRootRunBudget({ rootSessionId: randomUUID() });
    try {
      const ids = Array.from({ length: 4 }, () => randomUUID());
      for (const id of ids) budget.enter(id);
      const attempts = await Promise.all(ids.map(async (id) => budget.reserve(id, 2)));
      expect(budget.snapshot()).toMatchObject({ consumed: 0, reserved: 8, remaining: null });
      for (const attempt of attempts) {
        attempt.dispatch(2);
        attempt.release();
      }
      expect(budget.snapshot()).toMatchObject({ consumed: 8, reserved: 0, remaining: null });
      expect(budget.snapshot().sessions.reduce((sum, item) => sum + item.consumed, 0)).toBe(8);
      expect(() => budget.checkAdmission()).not.toThrow();
    } finally {
      budget.close();
    }
  });

  it("releases only undispatched reservations and never refunds dispatched attempts", () => {
    const id = randomUUID();
    const budget = createRootRunBudget({ rootSessionId: id });
    try {
      budget.enter(id);
      const first = budget.reserve(id, 3);
      first.dispatch();
      first.release();
      first.release();
      expect(budget.snapshot()).toMatchObject({ consumed: 1, reserved: 0, remaining: null });
      expect(() => first.dispatch()).toThrow("already consumed");
      const next = budget.reserve(id, 1_000_001);
      next.dispatch(1_000_001);
      next.release();
      expect(budget.snapshot()).toMatchObject({ consumed: 1_000_002, reserved: 0, remaining: null });
      expect(() => budget.checkAdmission()).not.toThrow();
    } finally {
      budget.close();
    }
  });

  it("has no elapsed-time timer, but still forbids closed or restarted ledgers", async () => {
    vi.useFakeTimers();
    const id = randomUUID();
    const budget = createRootRunBudget({ rootSessionId: id });
    try {
      budget.enter(id);
      expect(() => budget.enter(id)).toThrow("cannot restart");
      const reservation = budget.reserve(id, 2);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
      reservation.dispatch(2);
      reservation.release();
      expect(() => budget.checkAdmission()).not.toThrow();
      expect(budget.snapshot()).toMatchObject({
        consumed: 2, reserved: 0, stopReason: null,
        maxToolCalls: null, timeoutMs: null, deadlineAt: null, remaining: null,
      });
      budget.close();
      expect(() => budget.check()).toThrow("cannot be resumed");
      expect(() => budget.reserve(id, 1)).toThrow("cannot be resumed");
    } finally {
      budget.close();
      vi.useRealTimers();
    }
  });

  it("admits more than 32 child sessions and serializes unlimited and historical snapshots", () => {
    const root = randomUUID();
    const budget = createRootRunBudget({ rootSessionId: root });
    try {
      budget.enter(root);
      const ids = Array.from({ length: 65 }, () => randomUUID());
      for (const id of ids) budget.enter(id);
      const snapshot = budget.snapshot();
      expect(snapshot.sessions).toHaveLength(66);
      expect(budget.snapshot(ids[0]).sessions).toHaveLength(1);
      expect(rootBudgetSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
      const historical = { ...snapshot, sessions: snapshot.sessions.slice(0, 33),
        maxToolCalls: 2000, timeoutMs: 7200000, deadlineAt: "2026-01-01T02:00:00.000Z",
        remaining: 1999, consumed: 1, stopReason: "deadline" };
      expect(rootBudgetSnapshotSchema.parse(historical)).toEqual(historical);
    } finally {
      budget.close();
    }
  });

  it("leaves pending auxiliary usage incomplete at close without double-counting a later response", () => {
    const root = randomUUID();
    const budget = createRootRunBudget({ rootSessionId: root });
    budget.enter(root);
    const first = budget.beginUsage(root);
    expect(budget.snapshot().usage).toMatchObject({ missingRequests: 1, complete: false });
    first({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    first({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(budget.snapshot().usage).toMatchObject({
      reportedRequests: 1, missingRequests: 0, complete: true, totalTokens: 3,
    });
    const late = budget.beginUsage(root);
    const terminal = budget.snapshot();
    budget.close();
    late({ promptTokens: 5, completionTokens: 5, totalTokens: 10 });
    budget.finishSession(root, "failed", "late");
    expect(budget.snapshot()).toEqual(terminal);
    expect(terminal.usage).toMatchObject({
      reportedRequests: 1, missingRequests: 1, complete: false, totalTokens: 3,
    });
  });

  it("keeps real usage observations and missing requests explicit, without estimated hard caps", () => {
    const root = randomUUID();
    const child = randomUUID();
    const budget = createRootRunBudget({ rootSessionId: root });
    try {
      budget.enter(root);
      budget.enter(child);
      budget.observeUsage(root, {
        promptTokens: 4, completionTokens: 2, totalTokens: 6, cachedPromptTokens: 1,
      });
      budget.observeUsage(child, undefined);
      const snapshot = budget.snapshot();
      expect(snapshot.usage).toEqual({
        basis: "reported", reportedRequests: 1, missingRequests: 1, complete: false,
        promptTokens: 4, completionTokens: 2, totalTokens: 6, cachedPromptTokens: 1,
      });
      const row = snapshot.sessions[0];
      if (!row) throw Error("missing observation");
      row.consumed = 99;
      expect(budget.snapshot().consumed).toBe(0);
      expect(budget.snapshot().sessions[0]?.consumed).toBe(0);
    } finally {
      budget.close();
    }
  });
});
