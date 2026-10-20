import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRootRunBudget } from "../../src/core/run-budget";

describe("root run ledger", () => {
  it("atomically reserves a batch against all four simultaneous child contenders", async () => {
    const rootSessionId = randomUUID();
    const budget = createRootRunBudget({ rootSessionId, maxToolCalls: 7 });
    try {
      const ids = Array.from({ length: 4 }, () => randomUUID());
      for (const id of ids) budget.enter(id);
      const attempts = await Promise.allSettled(
        ids.map(async (id) => budget.reserve(id, 2)),
      );
      expect(
        attempts.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(3);
      expect(budget.snapshot()).toMatchObject({
        consumed: 0,
        reserved: 6,
        remaining: 1,
      });
      for (const attempt of attempts)
        if (attempt.status === "fulfilled") {
          attempt.value.dispatch(2);
          attempt.value.release();
        }
      expect(budget.snapshot()).toMatchObject({
        consumed: 6,
        reserved: 0,
        remaining: 1,
      });
      expect(
        budget
          .snapshot()
          .sessions.reduce((sum, item) => sum + item.consumed, 0),
      ).toBe(6);
    } finally {
      budget.close();
    }
  });

  it("returns only undispatched reservations; failure or repeated release cannot refund attempts", () => {
    const id = randomUUID();
    const budget = createRootRunBudget({ rootSessionId: id, maxToolCalls: 4 });
    try {
      budget.enter(id);
      const first = budget.reserve(id, 3);
      first.dispatch();
      first.release();
      first.release();
      expect(budget.snapshot()).toMatchObject({
        consumed: 1,
        reserved: 0,
        remaining: 3,
      });
      expect(() => first.dispatch()).toThrow("already consumed");
      const next = budget.reserve(id, 3);
      next.dispatch(3);
      next.release();
      expect(() => budget.reserve(id, 1)).toThrow("exhausted");
      expect(budget.snapshot()).toMatchObject({
        consumed: 4,
        reserved: 0,
        remaining: 0,
      });
    } finally {
      budget.close();
    }
  });

  it("checks the monotonic deadline before dispatch and forbids closed/restarted ledgers", () => {
    let time = 0;
    const id = randomUUID();
    const budget = createRootRunBudget({
      rootSessionId: id,
      maxToolCalls: 4,
      timeoutMs: 1000,
      clock: () => time,
    });
    budget.enter(id);
    expect(() => budget.enter(id)).toThrow("cannot restart");
    const reservation = budget.reserve(id, 2);
    time = 1000;
    expect(() => reservation.dispatch(2)).toThrow("deadline");
    reservation.release();
    expect(budget.signal.aborted).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      consumed: 0,
      reserved: 0,
      stopReason: "deadline",
    });
    budget.close();
    expect(() => budget.check()).toThrow("cannot be resumed");
  });

  it("fires the deadline signal without another admission check", async () => {
    vi.useFakeTimers();
    const budget = createRootRunBudget({
      rootSessionId: randomUUID(),
      maxToolCalls: 4,
      timeoutMs: 1000,
    });
    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(budget.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(budget.signal.aborted).toBe(true);
      expect(budget.stopReason).toBe("deadline");
    } finally {
      budget.close();
      vi.useRealTimers();
    }
  });

  it("leaves pending auxiliary usage incomplete at close without double-counting a later response", () => {
    const root = randomUUID();
    const budget = createRootRunBudget({
      rootSessionId: root,
      maxToolCalls: 4,
    });
    budget.enter(root);
    const first = budget.beginUsage(root);
    expect(budget.snapshot().usage).toMatchObject({
      missingRequests: 1,
      complete: false,
    });
    first({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    first({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect(budget.snapshot().usage).toMatchObject({
      reportedRequests: 1,
      missingRequests: 0,
      complete: true,
      totalTokens: 3,
    });
    const late = budget.beginUsage(root);
    const terminal = budget.snapshot();
    budget.close();
    late({ promptTokens: 5, completionTokens: 5, totalTokens: 10 });
    expect(budget.snapshot()).toEqual(terminal);
    expect(terminal.usage).toMatchObject({
      reportedRequests: 1,
      missingRequests: 1,
      complete: false,
      totalTokens: 3,
    });
  });

  it("keeps real usage observations and missing requests explicit, without estimated hard caps", () => {
    const root = randomUUID();
    const child = randomUUID();
    const budget = createRootRunBudget({
      rootSessionId: root,
      maxToolCalls: 4,
    });
    try {
      budget.enter(root);
      budget.enter(child);
      budget.observeUsage(root, {
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
        cachedPromptTokens: 1,
      });
      budget.observeUsage(child, undefined);
      const snapshot = budget.snapshot();
      expect(snapshot.usage).toEqual({
        basis: "reported",
        reportedRequests: 1,
        missingRequests: 1,
        complete: false,
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
        cachedPromptTokens: 1,
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
