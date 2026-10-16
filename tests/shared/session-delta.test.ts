import { describe, expect, it } from "vitest";
import { sessionIdSchema, type SessionSnapshot } from "../../src/shared/schemas";
import { applySessionDelta } from "../../src/shared/session-delta";
import { SessionDeltaCache } from "../../src/web/session-delta";

const snapshot: SessionSnapshot = {
  version: 1, id: sessionIdSchema.parse("11111111-1111-4111-8111-111111111111"),
  workspace: "/tmp/test", title: "test", model: "fixture", status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
  messages: [{ role: "user", content: "old history".repeat(10000) }], events: [], changes: [],
};
describe("session delta transport", () => {
  it("transfers only new records and preserves the old history", () => {
    const cache = new SessionDeltaCache();
    const first = cache.encode(snapshot);
    const next: SessionSnapshot = { ...snapshot, messages: [...snapshot.messages, { role: "assistant", content: "new output" }] };
    const update = cache.encode(next, first.revision);
    expect(update.delta?.snapshot.messages).toEqual([next.messages[1]]);
    if (!update.delta) throw new Error("Expected delta");
    expect(JSON.stringify(update.delta).length).toBeLessThan(1000);
    expect(applySessionDelta(snapshot, first.revision, update.delta)).toEqual(next);
    const unchanged = cache.encode(next, update.revision);
    expect(unchanged.delta?.snapshot.messages).toEqual([]);
  });
  it("replaces rewritten or shortened history instead of blindly appending", () => {
    for (const messages of [[], [{ role: "user" as const, content: "compacted" }]]) {
      const cache = new SessionDeltaCache();
      const first = cache.encode(snapshot);
      const next = { ...snapshot, messages };
      const update = cache.encode(next, first.revision);
      if (!update.delta) throw new Error("Expected delta");
      expect(applySessionDelta(snapshot, first.revision, update.delta)).toEqual(next);
    }
  });
  it("falls back to a full snapshot after a revision is evicted or replaced", () => {
    const cache = new SessionDeltaCache();
    const first = cache.encode(snapshot);
    cache.encode(snapshot, first.revision);
    expect(cache.encode(snapshot, first.revision).delta).toBeNull();
    expect(new SessionDeltaCache().encode(snapshot, first.revision).delta).toBeNull();
  });
});
