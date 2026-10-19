/**
 * Coarse, display-only line estimate for a *streamed* tool-argument fragment.
 *
 * The arguments are still incomplete JSON while generation runs, so nothing here
 * parses JSON or trusts the payload: a small scanner walks the top-level object,
 * tracks string boundaries/escapes, and counts newlines inside one or two known
 * keys. Only bounded counters ever leave this module — never argument text.
 */

/** Matches `toolCallPreviewSchema`'s bound so a preview always stays valid. */
const MAX_LINES = 1_000_000;

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

type StringScan = {
  /** `\n` escapes plus raw newline characters seen inside the body. */
  readonly newlines: number;
  /** Whether the closing quote arrived; false means the stream is mid-value. */
  readonly closed: boolean;
  /** Whether the body is empty (no characters at all). */
  readonly empty: boolean;
  /** Index just past the closing quote, or `text.length` when unterminated. */
  readonly end: number;
};

const isSpace = (ch: string): boolean =>
  ch === " " || ch === "\n" || ch === "\r" || ch === "\t";

/** Reads a JSON string body that starts at the opening quote at `start`. */
function readString(text: string, start: number): StringScan {
  let newlines = 0;
  let empty = true;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') return { newlines, closed: true, empty, end: i + 1 };
    empty = false;
    if (ch === "\\") {
      const next = text[i + 1];
      // A truncated escape is not a newline until its letter arrives.
      if (next === undefined)
        return { newlines, closed: false, empty, end: text.length };
      if (next === "n") newlines += 1;
      i += 2;
      continue;
    }
    // Raw newlines are invalid JSON but some gateways stream them verbatim.
    if (ch === "\n") newlines += 1;
    i += 1;
  }
  return { newlines, closed: false, empty, end: text.length };
}

/** Advances past a non-string value; -1 when the fragment ends inside it. */
function skipValue(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      const nested = readString(text, i);
      if (!nested.closed) return -1;
      i = nested.end;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      // At depth 0 this brace closes the enclosing arguments object.
      if (depth === 0) return i;
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (ch === "," && depth === 0) return i;
    i += 1;
  }
  return -1;
}

/** String-valued top-level members of the (possibly partial) arguments object. */
function topLevelStrings(text: string): Map<string, StringScan> {
  const values = new Map<string, StringScan>();
  const open = text.indexOf("{");
  if (open < 0) return values;
  let i = open + 1;
  while (i < text.length) {
    while (i < text.length && isSpace(text[i] as string)) i += 1;
    if (i >= text.length) break;
    const ch = text[i] as string;
    if (ch === "}") break;
    if (ch === ",") {
      i += 1;
      continue;
    }
    // Anything else means a malformed or truncated key: stop rather than guess.
    if (ch !== '"') break;
    const key = readString(text, i);
    if (!key.closed) break;
    const name = text.slice(i + 1, key.end - 1);
    i = key.end;
    while (i < text.length && isSpace(text[i] as string)) i += 1;
    if (text[i] !== ":") break;
    i += 1;
    while (i < text.length && isSpace(text[i] as string)) i += 1;
    if (i >= text.length) break;
    if (text[i] === '"') {
      const value = readString(text, i);
      values.set(name, value);
      if (!value.closed) break;
      i = value.end;
      continue;
    }
    const next = skipValue(text, i);
    if (next < 0) break;
    i = next;
  }
  return values;
}

/** Line count of a streamed string body: empty is 0, otherwise newlines + 1. */
function lineCount(value: StringScan): number {
  if (value.empty) return 0;
  return Math.min(MAX_LINES, value.newlines + 1);
}

/**
 * Live change-size estimate for `write_file` / `edit_file` arguments.
 *
 * Only newline counting is attempted: it is cheap, monotonic while streaming and
 * never needs the final JSON. Every other tool yields `{}`, so non-write previews
 * keep `linesAdded`/`linesRemoved` undefined.
 */
export function estimateToolCallLines(
  name: string,
  argumentsText: string,
): { linesAdded?: number; linesRemoved?: number } {
  if (!WRITE_TOOLS.has(name) || argumentsText === "") return {};
  const values = topLevelStrings(argumentsText);
  if (name === "write_file") {
    const content = values.get("content");
    return content ? { linesAdded: lineCount(content) } : {};
  }
  const added = values.get("new_text");
  const removed = values.get("old_text");
  return {
    ...(added ? { linesAdded: lineCount(added) } : {}),
    ...(removed ? { linesRemoved: lineCount(removed) } : {}),
  };
}
