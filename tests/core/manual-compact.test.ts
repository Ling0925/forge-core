import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { projectSummary } from "../../src/core/context";
import { measureContext } from "../../src/shared/context-usage";
import type { ModelProvider } from "../../src/shared/contracts";
import { sessionSnapshotSchema, type Message } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { createPersistentUsageCache } from "../../src/renderer/state/persistent-usage-cache";

it.each([false, true])("manual compaction refreshes persisted context usage without resetting totals (fallback=%s)", async fallback => {
  const directory = await mkdtemp(join(tmpdir(), "forge-manual-compact-"));
  const complete = vi.fn<ModelProvider["complete"]>(async () => ({ message: {
    role: "assistant", content: fallback ? "invalid JSON" : JSON.stringify({
      goal: "continue", constraints: [], decisions: [], completed: [], nextSteps: [], verification: [], uncertainties: [],
    }),
  } }));
  const service = await createHarness({ stateDir: join(directory, "state"), providerFactory: () => ({ complete, listModels: async () => [] }) });
  try {
    await service.updateSettings({ settings: { baseUrl: "http://localhost:1234/v1", model: "fixture", modelContextWindows: { fixture: 100000 } } });
    const session = await service.createSession({ workspace: directory });
    const messages: Message[] = [
      { role: "system", content: "system instructions" },
      { role: "user", content: "archived evidence ".repeat(10000) },
      { role: "assistant", content: "done" },
    ];
    const projected = measureContext(messages, 100000);
    const base = { sessionId: session.id, timestamp: session.updatedAt };
    const before = sessionSnapshotSchema.parse({ ...session, status: "completed", messages, events: [
      { ...base, type: "context_usage", usage: { ...projected, usedTokens: projected.usedTokens + 1000, parts: { ...projected.parts, tools: 1000 } } },
      { ...base, type: "context_usage", usage: { ...projected, basis: "request-with-output", promptTokens: 50000, completionTokens: 100, cachedPromptTokens: 40000 } },
      { ...base, type: "run_finished", status: "completed", turns: 1, toolCalls: 0, usageComplete: true, usage: { promptTokens: 50000, completionTokens: 100, totalTokens: 50100 } },
    ] });
    const store = await openSessionStore(join(directory, "state"));
    await store.save(before);
    let cacheValue: string | null = null;
    const cache = createPersistentUsageCache(() => ({ getItem: () => cacheValue, setItem: (_key, value) => { cacheValue = value; } }));
    const oldUsage = cache.snapshot(before).usage;
    const result = await service.compactSession(session.id);
    expect(result.contextSummary?.fallback).toBe(fallback);
    expect(result.messages).toEqual(messages);
    expect(result.events.slice(-2).map(event => event.type)).toEqual(["context_compacted", "context_usage"]);
    const usage = cache.snapshot(result).usage;
    expect(usage.context?.usedTokens).toBeLessThan(oldUsage.context!.usedTokens / 2);
    expect(usage.context).toMatchObject({ basis: "projected", estimated: true, windowTokens: 100000, budgetTokens: 80000 });
    expect(usage.context?.parts.tools).toBe(1000);
    expect(usage.context?.usedTokens).toBe(measureContext(projectSummary(result), 100000).usedTokens + 1000);
    expect(usage.total).toEqual(oldUsage.total);
    expect(usage.latestCache).toBe(oldUsage.latestCache);
    const reopened = await service.getSession(session.id);
    expect(cache.snapshot(reopened).usage).toEqual(usage);
    // No new history: do not issue another summary request or duplicate events.
    const again = await service.compactSession(session.id);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(again.events).toEqual(result.events);
    // An older build saved the summary but left the old request meter behind.
    await store.save({ ...result, events: before.events });
    const repaired = await service.compactSession(session.id);
    expect(cache.snapshot(repaired).usage.context).toEqual(usage.context);
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
