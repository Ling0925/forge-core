import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildRunMemory, openRunMemory } from "../../src/core/run-memory";
import { createAgentRuntime } from "../../src/core/runtime";
import { projectSummary } from "../../src/core/context";
import { measureContext } from "../../src/shared/context-usage";
import type { ModelProvider, SessionStore } from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import { defaultPublicSettings, sessionSnapshotSchema, type SessionSnapshot } from "../../src/shared/schemas";

const original = sessionSnapshotSchema.parse({
  version: 1, id: "11111111-1111-4111-8111-111111111111", workspace: "/tmp", title: "test", model: "fixture", status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [{ role: "system", content: "rules" }, { role: "user", content: "preserve user files" },
    { role: "assistant", content: "old details ".repeat(16000) }, { role: "user", content: "finish tests" }, { role: "assistant", content: "latest report: test failure remains" }],
  changes: [], events: [{ type: "run_finished", sessionId: "11111111-1111-4111-8111-111111111111", timestamp: "2026-01-01T00:00:00.000Z", status: "completed", turns: 1, toolCalls: 0 }],
  plan: { explanation: "waiting for a fix", steps: [{ step: "fix failed test", status: "in_progress" }] },
});

it("persists a local checkpoint without changing warm context and restores long cold sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-run-memory-"));
  try {
    const memory = await openRunMemory(directory);
    await memory.record(original);
    const saved = JSON.parse(await readFile(join(directory, "session-memory", `${original.id}.json`), "utf8"));
    expect(saved.content).toContain("fix failed test");
    expect(saved.content).toContain("test failure remains");
    expect(saved.content).toContain("preserve user files");
    expect(saved.content.length).toBeLessThanOrEqual(8192);
    expect(await memory.restore(original, "2026-01-01T00:30:00.000Z")).toBe(original);
    const reopened = await openRunMemory(directory);
    const restored = await reopened.restore(original, "2026-01-02T00:00:00.000Z");
    expect(restored.messages).toBe(original.messages);
    expect(restored.contextSummary?.content).toBe(saved.content);
    expect(measureContext(projectSummary(restored), null).usedTokens).toBeLessThan(12000);
    const changed = { ...original, messages: [...original.messages, { role: "assistant" as const, content: "newer actual report" }] };
    expect((await reopened.restore(changed, "2026-01-02T00:00:00.000Z")).contextSummary?.content).toContain("newer actual report");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("runs the finish hook and resumes without an additional summary provider call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-run-memory-runtime-"));
  try {
    const memory = await openRunMemory(directory);
    let stored: SessionSnapshot = original;
    const store: SessionStore = { get: async () => stored, list: async () => [], create: async () => stored,
      save: async value => { stored = value; }, acquire: async () => async () => {} };
    const complete = vi.fn<ModelProvider["complete"]>(async messages => {
      expect(JSON.stringify(messages)).not.toContain("old details ".repeat(100));
      expect(JSON.stringify(messages)).toContain("fix failed test");
      return { message: { role: "assistant", content: "New final report" } };
    });
    const runtime = createAgentRuntime({ store, runMemory: memory, provider: { complete, listModels: async () => [] }, settings: defaultPublicSettings,
      tools: { definitions: [], execute: async () => ({ content: "unused", isError: true }), dispose: async () => {} }, now: () => "2026-01-02T00:00:00.000Z" });
    const result = await runtime.run({ sessionId: original.id, prompt: "continue", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(complete).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(await readFile(join(directory, "session-memory", `${original.id}.json`), "utf8"));
    expect(saved.content).toContain("New final report");
    expect(result.messages.slice(0, original.messages.length)).toEqual(original.messages);
    complete.mockImplementationOnce(async () => { throw new ForgeError("cancelled", "Fixture cancellation"); });
    const cancelled = await runtime.run({ sessionId: original.id, prompt: "next attempt", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
    expect(cancelled.status).toBe("cancelled");
    expect(complete).toHaveBeenCalledTimes(2);
    const cancelledMemory = JSON.parse(await readFile(join(directory, "session-memory", `${original.id}.json`), "utf8"));
    expect(cancelledMemory.content).toContain('"effectsMayBeUncertain":true');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("records failed and cancelled outcomes as uncertain rather than successful work", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const snapshot = { ...original, status, events: [{ type: "run_finished" as const, sessionId: original.id, timestamp: original.updatedAt, status, turns: 1, toolCalls: 0 }] };
    const record = buildRunMemory(snapshot);
    expect(record?.content).toContain(`"status":"${status}"`);
    expect(record?.content).toContain('"effectsMayBeUncertain":true');
  }
});
