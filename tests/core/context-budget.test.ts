import { describe, expect, it } from "vitest";
import { projectSummary, summarize, summaryBoundary } from "../../src/core/context";
import { compactContext } from "../../src/core/runtime";
import { measureContext, resolveContextBudget } from "../../src/shared/context-usage";
import { defaultPublicSettings, sessionSnapshotSchema, type Message } from "../../src/shared/schemas";
import type { ModelProvider } from "../../src/shared/contracts";

const snapshot = (messages: Message[]) => sessionSnapshotSchema.parse({
  version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "test",
  workspace: "/workspace", model: "test", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", status: "idle", messages, events: [], changes: [],
});
const provider = (complete: ModelProvider["complete"]): ModelProvider => ({ listModels: async () => [], complete });

describe("adaptive context budget", () => {
  it("uses 80% of known windows with headroom, not the legacy char limit", () => {
    expect(resolveContextBudget(128000, defaultPublicSettings)).toEqual({ unit: "tokens", limit: 102400, target: 76800 });
    expect(resolveContextBudget(null, defaultPublicSettings)).toEqual({ unit: "chars", limit: 100000, target: 75000 });
    expect(resolveContextBudget(128000, { ...defaultPublicSettings, contextBudgetTokens: 64000 })).toEqual({ unit: "tokens", limit: 64000, target: 48000 });
    expect(resolveContextBudget(null, { ...defaultPublicSettings, contextBudgetTokens: 64000 }).unit).toBe("tokens");
    expect(resolveContextBudget(8000, { ...defaultPublicSettings, contextBudgetTokens: 64000 }).limit).toBe(6400);
    const messages: Message[] = [{ role: "user", content: "x".repeat(150000) }];
    const size = (m: readonly Message[]) => measureContext(m, 128000).usedTokens;
    expect(compactContext(messages, 102400, size).messages).toEqual(messages);
  });
  it("retains at least three human turns and excludes reconciliation boundaries", () => {
    const messages: Message[] = [{ role: "system", content: "rules" }];
    for (let i = 0; i < 7; i++) messages.push({ role: "user", content: `request-${i}` }, { role: "assistant", content: "x".repeat(8000) });
    messages.splice(7, 0, { role: "user", origin: "agent_reconciliation", content: "child" });
    const s = snapshot(messages);
    const boundary = summaryBoundary(s, m => JSON.stringify(m).length, 10000)!;
    expect(messages[boundary]?.content).toBe("request-4");
    expect(messages.slice(boundary).filter(m => m.role === "user")).toHaveLength(3);
    const early = summaryBoundary(s, m => JSON.stringify(m).length, 60000)!;
    expect(early).toBeLessThan(boundary);
    expect(summaryBoundary(snapshot(messages.slice(0, 5)), m => JSON.stringify(m).length, 1)).toBeNull();
  });
  it("merges old memory with new history only, without altering the log", async () => {
    const s = { ...snapshot([
      { role: "system", content: "rules" }, { role: "user", content: "OLD_RAW_MUST_NOT_REAPPEAR" },
      { role: "assistant", content: "done" }, { role: "user", content: "NEW_WORK" },
      { role: "assistant", content: "verified" }, { role: "user", content: "current" },
    ]), contextSummary: { boundary: 3, content: "PREVIOUS_MEMORY", fallback: false } };
    let calls = 0;
    const result = await summarize(s, provider(async (messages, tools) => {
      calls++;
      expect(tools).toEqual([]);
      expect(messages[1]?.content).toContain("PREVIOUS_MEMORY");
      expect(messages[1]?.content).toContain("NEW_WORK");
      expect(messages[1]?.content).not.toContain("OLD_RAW_MUST_NOT_REAPPEAR");
      return { message: { role: "assistant", content: "merged" } };
    }), new AbortController().signal, 5);
    expect(calls).toBe(1);
    expect(result.messages).toBe(s.messages);
    expect(projectSummary(result).at(-1)?.content).toBe("current");
    expect(projectSummary(result)[0]?.content).toBe("rules");
  });
  it("bounds each summary request and incrementally merges chunks", async () => {
    let calls = 0;
    const s = snapshot([{ role: "user", content: "中".repeat(18000) }]);
    const result = await summarize(s, provider(async messages => {
      expect(measureContext(messages, 8000).usedTokens).toBeLessThan(6400);
      if (calls > 0) expect(messages[1]?.content).toContain(`memory-${calls}`);
      calls++;
      return { message: { role: "assistant", content: `memory-${calls}` } };
    }), new AbortController().signal, 1, 6400);
    expect(calls).toBeGreaterThan(1);
    expect(result.contextSummary?.fallback).toBe(false);
  });
  it("keeps previous memory on failure and aborts without committing partial memory", async () => {
    const s = { ...snapshot([{ role: "user", content: "old" }, { role: "assistant", content: "done" }, { role: "user", content: "new" }]), contextSummary: { content: "IMPORTANT_OLD_CONSTRAINT", boundary: 2, fallback: false } };
    const failed = await summarize(s, provider(async () => { throw Error("offline"); }), new AbortController().signal, 3);
    expect(failed.contextSummary?.fallback).toBe(true);
    expect(failed.contextSummary?.content).toContain("IMPORTANT_OLD_CONSTRAINT");
    expect(failed.contextSummary?.content).toContain("new");
    const abort = new AbortController(); abort.abort();
    let calls = 0;
    await expect(summarize(s, provider(async () => { calls++; throw Error(); }), abort.signal, 3)).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
  });
});
