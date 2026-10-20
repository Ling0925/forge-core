import { describe, expect, it } from "vitest";
import {
  type SessionSnapshot,
  sessionIdSchema,
} from "../../src/shared/schemas";
import { applySessionDelta } from "../../src/shared/session-delta";
import { SessionDeltaCache } from "../../src/web/session-delta";

const snapshot: SessionSnapshot = {
  version: 1,
  id: sessionIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  workspace: "/tmp/test",
  title: "test",
  model: "fixture",
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  messages: [{ role: "user", content: "old history".repeat(10000) }],
  events: [],
  changes: [],
};
describe("session delta transport", () => {
  it("transfers only new records and preserves the old history", () => {
    const cache = new SessionDeltaCache();
    const first = cache.encode(snapshot);
    const next: SessionSnapshot = {
      ...snapshot,
      messages: [
        ...snapshot.messages,
        { role: "assistant", content: "new output" },
      ],
    };
    const update = cache.encode(next, first.revision);
    expect(update.delta?.snapshot.messages).toEqual([next.messages[1]]);
    if (!update.delta) throw new Error("Expected delta");
    expect(JSON.stringify(update.delta).length).toBeLessThan(1000);
    expect(applySessionDelta(snapshot, first.revision, update.delta)).toEqual(
      next,
    );
    const unchanged = cache.encode(next, update.revision);
    expect(unchanged.delta?.snapshot.messages).toEqual([]);
  });
  it("replaces rewritten or shortened history instead of blindly appending", () => {
    for (const messages of [
      [],
      [{ role: "user" as const, content: "compacted" }],
    ]) {
      const cache = new SessionDeltaCache();
      const first = cache.encode(snapshot);
      const next = { ...snapshot, messages };
      const update = cache.encode(next, first.revision);
      if (!update.delta) throw new Error("Expected delta");
      expect(applySessionDelta(snapshot, first.revision, update.delta)).toEqual(
        next,
      );
    }
  });
  it("keeps a stable content revision when multiple clients alternate reads", () => {
    const cache = new SessionDeltaCache();
    const a1 = cache.encode(snapshot);
    const a2 = cache.encode(snapshot, a1.revision);
    const b1 = cache.encode(snapshot);
    for (const base of [a2.revision, b1.revision, a1.revision]) {
      const result = cache.encode(snapshot, base);
      expect(result.revision).toBe(a1.revision);
      expect(result.delta?.snapshot.messages).toEqual([]);
      if (!result.delta) throw new Error("Expected delta");
      expect(applySessionDelta(snapshot, base, result.delta)).toEqual(snapshot);
    }
  });
  it("supports clients at different retained versions, including metadata-only updates", () => {
    const cache = new SessionDeltaCache();
    const first = cache.encode(snapshot);
    const renamed = {
      ...snapshot,
      title: "renamed",
      status: "running" as const,
    };
    const second = cache.encode(renamed, first.revision);
    expect(second.revision).not.toBe(first.revision);
    const next: SessionSnapshot = {
      ...renamed,
      messages: [
        ...snapshot.messages,
        { role: "assistant", content: "new output" },
      ],
      changes: [{ path: "test.txt", kind: "created" }],
    };
    for (const [previous, base] of [
      [snapshot, first.revision],
      [renamed, second.revision],
    ] as const) {
      const result = cache.encode(next, base);
      if (!result.delta) throw new Error("Expected delta");
      expect(applySessionDelta(previous, base, result.delta)).toEqual(next);
    }
  });
  it("reconstructs metadata removal and replacement or truncation of every record array", () => {
    const cache = new SessionDeltaCache();
    const previous: SessionSnapshot = {
      ...snapshot,
      archived: true,
      titleSource: "user",
      events: [
        {
          type: "state_changed",
          sessionId: snapshot.id,
          timestamp: snapshot.updatedAt,
          status: "running",
        },
      ],
      changes: [{ path: "before.txt", kind: "modified" }],
    };
    const first = cache.encode(previous);
    const next: SessionSnapshot = {
      ...snapshot,
      messages: [],
      events: [],
      changes: [{ path: "after.txt", kind: "created" }],
    };
    const result = cache.encode(next, first.revision);
    if (!result.delta) throw new Error("Expected delta");
    expect(applySessionDelta(previous, first.revision, result.delta)).toEqual(
      next,
    );
  });
  it("falls back after version eviction, invalid bases, cross-session bases, and restart", () => {
    const cache = new SessionDeltaCache({ maxVersionsPerSession: 2 });
    const first = cache.encode(snapshot);
    cache.encode({ ...snapshot, title: "second" });
    const next = { ...snapshot, title: "third" };
    const latest = cache.encode(next);
    expect(cache.encode(next, first.revision).delta).toBeNull();
    expect(cache.encode(next, "invalid").delta).toBeNull();
    const other = {
      ...snapshot,
      id: sessionIdSchema.parse("22222222-2222-4222-8222-222222222222"),
    };
    expect(cache.encode(other, latest.revision).delta).toBeNull();
    expect(
      new SessionDeltaCache().encode(next, latest.revision).delta,
    ).toBeNull();
  });
  it("bounds sessions by least recent use without evicting an active client", () => {
    const cache = new SessionDeltaCache({ maxSessions: 2 });
    const other = (n: number) => ({
      ...snapshot,
      id: sessionIdSchema.parse(
        `${n}${"0".repeat(7)}-0000-4000-8000-000000000000`,
      ),
    });
    const a = cache.encode(snapshot);
    const b = cache.encode(other(2));
    cache.encode(snapshot, a.revision);
    cache.encode(other(3));
    expect(cache.encode(snapshot, a.revision).delta).not.toBeNull();
    expect(cache.encode(other(2), b.revision).delta).toBeNull();
  });
  it("bounds total retained fingerprints across sessions and versions", () => {
    const cache = new SessionDeltaCache({ maxFingerprints: 6 });
    // Each version contains one message hash plus one metadata hash.
    const first = cache.encode(snapshot);
    const second = cache.encode({ ...snapshot, title: "second" });
    const other = {
      ...snapshot,
      id: sessionIdSchema.parse("22222222-2222-4222-8222-222222222222"),
    };
    const otherVersion = cache.encode(other);
    cache.encode({ ...snapshot, title: "third" });
    const next = { ...snapshot, title: "fourth" };
    cache.encode(next);
    expect(cache.encode(next, first.revision).delta).toBeNull();
    expect(cache.encode(next, second.revision).delta).not.toBeNull();
    expect(cache.encode(other, otherVersion.revision).delta).toBeNull();
    const oversized = {
      ...snapshot,
      messages: Array.from({ length: 7 }, () => ({
        role: "user" as const,
        content: "record",
      })),
    };
    const uncached = cache.encode(oversized);
    expect(cache.encode(oversized, uncached.revision).delta).toBeNull();
  });
  it("rejects invalid cache limits and mismatched application bases", () => {
    for (const maxFingerprints of [0, -1, Number.NaN, 1.5]) {
      expect(() => new SessionDeltaCache({ maxFingerprints })).toThrow();
    }
    const cache = new SessionDeltaCache();
    const first = cache.encode(snapshot);
    const result = cache.encode(snapshot, first.revision);
    if (!result.delta) throw new Error("Expected delta");
    expect(() => applySessionDelta(snapshot, "invalid", result.delta)).toThrow(
      "revision mismatch",
    );
  });
});
