import { expect, it } from "vitest";
import { createDiffPatch, MAX_PATCH_BYTES } from "../../src/shared/diff";
import { diffPatchSchema } from "../../src/shared/schemas";

it("finds changes beyond a file preview with correct source line numbers", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}\n`);
  const updated = [...lines]; updated[4500] = "changed late\n";
  const patch = createDiffPatch(lines.join(""), updated.join(""));
  expect(patch).toMatchObject({ status: "complete", added: 1, removed: 1, omittedLines: 0 });
  expect(patch.hunks[0]).toMatchObject({ oldStart: 4496, newStart: 4496, oldLines: 11, newLines: 11 });
  expect(patch.hunks[0]?.lines).toContainEqual({ op: "insert", text: "changed late\n" });
  expect(diffPatchSchema.parse(patch)).toEqual(patch);
});
it("preserves literal tabs, CRLF and missing final newlines", () => {
  for (const [before, after] of [["\ta\n", "    a\n"], ["a\r\n", "a\n"], ["a", "a\n"]]) {
    const patch = createDiffPatch(before!, after!);
    expect(patch).toMatchObject({ status: "complete", added: 1, removed: 1 });
    expect(patch.hunks[0]?.lines).toEqual([{ op: "delete", text: before }, { op: "insert", text: after }]);
  }
});
it("distinguishes equal, create, delete and empty files", () => {
  expect(createDiffPatch("", "")).toMatchObject({ status: "complete", added: 0, removed: 0, hunks: [] });
  expect(createDiffPatch("", "a\nb\n").hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
  expect(createDiffPatch("a\nb\n", "").hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
});
it("merges nearby ranges and keeps distant hunks distinct", () => {
  const before = Array.from({ length: 30 }, (_, i) => `${i}\n`);
  const after = [...before]; after[4] = "first\n"; after[6] = "near\n"; after[25] = "far\n";
  const patch = createDiffPatch(before.join(""), after.join(""));
  expect(patch.hunks).toHaveLength(2);
  expect(patch).toMatchObject({ added: 3, removed: 3 });
});
it("bounds patch storage while preserving exact totals and ordered retained rows", () => {
  const patch = createDiffPatch("", "new\n".repeat(1000));
  expect(patch).toMatchObject({ status: "truncated", added: 1000, removed: 0, omittedLines: 600 });
  expect(patch.hunks[0]).toMatchObject({ newLines: 400, oldLines: 0 });
  expect(patch.hunks[0]?.lines).toHaveLength(400);
  expect(Buffer.byteLength(JSON.stringify(patch))).toBeLessThanOrEqual(MAX_PATCH_BYTES);
  diffPatchSchema.parse(patch);
});
it("caps escaped JSON bytes and never invents a partial source line", () => {
  const patch = createDiffPatch("", ("\u0000".repeat(1000) + "😀\n").repeat(20));
  expect(patch.status).toBe("truncated");
  expect(Buffer.byteLength(JSON.stringify(patch))).toBeLessThanOrEqual(MAX_PATCH_BYTES);
  expect(patch.hunks[0]?.lines.every(line => line.text.endsWith("😀\n"))).toBe(true);
  const huge = createDiffPatch("", "x".repeat(10000));
  expect(huge).toMatchObject({ status: "truncated", added: 1, omittedLines: 1, omittedHunks: 1, hunks: [] });
});
it("keeps unavailable computation distinct from zero changes", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}\n`).join("");
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}\n`).join("");
  const patch = createDiffPatch(before, after);
  expect(patch).toMatchObject({ status: "unavailable", reason: "budget", hunks: [] });
  expect(patch.added).toBeUndefined(); expect(patch.removed).toBeUndefined();
  expect(createDiffPatch("", "\n".repeat(100001)).status).toBe("unavailable");
});
it("records consistent hunk ranges and reconstructs small originals without normalization", () => {
  const samples = ["", "a", "a\n", "a\r\n", "\tb\n", "a\na\n", "a\nb\na\n"];
  for (const before of samples) for (const after of samples) {
    const patch = createDiffPatch(before, after);
    diffPatchSchema.parse(patch);
    if (before === after) { expect(patch.hunks).toEqual([]); continue; }
    expect(patch.hunks).toHaveLength(1);
    const hunk = patch.hunks[0]!;
    const old = hunk.lines.filter(line => line.op !== "insert");
    const next = hunk.lines.filter(line => line.op !== "delete");
    expect(old.map(line => line.text).join("")).toBe(before);
    expect(next.map(line => line.text).join("")).toBe(after);
    expect(hunk.oldLines).toBe(old.length); expect(hunk.newLines).toBe(next.length);
  }
});
