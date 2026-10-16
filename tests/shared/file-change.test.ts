import { expect, it } from "vitest";
import { createDiffPatch, unavailablePatch } from "../../src/shared/diff";
import {
  fileChangeSchema,
  sessionSnapshotSchema,
  toolResultSchema,
} from "../../src/shared/schemas";

const legacy = {
  path: "a.ts", kind: "modified", before: "old\n", after: "new\n", truncated: false,
};

it("accepts patch-only changes and prefers a recorded patch over legacy previews", () => {
  const change = { path: "a.ts", kind: "modified", patch: createDiffPatch("full old\n", "full new\n") };
  expect(fileChangeSchema.parse(change)).toEqual(change);
  expect(fileChangeSchema.parse({ ...legacy, ...change, truncated: true })).toEqual(change);
  expect(fileChangeSchema.parse(legacy)).toEqual({
    path: "a.ts", kind: "modified", patch: createDiffPatch("old\n", "new\n"),
  });
  expect(legacy).toHaveProperty("before", "old\n"); // Migration never mutates its input.
});

it("migrates complete creation, deletion and empty-file previews without inventing rows", () => {
  for (const [kind, before, after] of [
    ["created", null, "new\n"], ["deleted", "old\n", null],
    ["created", null, ""], ["deleted", "", null], ["modified", "", ""],
  ] as const) {
    expect(fileChangeSchema.parse({ path: "a.ts", kind, before, after, truncated: false })).toEqual({
      path: "a.ts", kind, patch: createDiffPatch(before ?? "", after ?? ""),
    });
  }
});

it("labels incomplete or truncated legacy content unavailable rather than unchanged", () => {
  for (const partial of [
    { ...legacy, truncated: true },
    { ...legacy, truncated: undefined },
    { ...legacy, before: null },
    { ...legacy, after: null },
    { ...legacy, before: undefined },
  ]) {
    expect(fileChangeSchema.parse(partial)).toEqual({
      path: "a.ts", kind: "modified", patch: unavailablePatch(),
    });
  }
  expect(fileChangeSchema.parse({ path: "a.ts", kind: "modified" })).toEqual({ path: "a.ts", kind: "modified" });
  expect(fileChangeSchema.safeParse({ ...legacy, patch: { version: 1, hunks: "bad" } }).success).toBe(false);
  expect(fileChangeSchema.safeParse({ ...legacy, unexpected: true }).success).toBe(false);
});

it("normalizes tool results, snapshot changes and saved events to patch-only data", () => {
  const result = { content: "edited", isError: false, changes: [legacy] };
  const migrated = { path: "a.ts", kind: "modified", patch: createDiffPatch("old\n", "new\n") };
  expect(toolResultSchema.parse(result).changes).toEqual([migrated]);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const timestamp = "2026-01-01T00:00:00Z";
  const snapshot = sessionSnapshotSchema.parse({
    version: 1, id, title: "legacy", workspace: "/tmp", model: "test",
    createdAt: timestamp, updatedAt: timestamp, status: "completed", messages: [],
    changes: [legacy], events: [{ type: "tool_finished", sessionId: id, timestamp, toolCallId: "edit-1", result }],
  });
  expect(snapshot.changes).toEqual([migrated]);
  expect(snapshot.events[0]).toMatchObject({ result: { changes: [migrated] } });
  expect(JSON.stringify(snapshot)).not.toMatch(/"(?:before|after|truncated)":/);
});
