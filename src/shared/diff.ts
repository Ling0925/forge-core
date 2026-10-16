import { editScript } from "./edit-script";
import type { DiffPatch } from "./schemas";

const CONTEXT = 5;
const MAX_INPUT_CHARS = 2 * 1024 * 1024;
const MAX_INPUT_LINES = 100_000;
const MAX_PATCH_LINES = 400;
const MAX_HUNKS = 64;
const MAX_LINE_CHARS = 8192;
// Reserve room for legacy before/after previews within the tool result envelope.
export const MAX_PATCH_BYTES = 24 * 1024;

/** Preserve line endings in comparisons. Display normalization must happen later. */
const linesOf = (text: string): string[] | null => {
  const lines: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (lines.length >= MAX_INPUT_LINES) return null;
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    lines.push(text.slice(start, end));
    start = end;
  }
  return lines;
};
const unavailable = (): DiffPatch => ({
  version: 1, status: "unavailable", reason: "budget", omittedLines: 0, omittedHunks: 0, hunks: [],
});

/** Generate once from full tool-operation content; never read disk during rendering.
 * Counts describe the complete edit script. Storage bounds remove a suffix of
 * patch rows, not a prefix of the original files; rows are never moved/reordered.
 * Even partial hunks describe exactly the rows actually retained in that hunk.
 */
export function createDiffPatch(before: string, after: string): DiffPatch {
  if (before === after) return { version: 1, status: "complete", added: 0, removed: 0, omittedLines: 0, omittedHunks: 0, hunks: [] };
  if (before.length > MAX_INPUT_CHARS || after.length > MAX_INPUT_CHARS) return unavailable();
  const oldLines = linesOf(before);
  const newLines = linesOf(after);
  if (!oldLines || !newLines) return unavailable();
  const script = editScript(oldLines, newLines);
  if (!script) return unavailable();
  let added = 0;
  let removed = 0;
  const ranges: { from: number; to: number }[] = [];
  for (let i = 0; i < script.length; i++) {
    const step = script[i]!;
    if (step.op === "equal") continue;
    if (step.op === "insert") added++; else removed++;
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(script.length, i + CONTEXT + 1);
    const previous = ranges.at(-1);
    if (previous && from <= previous.to) previous.to = to;
    else ranges.push({ from, to });
  }
  const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: { op: "equal" | "delete" | "insert"; text: string }[] }[] = [];
  let cursor = 0;
  let oldLine = 1;
  let newLine = 1;
  let retained = 0;
  let bytes = 512; // Envelope + exact counts and omission metadata.
  let exhausted = false;
  for (const range of ranges) {
    if (exhausted || hunks.length >= MAX_HUNKS) break;
    while (cursor < range.from) {
      const step = script[cursor++]!;
      if (step.op !== "insert") oldLine++;
      if (step.op !== "delete") newLine++;
    }
    const hunk = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, lines: [] as { op: "equal" | "delete" | "insert"; text: string }[] };
    bytes += 128; // Bounded integer fields and array punctuation.
    while (cursor < range.to) {
      const step = script[cursor]!;
      const cost = Buffer.byteLength(JSON.stringify(step), "utf8") + 1;
      if (retained >= MAX_PATCH_LINES || step.text.length > MAX_LINE_CHARS || bytes + cost > MAX_PATCH_BYTES) {
        exhausted = true;
        break;
      }
      bytes += cost;
      hunk.lines.push({ op: step.op, text: step.text });
      retained++;
      cursor++;
      if (step.op !== "insert") { oldLine++; hunk.oldLines++; }
      if (step.op !== "delete") { newLine++; hunk.newLines++; }
    }
    if (hunk.lines.length) {
      if (!hunk.oldLines) hunk.oldStart--;
      if (!hunk.newLines) hunk.newStart--;
      hunks.push(hunk);
    }
  }
  const totalRows = ranges.reduce((total, range) => total + range.to - range.from, 0);
  const omittedLines = totalRows - retained;
  return { version: 1, status: omittedLines ? "truncated" : "complete", added, removed,
    omittedLines, omittedHunks: ranges.length - hunks.length, hunks };
}
