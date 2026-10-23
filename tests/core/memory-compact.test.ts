import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, SessionStore, ToolContext } from "../../src/shared/contracts";
import { forgeMemorySchema, searchMemorySchema, type ForgeMemoryInput, type MemoryStore } from "../../src/shared/memory";
import type { Message, SessionSnapshot } from "../../src/shared/schemas";
import { ProviderError } from "../../src/provider/errors";
import { openSessionStore } from "../../src/store/sessions";
import { openMemoryStore } from "../../src/store/memory";
import { forgeMemory } from "../../src/core/forge-memory";
import { memoryRetrievalLimits, retrieveMemoryEvidence } from "../../src/core/memory-retrieval";

let root: string;
let workspace: string;
let sessions: SessionStore;
let memories: MemoryStore;
let current: SessionSnapshot;
let context: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-memory-compact-"));
  workspace = await mkdtemp(join(tmpdir(), "forge-memory-compact-workspace-"));
  sessions = await openSessionStore(root);
  memories = await openMemoryStore(root);
  current = { ...await sessions.create({ workspace, title: "Memory", model: "fixture" }),
    messages: [{ role: "user", content: "forge 只编译再重开，无需安装。" }] };
  await sessions.save(current);
  context = { sessionId: current.id, toolCallId: "compact", workspace, permission: "unrestricted",
    signal: new AbortController().signal, approve: async () => false, onEvent: () => {} };
});
afterEach(async () => {
  await memories.close();
  await rm(root, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

interface Evidence {
  ref: string;
  source: { kind: "session" | "memory"; id?: number; version?: number; session?: string; record?: string };
  text: string;
  truncated: boolean;
  can_update?: boolean;
}
const payload = (messages: readonly Message[]) => JSON.parse(messages[1]!.content!) as {
  max_memories: number; evidence: Evidence[];
};
const args = (extra: Partial<ForgeMemoryInput> = {}) => forgeMemorySchema.parse({ query: "forge", keywords: ["forge"], ...extra });
const proposal = (refs: string[], extra: object = {}) => ({ tags: ["forge"], summary: "本机更新", details: "编译再重开，不安装。", refs, ...extra });
const provider = (reply: (messages: readonly Message[]) => string): ModelProvider => ({
  listModels: async () => [],
  complete: vi.fn<ModelProvider["complete"]>(async (messages, tools, options) => {
    expect(tools).toEqual([]);
    expect(options.model).toBe("fixture");
    expect(options.webSearch).toBeUndefined();
    return { message: { role: "assistant", content: reply(messages) }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  }),
});
const synthesize = (model: ModelProvider, input = args(), extra: Partial<Parameters<typeof forgeMemory>[1]> = {}) =>
  forgeMemory(input, { sessions, memories, provider: model, context, ...extra });
const retrieve = (limits?: Parameters<typeof retrieveMemoryEvidence>[0]["limits"]) =>
  retrieveMemoryEvidence({ input: args(), current, sessions, memories, signal: context.signal, ...(limits ? { limits } : {}) });

describe("compact memory evidence", () => {
  it("halves the ordinary evidence budget, reports selection loss and sends no long session IDs", async () => {
    current = { ...current, messages: Array.from({ length: 80 }, (_, index) => ({
      role: "user" as const, content: `forge observation ${index}: ${"x".repeat(1800)}`,
    })) };
    await sessions.save(current);
    const compact = await retrieve();
    const previousBudget = await retrieve({ inputChars: 48000, excerptChars: 1800 });
    expect(compact.coverage.evidenceChars).toBeLessThanOrEqual(24000);
    expect(compact.coverage.evidenceChars).toBeLessThan(previousBudget.coverage.evidenceChars * 0.6);
    expect(compact.coverage).toMatchObject({ selection_truncated: true, excerpt_truncated: true, expandedMemories: 0 });
    const model = provider(messages => {
      const input = payload(messages);
      expect(input.max_memories).toBe(4);
      expect(input.evidence.map(item => item.ref)).toEqual(input.evidence.map((_, index) => `E${index + 1}`));
      expect(messages[1]!.content).not.toContain(current.id);
      expect(messages[1]!.content!.length).toBeLessThan(26000);
      expect(messages[0]!.content).toContain("at most 4 memories");
      expect(messages[0]!.content).toContain("details under 1200 characters");
      return '{"memories":[]}';
    });
    const result = await synthesize(model);
    expect(result).toMatchObject({ max_memories: 4, synthesis: { modelRequests: 1, proposals: 0 } });
    expect(model.complete).toHaveBeenCalledOnce();
  });

  it("deduplicates only identical records in the same session, preserving roles, origins and other sessions", async () => {
    const content = "forge fixed preference";
    current = { ...current, messages: [
      { role: "user", content }, { role: "assistant", content }, { role: "user", content },
      { role: "user", content, origin: "agent_reconciliation" },
    ] };
    await sessions.save(current);
    const other = await sessions.create({ workspace, title: "Other", model: "fixture" });
    await sessions.save({ ...other, messages: [{ role: "user", content }] });
    const result = await retrieve();
    expect(result.coverage).toMatchObject({ matchedRecords: 5, duplicateRecords: 1, selectedEvidence: 4 });
    expect(result.evidence.map(item => item.ref)).not.toContain(`s:${current.id}:m1`);
    expect(result.evidence.map(item => item.ref)).toEqual(expect.arrayContaining([
      `s:${current.id}:m2`, `s:${current.id}:m3`, `s:${current.id}:m4`, `s:${other.id}:m1`,
    ]));
  });

  it("retains session grouping and record order with compact metadata", async () => {
    current = { ...current, messages: [
      { role: "user", content: "forge old preference" }, { role: "user", content: "forge new preference" },
    ] };
    await sessions.save(current);
    const other = await sessions.create({ workspace, title: "Other", model: "fixture" });
    await sessions.save({ ...other, messages: [{ role: "user", content: "forge another session" }] });
    const model = provider(messages => {
      const evidence = payload(messages).evidence;
      const old = evidence.find(item => item.text.includes("old preference"))!;
      const recent = evidence.find(item => item.text.includes("new preference"))!;
      const foreign = evidence.find(item => item.text.includes("another session"))!;
      expect(old.source).toMatchObject({ session: "S1", record: "m1" });
      expect(recent.source).toMatchObject({ session: "S1", record: "m2" });
      expect(foreign.source).toMatchObject({ session: "S2", record: "m1" });
      expect(messages[1]!.content).not.toContain(current.id);
      expect(messages[1]!.content).not.toContain(other.id);
      return '{"memories":[]}';
    });
    await synthesize(model);
  });

  it("does not deduplicate records that only share the visible excerpt", async () => {
    current = { ...current, messages: ["first", "second"].map(tail => ({
      role: "user" as const, content: "forge " + "x".repeat(1500) + tail,
    })) };
    const result = await retrieve();
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every(item => item.truncated)).toBe(true);
    expect(result.coverage.duplicateRecords).toBe(0);
  });

  it("completes a selected 32k memory within the old input ceiling so updates preserve its tail", async () => {
    const details = "forge " + "x".repeat(31850) + " IMPORTANT_TAIL";
    const old = await memories.update({ tags: ["forge"], summary: "Long memory", details });
    const model = provider(messages => {
      const evidence = payload(messages).evidence;
      const memory = evidence.find(item => item.source.kind === "memory")!;
      expect(memory).toMatchObject({ ref: "E1", source: { id: 0, version: 1 }, can_update: true, truncated: false });
      expect(JSON.parse(memory.text).details).toBe(details);
      return JSON.stringify({ memories: [proposal(evidence.map(item => item.ref), { id: old.id, details: details + " UPDATED" })] });
    });
    const result = await synthesize(model);
    expect(result.coverage.expandedMemories).toBe(1);
    expect(result.coverage.evidenceChars).toBeGreaterThan(memoryRetrievalLimits.inputChars);
    expect(result.coverage.evidenceChars).toBeLessThanOrEqual(memoryRetrievalLimits.expandedInputChars);
    expect((await memories.get(0))?.details).toBe(details + " UPDATED");
    expect((await memories.get(0))?.version).toBe(2);
  });

  it("keeps over-budget old memories explicitly read-only and rejects the whole batch on an attempted update", async () => {
    for (let index = 0; index < 4; index++)
      await memories.update({ tags: ["forge"], summary: `Long ${index}`, details: "forge " + "x".repeat(31900) });
    const model = provider(messages => {
      const evidence = payload(messages).evidence;
      const partial = evidence.find(item => item.source.kind === "memory" && item.truncated)!;
      expect(partial).toBeDefined();
      expect(partial.can_update).toBe(false);
      return JSON.stringify({ memories: [proposal([evidence[0]!.ref]), proposal([partial.ref], { id: partial.source.id })] });
    });
    await expect(synthesize(model)).rejects.toThrow(/reason=incomplete_update, proposal=2/);
    const stored = await memories.search(searchMemorySchema.parse({}));
    expect(stored.total).toBe(4);
    expect(stored.hits.every(item => item.version === 1)).toBe(true);
    const retrieved = await retrieve();
    expect(retrieved.coverage.evidenceChars).toBeLessThanOrEqual(48000);
    expect(retrieved.coverage.excerpt_truncated).toBe(true);
  });

  it("never spends the expansion reserve on additional conversation records", async () => {
    current = { ...current, messages: Array.from({ length: 60 }, (_, index) => ({
      role: "user" as const, content: `forge ${index} ${"x".repeat(1500)}`,
    })) };
    const retrieved = await retrieve({ inputChars: 4000, expandedInputChars: 48000 });
    expect(retrieved.coverage.evidenceChars).toBeLessThanOrEqual(4000);
    expect(retrieved.coverage.expandedMemories).toBe(0);
    expect(retrieved.coverage.selection_truncated).toBe(true);
  });
});

describe("bounded, source-backed synthesis output", () => {
  it("maps short aliases to real sources and deduplicates an exact canonical citation", async () => {
    const canonical = `s:${current.id}:m1`;
    const model = provider(messages => {
      expect(payload(messages).evidence[0]!.ref).toBe("E1");
      return JSON.stringify({ memories: [proposal([" E1 ", canonical, "E1"])] });
    });
    const result = await synthesize(model);
    expect(result.evidence[0]).toMatchObject({ ref: canonical, alias: "E1" });
    expect((await memories.get(0))?.sources).toEqual([{ kind: "session", sessionId: current.id, recordId: "m1" }]);
  });

  it("rejects historical nested refs and reports bounded positions without echoing model strings", async () => {
    const nested = "s:private-nested-reference:m19";
    current = { ...current, messages: [{ role: "user", content: `forge old citation ${nested}` }] };
    await sessions.save(current);
    const model = provider(() => JSON.stringify({ memories: [proposal(["E1"]), proposal([nested])] }));
    const error = await synthesize(model).catch(error => error);
    expect(error.message).toMatch(/reason=unknown_reference, proposal=2, ref_index=1/);
    expect(error.message).toMatch(/evidence_count=1, input_chars=\d+, max_memories=4/);
    expect(error.message).not.toContain(nested);
    expect(model.complete).toHaveBeenCalledOnce();
    expect(await memories.get(0)).toBeUndefined();
  });

  it.each(["E999", "e1", "1"])("never guesses an unknown reference %s", async ref => {
    const model = provider(() => JSON.stringify({ memories: [proposal([ref])] }));
    await expect(synthesize(model)).rejects.toThrow(/reason=unknown_reference/);
    expect(await memories.get(0)).toBeUndefined();
    expect(model.complete).toHaveBeenCalledOnce();
  });

  it.each(["plain", "json-fence", "bare-fence"])("accepts a complete %s without another model call", async format => {
    const value = JSON.stringify({ memories: [proposal(["E1"])] });
    const text = format === "plain" ? ` \n${value}\n ` : format === "json-fence" ? `\n\`\`\`json\n${value}\n\`\`\`\n` : `\`\`\`\r\n${value}\r\n\`\`\``;
    const model = provider(() => text);
    const result = await synthesize(model);
    expect(result.created).toEqual([0]);
    expect(model.complete).toHaveBeenCalledOnce();
  });

  it.each(["prefix", "suffix", "two-blocks", "truncated"])("does not repair or partially accept %s JSON", async format => {
    const value = JSON.stringify({ memories: [proposal(["E1"])] });
    const fence = `\`\`\`json\n${value}\n\`\`\``;
    const text = format === "prefix" ? `Explanation\n${fence}` : format === "suffix" ? `${fence}\nExplanation`
      : format === "two-blocks" ? `${fence}\n${fence}` : value.slice(0, -2);
    const model = provider(() => text);
    await expect(synthesize(model)).rejects.toThrow(/reason=invalid_json/);
    expect(model.complete).toHaveBeenCalledOnce();
    expect(await memories.get(0)).toBeUndefined();
  });

  it.each(["x".repeat(64001), "界".repeat(32001)])("checks raw character and byte budgets before normalization (%#)", async text => {
    await expect(synthesize(provider(() => text))).rejects.toThrow(/reason=output_size/);
    expect(await memories.get(0)).toBeUndefined();
  });

  it("enforces the requested count before any write, but allows explicitly requested larger batches", async () => {
    const model = provider(() => JSON.stringify({ memories: Array.from({ length: 6 }, (_, index) => proposal(["E1"], { summary: `fact ${index}` })) }));
    await expect(synthesize(model)).rejects.toThrow(/reason=memory_count, proposals=6/);
    expect(await memories.get(0)).toBeUndefined();
    const result = await synthesize(model, args({ max_memories: 6 }));
    expect(result.created).toHaveLength(6);
    expect(result.max_memories).toBe(6);
    expect(payload(vi.mocked(model.complete).mock.calls[1]![0]).max_memories).toBe(6);
  });

  it("keeps dry runs source-backed and write-free", async () => {
    const model = provider(() => JSON.stringify({ memories: [proposal(["E1"])] }));
    const result = await synthesize(model, args({ dry_run: true, max_memories: 1 }));
    expect(result).toMatchObject({ max_memories: 1, synthesis: { modelRequests: 1, proposals: 1 }, proposals: [
      { sources: [{ kind: "session", sessionId: current.id, recordId: "m1" }] },
    ] });
    expect(await memories.get(0)).toBeUndefined();
  });

  it("reports output truncation with actionable input statistics, accounting once and never retrying", async () => {
    const model = provider(() => { throw new ProviderError("upstream", "private-provider-body", false, undefined, "output_truncated"); });
    const onModelUsage = vi.fn();
    const error = await synthesize(model, args(), { context: { ...context, onModelUsage } }).catch(error => error);
    expect(error.message).toContain("stage=model_request, classification=upstream, reason=output_truncated");
    expect(error.message).toMatch(/evidence_count=1, input_chars=\d+, max_memories=4/);
    expect(error.message).toContain("use max_memories=1");
    expect(error.message).not.toContain("private-provider-body");
    expect(model.complete).toHaveBeenCalledOnce();
    expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(await memories.get(0)).toBeUndefined();
  });
});
