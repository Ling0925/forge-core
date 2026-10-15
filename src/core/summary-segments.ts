import type { Message } from "../shared/schemas";

/** Maximum summary requests per compaction. Kept identical to the historical
 * chunk ceiling so a source that would exceed it fails loudly instead of
 * silently issuing an unbounded number of provider calls. */
export const SUMMARY_REQUEST_LIMIT = 16;

/** A bounded, message-aligned fragment of new history handed to one summary
 * request. `from`/`to` are half-open indexes into the same message array the
 * fragments were built from; `part`/`parts` are 1-based and only meaningful
 * when a single over-long group had to be split into several shards. No source
 * record is ever mutated or reordered. */
export type SummaryShard = Readonly<{
  text: string;
  from: number;
  to: number;
  part: number;
  parts: number;
}>;

type Unit = Readonly<{ start: number; end: number; text: string }>;

/** Drops opaque provider continuation from assistant turns, mirroring the
 * existing memory projection: only semantic fields reach the summary request. */
function memoryView(message: Message): unknown {
  if (message.role === "assistant")
    return {
      role: message.role,
      content: message.content,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
  return message;
}

function serializeUnit(
  messages: readonly Message[],
  start: number,
  end: number,
): Unit {
  const part = messages.slice(start, end).map(memoryView);
  return { start, end, text: JSON.stringify(part) };
}

/** Assistant tool_calls plus every immediately following result for those
 * calls form one unit. Normal packing preserves it; only the explicit oversized
 * path may split it. Any other message is a single-message unit. */
function buildUnits(messages: readonly Message[]): readonly Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message === undefined) break;
    if (message.role === "assistant" && message.tool_calls?.length) {
      const ids = new Set(message.tool_calls.map((call) => call.id));
      let end = index + 1;
      while (end < messages.length) {
        const result = messages[end];
        if (result?.role !== "tool" || !ids.has(result.tool_call_id)) break;
        end += 1;
      }
      units.push(serializeUnit(messages, index, end));
      index = end;
      continue;
    }
    units.push(serializeUnit(messages, index, index + 1));
    index += 1;
  }
  return units;
}

/** Split text into bounded pieces without cutting a UTF-16 surrogate pair. */
function splitText(text: string, maxChars: number): readonly string[] {
  const pieces: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxChars, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff && end - 1 > offset) end -= 1;
    }
    pieces.push(text.slice(offset, end));
    offset = end;
  }
  return pieces;
}

/** Explicitly shard one group that alone exceeds the per-request bound, first
 * by whole messages and then by bounded character pieces, always keeping the
 * original order and the message range each shard covers. */
function shardOversizedUnit(
  unit: Unit,
  messages: readonly Message[],
  maxChars: number,
): readonly SummaryShard[] {
  const raw: { text: string; from: number; to: number }[] = [];
  for (let index = unit.start; index < unit.end; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = JSON.stringify(memoryView(message));
    for (const piece of splitText(text, maxChars))
      raw.push({ text: piece, from: index, to: index + 1 });
  }
  const parts = raw.length;
  return raw.map((piece, order) => ({ ...piece, part: order + 1, parts }));
}

/** Bounded segmentation: greedy whole-unit packing up to `maxChars`, with an
 * explicit bounded split for any single unit that cannot fit on its own. */
export function buildSummaryShards(
  messages: readonly Message[],
  maxChars: number,
): readonly SummaryShard[] {
  const bound = Math.max(1, Math.floor(maxChars));
  const shards: SummaryShard[] = [];
  let current: {
    from: number;
    to: number;
    pieces: string[];
    size: number;
  } | null = null;
  const flush = (): void => {
    if (current === null) return;
    shards.push({
      text: current.pieces.join(""),
      from: current.from,
      to: current.to,
      part: 1,
      parts: 1,
    });
    current = null;
  };
  for (const unit of buildUnits(messages)) {
    if (unit.text.length > bound) {
      flush();
      for (const shard of shardOversizedUnit(unit, messages, bound))
        shards.push(shard);
      continue;
    }
    if (current !== null && current.size + unit.text.length > bound) flush();
    if (current === null)
      current = { from: unit.start, to: unit.end, pieces: [], size: 0 };
    current.pieces.push(unit.text);
    current.to = unit.end;
    current.size += unit.text.length;
  }
  flush();
  return shards;
}

/** Compact, bounded human-readable description of the shard ranges a failed
 * run never summarized, so the omission is explicit rather than silent. */
export function describeShardRanges(
  shards: readonly SummaryShard[],
  base: number,
  maxEntries = 6,
): string {
  if (shards.length === 0) return "none";
  const ranges: string[] = [];
  let from = shards[0]?.from ?? 0;
  let to = shards[0]?.to ?? 0;
  let multi = (shards[0]?.parts ?? 1) > 1;
  const push = (): void => {
    ranges.push(
      `${base + from}..${base + to - 1}${multi ? " (split group)" : ""}`,
    );
  };
  for (const shard of shards.slice(1)) {
    if (shard.from === to) {
      to = Math.max(to, shard.to);
      multi ||= shard.parts > 1;
      continue;
    }
    push();
    from = shard.from;
    to = shard.to;
    multi = shard.parts > 1;
  }
  push();
  const head = ranges.slice(0, maxEntries).join(", ");
  return ranges.length > maxEntries
    ? `${head}, +${ranges.length - maxEntries} more`
    : head;
}
