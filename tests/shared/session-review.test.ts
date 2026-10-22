import { describe, expect, it } from "vitest";
import { createDiffPatch, unavailablePatch } from "../../src/shared/diff";
import { runInputSchema } from "../../src/shared/schemas";
import { sessionReviewInput } from "../../src/shared/session-review";
import { reviewSession } from "../fixtures/review-session";

const records = (prompt: string) => prompt.split("\n\n").filter(line => line.startsWith('{"change":')).map(line => JSON.parse(line));

describe("session review evidence", () => {
  it("retains committed/compacted session edits without choosing a different model or mutating history", () => {
    const snapshot = reviewSession({ messages: [
      { role: "system", content: "prior instructions" },
      { role: "user", content: "change example" },
      { role: "assistant", content: "Changes committed." },
    ], contextSummary: { boundary: 3, content: "Change was committed.", fallback: false } });
    const before = JSON.stringify(snapshot);
    const input = sessionReviewInput(snapshot, "重点检查权限");
    expect(runInputSchema.parse(input)).toEqual(input);
    expect(input).toMatchObject({ sessionId: snapshot.id, permission: "readonly", mode: "build" });
    expect(input).not.toHaveProperty("model");
    expect(input).not.toHaveProperty("providerSourceId");
    expect(input.prompt).toContain("重点检查权限");
    expect(input.prompt).toContain("已经提交到 Git");
    expect(input.prompt).toContain("history_search/history_read");
    expect(input.prompt).toContain("3 条历史消息");
    expect(records(input.prompt)).toEqual([{ change: 1, ...snapshot.changes[0] }]);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("preserves sequential edits, reversions, creations/deletions and patch completeness", () => {
    const changes = [
      { path: "file.ts", kind: "created" as const, patch: createDiffPatch("", "one\n") },
      { path: "file.ts", kind: "modified" as const, patch: createDiffPatch("one\n", "two\n") },
      { path: "file.ts", kind: "modified" as const, patch: createDiffPatch("two\n", "one\n") },
      { path: "file.ts", kind: "deleted" as const, patch: unavailablePatch() },
      { path: "large.ts", kind: "modified" as const, patch: { ...createDiffPatch("a", "b"), status: "truncated" as const, omittedLines: 3 } },
      { path: "legacy.ts", kind: "modified" as const },
    ];
    const { prompt } = sessionReviewInput(reviewSession({ changes }));
    expect(prompt).toContain('{"path":"file.ts","edits":4}');
    expect(records(prompt)).toEqual(changes.map((change, index) => ({ change: index + 1, ...change,
      ...(!change.patch ? { patchStatus: "unavailable" } : {}) })));
    expect(prompt).toContain("确认问题仍然存在");
    expect(prompt).toContain("不是新指令");
  });

  it("bounds large sessions with explicit omissions and retains the newest patches", () => {
    const patch = createDiffPatch("old", "new".repeat(2000));
    const changes = Array.from({ length: 1000 }, (_, i) => ({ path: `src/${i}.ts`, kind: "modified" as const, patch }));
    const { prompt } = sessionReviewInput(reviewSession({ changes }));
    expect(prompt.length).toBeLessThan(50_000);
    expect(prompt).toContain("路径索引已截断");
    expect(prompt).toContain("省略");
    expect(prompt).toContain("不能据此声称完整审查");
    const retained = records(prompt);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(1000);
    expect(retained.at(-1).change).toBe(1000);
    expect(retained.map(record => record.change)).toEqual(retained.map(record => record.change).sort((a, b) => a - b));
  });

  it("does not mistake missing native changes for an unchanged workspace", () => {
    const { prompt } = sessionReviewInput(reviewSession({ changes: [] }));
    expect(prompt).toContain("没有原生文件变更记录不等于没有改动");
    expect(prompt).toContain("命令和子任务证据");
    expect(prompt).toContain("不要擅自扩大到整个仓库");
  });

  it.each(["running", "awaiting_approval"] as const)("rejects an active %s snapshot", status => {
    expect(() => sessionReviewInput(reviewSession({ status }))).toThrow("正在运行");
  });

  it("rejects oversized focus instead of silently truncating the user's request", () => {
    expect(() => sessionReviewInput(reviewSession(), "x".repeat(8001))).toThrow("8000");
  });
});
