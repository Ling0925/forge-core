import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider, SessionStore, ToolContext } from "../../src/shared/contracts";
import { forgeMemorySchema, searchMemorySchema, type MemoryStore } from "../../src/shared/memory";
import type { AgentEvent, Message, ProviderResponse, SessionSnapshot } from "../../src/shared/schemas";
import { ForgeError } from "../../src/shared/errors";
import { ProviderError } from "../../src/provider/errors";
import { createMemoryToolRegistry } from "../../src/tools/memory";
import { openSessionStore } from "../../src/store/sessions";
import { openMemoryStore } from "../../src/store/memory";
import { retrieveMemoryEvidence } from "../../src/core/memory-retrieval";
import { forgeMemory } from "../../src/core/forge-memory";
import { createHarness } from "../../src/core/harness";

let root: string;
let workspace: string;
let sessions: SessionStore;
let memories: MemoryStore;
let current: SessionSnapshot;
let context: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-memory-core-"));
  workspace = await mkdtemp(join(tmpdir(), "forge-memory-workspace-"));
  sessions = await openSessionStore(root); memories = await openMemoryStore(root);
  const created = await sessions.create({ workspace, title: "Current", model: "chosen-model" });
  current = { ...created, messages: [{ role: "user", content: "forge 本机更新只需要编译再重开。" }] };
  await sessions.save(current);
  context = { sessionId: current.id, toolCallId: "synthesize", workspace, permission: "unrestricted",
    signal: new AbortController().signal, approve: async () => false, onEvent: () => {} };
});
afterEach(async () => { await memories.close(); await rm(root, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true }); });
const input = () => forgeMemorySchema.parse({ query: "整理 forge 更新方式", keywords: ["forge"] });
const proposal = (refs: string[], extra: object = {}) => ({ tags: ["forge"], summary: "forge 本机更新", details: "编译 CLI，再重开；无需安装。", refs, ...extra });
const fakeProvider = (response: (messages: readonly Message[]) => unknown | Promise<unknown>): ModelProvider => ({
  listModels: async () => [],
  complete: vi.fn<ModelProvider["complete"]>(async (messages, tools, options) => {
    expect(tools).toEqual([]); expect(options.model).toBe("chosen-model"); expect(options.webSearch).toBeUndefined();
    return { message: { role: "assistant", content: JSON.stringify(await response(messages)) },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
  }),
});
const evidenceRefs = (messages: readonly Message[]) => JSON.parse(messages[1]?.content ?? "{}").evidence as { ref: string; source: { kind: string; id?: number }; truncated: boolean }[];
const execute = (provider: ModelProvider, extra: Partial<Parameters<typeof forgeMemory>[1]> = {}, args = input()) =>
  forgeMemory(args, { sessions, memories, provider, context, ...extra });

describe("cross-session retrieval and memory synthesis", () => {
  it("retrieves archived, child, cross-workspace and pre-compaction journal records, with safe projection", async () => {
    const other = await sessions.create({ workspace: root, title: "Other", model: "old-model" });
    await sessions.save({ ...other, parentSessionId: current.id, archived: true, contextSummary: { boundary: 1, content: "Summary omits the keyword", fallback: false }, messages: [
      { role: "user", content: "forge 原始要求 api_key=fixture-sensitive-key" },
      { role: "assistant", content: "forge 观察内容", reasoning: "reasoning-private-marker", providerState: {
        version: 1, apiMode: "responses", baseUrl: "https://example.test/v1", model: "old-model", output: [{ private: "continuation-marker" }],
      } },
    ] });
    const args = { input: input(), current, sessions, memories, signal: context.signal };
    const retrieved = await retrieveMemoryEvidence(args);
    expect(retrieved.evidence.some(item => item.ref === `s:${other.id}:m1`)).toBe(true);
    expect(JSON.stringify(retrieved.evidence)).not.toMatch(/fixture-sensitive-key|reasoning-private-marker|continuation-marker/);
    expect(retrieved.coverage).toMatchObject({ scannedSessions: 2, scannedRecords: 3, scan_truncated: false });
    const scoped = await retrieveMemoryEvidence({ ...args, input: { ...input(), scope: "workspace" } });
    expect(scoped.evidence.every(item => item.source.kind === "session" && item.source.sessionId === current.id)).toBe(true);
    const bounded = await retrieveMemoryEvidence({ ...args, limits: { sessions: 1, excerptChars: 20 } });
    expect(bounded.coverage.scan_truncated).toBe(true); expect(bounded.coverage.excerpt_truncated).toBe(true);
  });

  it("reports unreadable sessions and bounded candidate selection instead of claiming completeness", async () => {
    const other = await sessions.create({ workspace, title: "Unreadable", model: "chosen-model" });
    const broken = { ...sessions, get: async (id: typeof current.id) => { if (id === other.id) throw new Error("private diagnostics"); return sessions.get(id); } };
    const result = await retrieveMemoryEvidence({ input: input(), current, sessions: broken, memories, signal: context.signal });
    expect(result.coverage.unreadableSessions).toBe(1);
    const bounded = await retrieveMemoryEvidence({ input: input(), current, sessions, memories, signal: context.signal, limits: { inputChars: 1 } });
    expect(bounded.evidence).toEqual([]); expect(bounded.coverage.selection_truncated).toBe(true);
  });

  it("creates source-backed ID 0, accounts inference usage, updates rather than duplicating and skips exact duplicates", async () => {
    const onModelUsage = vi.fn();
    const first = await execute(fakeProvider(messages => ({ memories: [proposal([evidenceRefs(messages)[0]!.ref])] })), { context: { ...context, onModelUsage } });
    expect(first.created).toEqual([0]); expect(onModelUsage).toHaveBeenCalledWith({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect((await memories.get(0))?.sources).toEqual([{ kind: "session", sessionId: current.id, recordId: "m1" }]);
    const update = await execute(fakeProvider(messages => ({ memories: [proposal(evidenceRefs(messages).map(item => item.ref), { id: 0, details: "编译后重开，不需打包或安装。" })] })));
    expect(update.updated).toEqual([0]); expect((await memories.get(0))?.version).toBe(2);
    const existing = (await memories.get(0))!;
    const duplicate = await execute(fakeProvider(messages => ({ memories: [proposal([evidenceRefs(messages)[0]!.ref], { tags: existing.tags, summary: existing.summary, details: existing.details })] })));
    expect(duplicate.skipped).toEqual([0]); expect((await memories.search(searchMemorySchema.parse({}))).total).toBe(1);
  });

  it("dry-run returns proposals but writes nothing, and no matches avoid inference", async () => {
    const provider = fakeProvider(messages => ({ memories: [proposal([evidenceRefs(messages)[0]!.ref])] }));
    const result = await execute(provider, {}, { ...input(), dry_run: true });
    expect(result).toHaveProperty("proposals", expect.arrayContaining([expect.objectContaining({ summary: "forge 本机更新" })]));
    expect(await memories.get(0)).toBeUndefined();
    const noMatch = await execute(provider, {}, { ...input(), keywords: ["absent-needle"] });
    expect(noMatch.created).toEqual([]); expect(provider.complete).toHaveBeenCalledOnce();
  });

  it.each(["unknown-ref", "unknown-id", "empty-ref", "bad-json", "secret", "tool-call"])("rejects %s output without partial writes", async kind => {
    const provider = fakeProvider(messages => {
      const valid = proposal([evidenceRefs(messages)[0]!.ref]);
      if (kind === "bad-json") return { wrong: true };
      return { memories: [valid, proposal(kind === "empty-ref" ? [] : kind === "unknown-ref" ? ["s:invented:m1"] : valid.refs,
        kind === "unknown-id" ? { id: 77 } : kind === "secret" ? { details: "sk-fixture-secret-value" } : {})] };
    });
    if (kind === "tool-call") provider.complete = async () => ({ message: { role: "assistant", content: "{}", tool_calls: [
      { id: "unexpected", type: "function", function: { name: "del_memory", arguments: '{"id":0}' } },
    ] } });
    await expect(execute(provider)).rejects.toMatchObject({ code: "tool" });
    expect(await memories.get(0)).toBeUndefined();
  });

  it("revalidates cited memory versions atomically and refuses truncated update targets", async () => {
    await memories.update({ tags: ["forge"], summary: "forge", details: "old" });
    const provider = fakeProvider(async messages => {
      const refs = evidenceRefs(messages).map(item => item.ref);
      await memories.update({ id: 0, details: "concurrent update" });
      return { memories: [proposal(refs), proposal(refs, { id: 0, details: "would overwrite" })] };
    });
    await expect(execute(provider)).rejects.toThrow(/conflict/);
    expect((await memories.search(searchMemorySchema.parse({}))).total).toBe(1);
    expect((await memories.get(0))?.details).toBe("concurrent update");
    await memories.update({ id: 0, details: "forge ".repeat(2000) });
    const truncated = fakeProvider(messages => ({ memories: [proposal(evidenceRefs(messages).map(item => item.ref), { id: 0 })] }));
    await expect(execute(truncated)).rejects.toThrow(/complete current memory/);
  });

  it("keeps caller cancellation distinct from model failures without committing or retrying", async () => {
    const controller = new AbortController();
    const onModelUsage = vi.fn();
    const provider = fakeProvider(messages => { controller.abort(); return { memories: [proposal([evidenceRefs(messages)[0]!.ref])] }; });
    await expect(execute(provider, { context: { ...context, signal: controller.signal, onModelUsage } })).rejects.toMatchObject({
      code: "cancelled", retryable: false, message: expect.not.stringContaining("deadline_exceeded"),
    });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(await memories.get(0)).toBeUndefined();
  });

  it.each([false, true])("identifies the local deadline even with partial output (adapter honors abort=%s)", async honorsAbort => {
    let finish = () => {};
    const onModelUsage = vi.fn();
    const provider: ModelProvider = { listModels: async () => [], complete: vi.fn<ModelProvider["complete"]>((messages, _tools, options) =>
      new Promise((resolve, reject) => {
        options.onText?.("partial JSON");
        finish = () => resolve({ message: { role: "assistant", content: JSON.stringify({ memories: [proposal([evidenceRefs(messages)[0]!.ref])] }) } });
        if (honorsAbort) options.signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "fixture-private-body")), { once: true });
      })) };
    await expect(execute(provider, { timeoutMs: 10, context: { ...context, onModelUsage } })).rejects.toMatchObject({
      code: "provider", retryable: false,
      message: expect.stringMatching(/stage=model_request, classification=deadline_exceeded, timeout_ms=10, elapsed_ms=\d+/),
    });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(undefined);
    finish(); // A late response from a non-cooperative adapter cannot commit anything.
    await Promise.resolve();
    expect(await memories.get(0)).toBeUndefined();
  });

  it.each([
    { error: new ProviderError("http", "fixture-private-body", true, 429), fields: "classification=http, http_status=429" },
    { error: new ProviderError("http", "fixture-private-body", false, 401), fields: "classification=http, http_status=401" },
    { error: new ProviderError("http", "fixture-private-body", true, 503), fields: "classification=http, http_status=503" },
    { error: new ProviderError("network", "fixture-private-body", true), fields: "classification=network" },
    { error: new ProviderError("timeout", "fixture-private-body", true), fields: "classification=timeout" },
    { error: new ProviderError("protocol", "fixture-private-body", false, undefined, "missing_completion"), fields: "classification=protocol, reason=missing_completion" },
    { error: new ProviderError("upstream", "fixture-private-body", false, undefined, "insufficient_quota"), fields: "classification=upstream, reason=insufficient_quota" },
    { error: new ProviderError("aborted", "fixture-private-body"), fields: "classification=aborted" },
    { error: new ProviderError("observer", "fixture-private-body"), fields: "classification=observer" },
  ])("preserves safe provider diagnostics: $fields", async ({ error, fields }) => {
    const onModelUsage = vi.fn();
    const provider = fakeProvider(() => { throw error; });
    const failure = await execute(provider, { context: { ...context, onModelUsage } }).catch(caught => caught);
    expect(failure).toMatchObject({ code: "provider", retryable: false });
    expect(failure.message).toContain(`stage=model_request, ${fields}, elapsed_ms=`);
    expect(failure.message).toContain("nothing committed. No automatic retry was performed.");
    expect(failure.message).not.toMatch(/fixture-private-body|deadline_exceeded|timeout_ms=/);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(await memories.get(0)).toBeUndefined();
  });

  it.each([
    new Error("fixture-private-body"),
    new ForgeError("provider", "fixture-private-body"),
    { classification: "http", status: 401, message: "fixture-private-body" },
    Object.assign(new ProviderError("http", "fixture-private-body"), { classification: "fixture-private-classification", status: 99999, reason: "fixture-private-reason" }),
  ])("does not expose unknown exceptions or untrusted adapter metadata (%#)", async error => {
    const provider = fakeProvider(() => { throw error; });
    const failure = await execute(provider).catch(caught => caught);
    expect(failure.message).toMatch(/classification=unknown, elapsed_ms=\d+/);
    expect(failure.message).not.toMatch(/fixture-private|http_status=|reason=/);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(await memories.get(0)).toBeUndefined();
  });

  it("drops malformed status/reason fields without losing a valid classification", async () => {
    const error = Object.assign(new ProviderError("http", "fixture-private-body"), { status: 401.5, reason: "fixture-private-reason" });
    const provider = fakeProvider(() => { throw error; });
    const failure = await execute(provider).catch(caught => caught);
    expect(failure.message).toContain("classification=http, elapsed_ms=");
    expect(failure.message).not.toMatch(/fixture-private|http_status=|reason=/);
  });

  it("measures synthesis elapsed time with a monotonic clock", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const provider = fakeProvider(() => { clock.mockReturnValue(1125); throw new ProviderError("network", "fixture-private-body"); });
      await expect(execute(provider)).rejects.toThrow(/elapsed_ms=125/);
    } finally { clock.mockRestore(); }
  });

  it("distinguishes response validation failures from request failures without exposing invalid fields", async () => {
    const onModelUsage = vi.fn();
    const provider: ModelProvider = { listModels: async () => [], complete: vi.fn<ModelProvider["complete"]>(async () =>
      ({ message: { role: "fixture-private-body", content: "fixture-private-content" } }) as unknown as ProviderResponse) };
    const failure = await execute(provider, { context: { ...context, onModelUsage } }).catch(caught => caught);
    expect(failure).toMatchObject({ code: "provider", retryable: false });
    expect(failure.message).toContain("stage=response_validation, classification=invalid_response, elapsed_ms=");
    expect(failure.message).not.toContain("fixture-private");
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(await memories.get(0)).toBeUndefined();
  });

  it("reports accounting observer failures once without mislabeling them as provider failures", async () => {
    const provider = fakeProvider(messages => ({ memories: [proposal([evidenceRefs(messages)[0]!.ref])] }));
    const onModelUsage = vi.fn(() => { throw new Error("fixture-private-observer"); });
    const failure = await execute(provider, { context: { ...context, onModelUsage } }).catch(caught => caught);
    expect(failure).toMatchObject({ code: "internal", retryable: false });
    expect(failure.message).toContain("stage=usage_accounting, classification=observer, elapsed_ms=");
    expect(failure.message).not.toContain("fixture-private");
    expect(onModelUsage).toHaveBeenCalledExactlyOnceWith({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(await memories.get(0)).toBeUndefined();
  });

  it("does not let a failing usage observer mask the original model failure", async () => {
    const provider = fakeProvider(() => { throw new ProviderError("http", "fixture-private-body", true, 429); });
    const onModelUsage = vi.fn(() => { throw new Error("fixture-private-observer"); });
    await expect(execute(provider, { context: { ...context, onModelUsage } })).rejects.toThrow(/stage=model_request, classification=http, http_status=429/);
    expect(onModelUsage).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(provider.complete).toHaveBeenCalledOnce();
    expect(await memories.get(0)).toBeUndefined();
  });

  it("returns safe diagnostics through the real memory tool registry without retrying", async () => {
    const provider = fakeProvider(() => { throw new ProviderError("http", "fixture-private-body", true, 503); });
    const tools = createMemoryToolRegistry(memories, { forge: (args, toolContext) => forgeMemory(args, {
      sessions, memories, provider, context: toolContext,
    }) });
    try {
      const result = await tools.execute({ id: context.toolCallId, type: "function", function: { name: "forge_memory", arguments: JSON.stringify(input()) } }, context);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toMatch(/stage=model_request, classification=http, http_status=503, elapsed_ms=\d+/);
      expect(result.content).not.toContain("fixture-private");
      expect(provider.complete).toHaveBeenCalledOnce();
      expect(await memories.get(0)).toBeUndefined();
    } finally { await tools.dispose(); }
  });
});

