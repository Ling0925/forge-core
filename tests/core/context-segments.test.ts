import { describe, expect, it } from "vitest";
import { projectSummary, summarize } from "../../src/core/context";
import {
  buildSummaryShards,
  describeShardRanges,
} from "../../src/core/summary-segments";
import type { ModelProvider } from "../../src/shared/contracts";
import { type Message, sessionSnapshotSchema } from "../../src/shared/schemas";

const snapshot = (messages: Message[]) => sessionSnapshotSchema.parse({
  version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "test",
  workspace: "/workspace", model: "test", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", status: "idle", messages, events: [], changes: [],
});
const provider = (complete: ModelProvider["complete"]): ModelProvider => ({ listModels: async () => [], complete });

function call(id: string, name = "write_file"): Message {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: `{"path":"${id}.txt"}` } }] };
}
function toolResult(id: string, content = "done"): Message {
  return { role: "tool", tool_call_id: id, content };
}

describe("bounded summary segmentation", () => {
  it("covers every message in order and never separates a tool call from its own results", () => {
    const messages: Message[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "start" },
      ...Array.from({ length: 6 }, (_, i) => [call(`c${i}`), toolResult(`c${i}`)]).flat(),
    ];
    // Bound is large enough that no single-group split happens, so ranges are
    // disjoint and each message index appears exactly once.
    const shards = buildSummaryShards(messages, 400);
    const seen: number[] = [];
    for (const shard of shards) for (let i = shard.from; i < shard.to; i++) seen.push(i);
    expect(seen).toEqual(messages.map((_, i) => i));
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message?.role !== "assistant" || !message.tool_calls) continue;
      const owner = shards.find((shard) => shard.from <= i && i < shard.to);
      expect(owner).toBeDefined();
      for (const tool of message.tool_calls) {
        const resultIndex = messages.findIndex((m) => m.role === "tool" && m.tool_call_id === tool.id);
        expect(resultIndex).toBeGreaterThanOrEqual(owner?.from ?? -1);
        expect(resultIndex).toBeLessThan(owner?.to ?? -1);
      }
    }
  });

  it("explicitly shards one over-long group and reports its range and part", () => {
    const huge: Message = { role: "user", content: "中".repeat(5000) };
    const shards = buildSummaryShards([{ role: "user", content: "lead" }, huge], 1024);
    const oversized = shards.filter((shard) => shard.parts > 1);
    expect(oversized.length).toBeGreaterThan(1);
    // Every piece of the oversized group points back at the same source range.
    for (const shard of oversized) {
      expect(shard.from).toBe(1);
      expect(shard.to).toBe(2);
      expect(shard.parts).toBe(oversized.length);
    }
    expect(oversized.map((shard) => shard.part)).toEqual(oversized.map((_, i) => i + 1));
    // Bounded: every shard is within the requested UTF-16 character ceiling.
    for (const shard of shards) expect(shard.text.length).toBeLessThanOrEqual(1024);
  });

  it("never splits a UTF-16 surrogate pair when a message must be sharded", () => {
    const emoji = "😀".repeat(500); // 1000 UTF-16 code units, all surrogate pairs
    const shards = buildSummaryShards([{ role: "user", content: emoji }], 64);
    expect(shards.length).toBeGreaterThan(1);
    for (const shard of shards) {
      expect(shard.text.length).toBeLessThanOrEqual(64);
      const first = shard.text.charCodeAt(0);
      const last = shard.text.charCodeAt(shard.text.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect([...shard.text].every((char) => [...char].length <= 2)).toBe(true);
    }
  });

  it("describeShardRanges stays bounded for many ranges", () => {
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `${i}-${"x".repeat(20)}` }));
    const shards = buildSummaryShards(messages, 26);
    expect(shards.length).toBeGreaterThan(6);
    const text = describeShardRanges(shards, 0);
    expect(text).toMatch(/more/);
    expect(text.length).toBeLessThan(200);
  });
});