describe("default harness memory wiring", () => {
  it.each([true, false])("runs synthesis/get through the real registry and aggregates auxiliary usage (reported=%s)", async reported => {
    let turns = 0;
    const provider: ModelProvider = { listModels: async () => ["chosen-model"], complete: async (messages, tools) => {
      if (!tools.length) return { message: { role: "assistant", content: JSON.stringify({ memories: [proposal([evidenceRefs(messages)[0]!.ref])] }) },
        ...(reported ? { usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } } : {}) };
      expect(tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(["update_memory", "del_memory", "get_memory", "search_memory", "forge_memory"]));
      turns++;
      return { message: turns < 3 ? { role: "assistant", content: null, tool_calls: [{ id: `call-${turns}`, type: "function",
        function: { name: turns === 1 ? "forge_memory" : "get_memory", arguments: JSON.stringify(turns === 1 ? { query: "forge", keywords: ["forge"] } : { id: 0 }) } }] }
        : { role: "assistant", content: "done" }, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
    } };
    const harness = await createHarness({ stateDir: root, providerFactory: () => provider });
    try {
      await harness.updateSettings({ apiKey: "fixture-only-key", settings: { model: "chosen-model", baseUrl: "https://example.test/v1" } });
      const session = await harness.createSession({ workspace, title: "Memory integration" });
      const events: AgentEvent[] = [];
      const result = await harness.run({ sessionId: session.id, prompt: "forge 本机更新只编译再重开", permission: "unrestricted" }, event => events.push(event), async () => false, new AbortController().signal);
      expect(result.status).toBe("completed");
      expect(events.filter(event => event.type === "tool_finished").every(event => event.result.isError === false)).toBe(true);
      const end = events.findLast(event => event.type === "run_finished");
      expect(end).toMatchObject({ usage: { totalTokens: reported ? 91 : 36 }, usageComplete: reported });
      expect((await memories.get(0))?.summary).toBe("forge 本机更新");
    } finally { await harness.dispose(); }
  });

  it("allows memory reads in core readonly mode but blocks writes and synthesis before execution", async () => {
    await memories.update({ summary: "forge", details: "existing" });
    let turns = 0;
    const provider: ModelProvider = { listModels: async () => [], complete: async () => ({ message: ++turns === 1 ? {
      role: "assistant", content: null, tool_calls: ["get_memory", "search_memory", "update_memory", "forge_memory"].map((name, index) => ({ id: `call-${index}`, type: "function" as const,
        function: { name, arguments: JSON.stringify(name === "get_memory" ? { id: 0 } : name === "search_memory" ? {} : name === "update_memory" ? { summary: "s", details: "d" } : { query: "forge" }) } })),
    } : { role: "assistant", content: "done" } }) };
    const harness = await createHarness({ stateDir: root, providerFactory: () => provider });
    try {
      await harness.updateSettings({ apiKey: "fixture-only-key", settings: { model: "chosen-model", baseUrl: "https://example.test/v1" } });
      const session = await harness.createSession({ workspace, title: "Readonly memory" });
      const events: AgentEvent[] = [];
      const approve = vi.fn(async () => true);
      await harness.run({ sessionId: session.id, prompt: "inspect", permission: "readonly" }, event => events.push(event), approve, new AbortController().signal);
      const results = events.filter(event => event.type === "tool_finished");
      expect(results.map(event => event.result.isError)).toEqual([false, false, true, true]);
      expect(approve).not.toHaveBeenCalled(); expect((await memories.search(searchMemorySchema.parse({}))).total).toBe(1);
    } finally { await harness.dispose(); }
  });
});