describe("summarize partial-failure reliability", () => {
  it("reserves space for retained memory even at the minimum fallback budget", async () => {
    const state = { ...snapshot([{ role: "user", content: "old" }, { role: "user", content: "new" }]), contextSummary: { content: "PRIOR_KEEP", boundary: 1, fallback: false } };
    const result = await summarize(state, provider(async () => { throw Error("offline"); }), new AbortController().signal, 2, 512);
    expect(result.contextSummary?.content.length).toBeLessThanOrEqual(256);
    expect(result.contextSummary?.content).toContain("PRIOR_KEEP");
    expect(result.contextSummary?.content).toContain("untrusted");
    expect(result.contextSummary?.content).not.toContain("authoritative");
  });
  it("retains earlier successful memory and names unsummarized ranges after a later failure", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) messages.push({ role: "user", content: `turn-${i}` }, { role: "assistant", content: "y".repeat(900) });
    let calls = 0;
    const result = await summarize(
      snapshot(messages),
      provider(async () => {
        calls++;
        if (calls === 2) throw Error("transient");
        return { message: { role: "assistant", content: `MEMORY_${calls}` } };
      }),
      new AbortController().signal,
      6,
      2048,
    );
    expect(calls).toBe(2);
    expect(result.contextSummary?.fallback).toBe(true);
    // The successful first chunk's memory survives the later failure.
    expect(result.contextSummary?.content).toContain("MEMORY_1");
    // The omission is explicit and names the message range that was skipped.
    expect(result.contextSummary?.content).toContain("Unsummarized ranges:");
    expect(result.contextSummary?.content).toMatch(/\d+\.\.\d+/);
  });

  it("segments by messages but never hands a request a split tool exchange", async () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      ...Array.from({ length: 10 }, (_, i) => [call(`t${i}`), toolResult(`t${i}`)]).flat(),
    ];
    const seen: string[] = [];
    const result = await summarize(
      snapshot(messages),
      provider(async (incoming) => {
        const fragment = incoming[1]?.content ?? "";
        seen.push(fragment);
        // A fragment that carries a tool result without the matching assistant
        // call would be a split pair; the segmenter must never produce one.
        for (const id of Array.from({ length: 10 }, (_, i) => `t${i}`)) {
          const hasResult = fragment.includes(`"tool_call_id":"${id}"`) || fragment.includes(`"tool_call_id": "${id}"`);
          const hasCall = fragment.includes(`"id":"${id}"`);
          if (hasResult && !hasCall) throw Error(`split pair ${id}`);
        }
        return { message: { role: "assistant", content: "memory" } };
      }),
      new AbortController().signal,
      messages.length,
      1024,
    );
    expect(result.contextSummary?.fallback).toBe(false);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((fragment) => fragment.includes("covering messages"))).toBe(true);
  });

  it("keeps previous untrusted memory when the very first request fails", async () => {
    const s = { ...snapshot([{ role: "user", content: "old" }, { role: "assistant", content: "done" }, { role: "user", content: "new" }]), contextSummary: { content: "PRIOR_CONSTRAINT", boundary: 2, fallback: false } };
    const failed = await summarize(s, provider(async () => { throw Error("offline"); }), new AbortController().signal, 3, 4096);
    expect(failed.contextSummary?.fallback).toBe(true);
    expect(failed.contextSummary?.content).toContain("PRIOR_CONSTRAINT");
    expect(failed.contextSummary?.content).not.toContain("SEMANTIC SUMMARY FAILED");
    expect(failed.messages).toBe(s.messages);
  });

  it("fails into retained memory without retrying once the request ceiling is exceeded", async () => {
    const messages: Message[] = Array.from({ length: 64 }, (_, i) => ({ role: "user", content: `${i}-${"z".repeat(80)}` }));
    let calls = 0;
    const result = await summarize(
      snapshot(messages),
      provider(async () => { calls++; return { message: { role: "assistant", content: "never" } }; }),
      new AbortController().signal,
      64,
      512,
    );
    // 256-char chunks cannot cover 64 units without more than 16 requests, so
    // the bounded pass refuses up front and issues zero provider calls.
    expect(calls).toBe(0);
    expect(result.contextSummary?.fallback).toBe(true);
    expect(result.contextSummary?.content).toContain("Unsummarized ranges:");
  });

  it("cancels without persisting a partial fallback or retrying", async () => {
    const abort = new AbortController();
    let calls = 0;
    const messages: Message[] = Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `${i}-${"q".repeat(600)}` }));
    await expect(summarize(
      snapshot(messages),
      provider(async () => {
        calls++;
        abort.abort();
        return { message: { role: "assistant", content: "chunk" } };
      }),
      abort.signal,
      8,
      2048,
    )).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(1);
  });

  it("merges a previous summary with only the new, tool-paired history", async () => {
    const s = {
      ...snapshot([
        { role: "system", content: "rules" },
        { role: "user", content: "OLD_RAW_MUST_NOT_REAPPEAR" },
        call("old"),
        toolResult("old"),
        { role: "user", content: "NEW_WORK" },
        call("new"),
        toolResult("new"),
      ]),
      contextSummary: { content: "PREVIOUS_MEMORY", boundary: 4, fallback: false },
    };
    let calls = 0;
    const result = await summarize(s, provider(async (incoming) => {
      calls++;
      expect(incoming[1]?.content).toContain("PREVIOUS_MEMORY");
      expect(incoming[1]?.content).toContain("NEW_WORK");
      expect(incoming[1]?.content).toContain('"id":"new"');
      expect(incoming[1]?.content).not.toContain("OLD_RAW_MUST_NOT_REAPPEAR");
      return { message: { role: "assistant", content: "merged" } };
    }), new AbortController().signal, 7);
    expect(calls).toBe(1);
    expect(result.contextSummary?.fallback).toBe(false);
    expect(result.contextSummary?.boundary).toBe(7);
    const projected = projectSummary(result);
    expect(projected[0]?.content).toBe("rules");
    expect(projected.some((m) => m.content?.includes("merged"))).toBe(true);
  });

  it("still issues exactly one cancellable request when there is no new history", async () => {
    // Empty new history must not short-circuit: the caller relies on the
    // request to observe an abort before persisting anything.
    const abort = new AbortController();
    let calls = 0;
    const work = summarize(
      snapshot([]),
      provider(async () => {
        calls++;
        abort.abort();
        return { message: { role: "assistant", content: "memory" } };
      }),
      abort.signal,
      0,
    );
    await expect(work).rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(1);
  });
});
