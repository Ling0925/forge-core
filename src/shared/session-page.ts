import { z } from "zod";
import { ForgeError } from "./errors";
import { executionTurns } from "./execution";
import {
  type AgentEvent,
  type SessionSnapshot,
  sessionSnapshotSchema,
} from "./schemas";
import { sessionUsageStateSchema, summarizeUsageState } from "./session-usage";

const offsetSchema = z.number().int().nonnegative();

/**
 * A cursor into a paged transcript.
 *
 * - `before` is the `messageOffset` of an already loaded page; the preceding
 *   complete execution turn is returned.
 * - `from` is the `messageOffset` of the oldest loaded page; that turn through
 *   the current tail is returned so a live refresh keeps the loaded window.
 *
 * Cursors must be execution-turn boundaries. Anything else is rejected instead
 * of silently slicing a tool exchange.
 */
export const sessionPageRequestSchema = z
  .object({
    before: offsetSchema.optional(),
    from: offsetSchema.optional(),
  })
  .strict()
  .readonly()
  .refine(
    (request) => request.before === undefined || request.from === undefined,
    {
      message: "`before` and `from` are mutually exclusive.",
    },
  );
export type SessionPageRequest = z.infer<typeof sessionPageRequestSchema>;

export const sessionPageInfoSchema = z
  .object({
    messageOffset: offsetSchema,
    eventOffset: offsetSchema,
    messageEnd: offsetSchema,
    eventEnd: offsetSchema,
    totalMessages: offsetSchema,
    firstTurn: z.number().int().positive(),
    hasMore: z.boolean(),
    /** Fixed-size prefix totals; only present when `eventOffset` is non-zero. */
    usageBefore: sessionUsageStateSchema.optional(),
  })
  .strict()
  .readonly();
export type SessionPageInfo = z.infer<typeof sessionPageInfoSchema>;

export const sessionPageSchema = z
  .object({
    snapshot: sessionSnapshotSchema,
    page: sessionPageInfoSchema,
  })
  .strict()
  .readonly();
export type SessionPage = z.infer<typeof sessionPageSchema>;

/**
 * Renderer-only view metadata. It never changes the persisted session schema:
 * the transcript knows which absolute slice of the durable log it represents.
 */
export type TranscriptSnapshot = SessionSnapshot & {
  readonly transcript?: SessionPageInfo;
};

interface TurnSpan {
  readonly turn: number;
  readonly messageStart: number;
  readonly messageEnd: number;
  readonly eventStart: number;
  readonly eventEnd: number;
}

const invalidCursor = (): never => {
  throw new ForgeError(
    "invalid_input",
    "The session page cursor is not an existing execution-turn boundary.",
  );
};

const validateRequest = (request: SessionPageRequest): void => {
  for (const [name, value] of [
    ["before", request.before],
    ["from", request.from],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ForgeError(
        "invalid_input",
        `Session page "${name}" must be a nonnegative safe integer.`,
      );
    }
  }
  if (request.before !== undefined && request.from !== undefined) {
    throw new ForgeError(
      "invalid_input",
      "Session page `before` and `from` are mutually exclusive.",
    );
  }
};

const changesIn = (
  events: readonly AgentEvent[],
): SessionSnapshot["changes"] => {
  const changes: SessionSnapshot["changes"][number][] = [];
  for (const event of events) {
    if (event.type === "tool_finished" && event.result.changes?.length) {
      changes.push(...event.result.changes);
    }
  }
  return changes;
};

/**
 * Reuse the shared execution-turn detector, then map each turn back to a
 * contiguous slice of the original event log. Both arrays stay in their durable
 * order so the renderer can merge pages without renumbering records.
 */
const turnSpans = (snapshot: SessionSnapshot): readonly TurnSpan[] => {
  const turns = executionTurns(snapshot);
  const totalMessages = snapshot.messages.length;
  const totalEvents = snapshot.events.length;
  const positions = new Map<AgentEvent, number>();
  snapshot.events.forEach((event, index) => {
    if (!positions.has(event)) positions.set(event, index);
  });
  const starts: (number | undefined)[] = turns.map((turn) => {
    const first = turn.events[0];
    return first === undefined ? undefined : positions.get(first);
  });
  const anyKnown = starts.some((start) => start !== undefined);
  if (!anyKnown && totalEvents > 0 && starts.length > 0) {
    // Old/partial snapshots can contain events without any run_started anchor.
    // Keep them with the current (last) turn instead of dropping them from the
    // default page; earlier turns remain empty.
    starts.fill(0);
  } else {
    let next = totalEvents;
    for (let index = starts.length - 1; index >= 0; index--) {
      const start = starts[index];
      if (start === undefined) starts[index] = next;
      else next = Math.min(start, next);
    }
  }
  // Clamp to the durable log and keep the slices monotonic even if a partial
  // write left a run_started anchor beyond the persisted messages.
  let eventCursor = 0;
  for (let index = 0; index < starts.length; index++) {
    eventCursor = Math.max(
      eventCursor,
      Math.min(starts[index] ?? totalEvents, totalEvents),
    );
    starts[index] = eventCursor;
  }
  let messageCursor = 0;
  return turns.map((turn, index): TurnSpan => {
    const messageStart = Math.max(
      messageCursor,
      Math.min(turn.messageStart, totalMessages),
    );
    messageCursor = messageStart;
    const messageEnd = Math.max(
      messageStart,
      Math.min(turn.messageEnd, totalMessages),
    );
    const eventStart = starts[index] ?? totalEvents;
    const eventEnd = Math.max(
      eventStart,
      index + 1 < starts.length
        ? (starts[index + 1] ?? totalEvents)
        : totalEvents,
    );
    return {
      turn: turn.turn,
      messageStart,
      messageEnd,
      eventStart,
      eventEnd,
    };
  });
};

const pageOffset = (spans: readonly TurnSpan[], index: number): number =>
  index === 0 ? 0 : (spans[index]?.messageStart ?? 0);

const pageEventOffset = (spans: readonly TurnSpan[], index: number): number =>
  index === 0 ? 0 : (spans[index]?.eventStart ?? 0);

/**
 * Return only the latest durable execution turn by default, the preceding turn
 * for `before`, or the loaded window through the tail for `from`. A trailing
 * run marker whose user message has not been persisted yet is merged into the
 * latest durable turn so the default page cannot become an empty transcript.
 * Nothing is written back: disk history and model context are untouched.
 */
export function paginateSession(
  snapshot: SessionSnapshot,
  request: SessionPageRequest = {},
): SessionPage {
  validateRequest(request);
  const totalMessages = snapshot.messages.length;
  const totalEvents = snapshot.events.length;
  const spans = turnSpans(snapshot);
  // A run_started event can reach storage before its user message. Treat such a
  // zero-length trailing turn as a future marker and merge it into the last turn
  // that has durable messages, so the default page never becomes an empty
  // transcript that hides the preceding turn. Once the user message lands the
  // marker becomes a normal turn again.
  let trailingStart = spans.length;
  while (
    trailingStart > 0 &&
    (spans[trailingStart - 1]?.messageStart ?? 0) >= totalMessages
  ) {
    trailingStart -= 1;
  }
  const mergedTrailing = trailingStart < spans.length;
  const mergedIndex = trailingStart === 0 ? 0 : trailingStart - 1;
  const finish = (
    selected: number | undefined,
    throughTail: boolean,
  ): SessionPage => {
    if (selected === undefined) {
      // A session without any execution turn still has records to show (system
      // or partial messages, orphan events). Never truncate them.
      const page: SessionPageInfo = {
        messageOffset: 0,
        eventOffset: 0,
        messageEnd: totalMessages,
        eventEnd: totalEvents,
        totalMessages,
        firstTurn: 1,
        hasMore: false,
      };
      return {
        snapshot: {
          ...snapshot,
          messages: snapshot.messages.slice(),
          events: snapshot.events.slice(),
          changes: changesIn(snapshot.events),
        },
        page,
      };
    }
    const first = spans[selected] ?? invalidCursor();
    const messageOffset = pageOffset(spans, selected);
    const eventOffset = pageEventOffset(spans, selected);
    const messageEnd = throughTail
      ? totalMessages
      : Math.max(messageOffset, first.messageEnd);
    const eventEnd = throughTail
      ? totalEvents
      : Math.max(eventOffset, first.eventEnd);
    const pageEvents = snapshot.events.slice(eventOffset, eventEnd);
    const usageBefore =
      eventOffset > 0
        ? summarizeUsageState(snapshot.events.slice(0, eventOffset))
        : undefined;
    const page: SessionPageInfo = {
      messageOffset,
      eventOffset,
      messageEnd,
      eventEnd,
      totalMessages,
      firstTurn: first.turn,
      hasMore: messageOffset > 0,
      ...(usageBefore === undefined ? {} : { usageBefore }),
    };
    return {
      snapshot: {
        ...snapshot,
        messages: snapshot.messages.slice(messageOffset, messageEnd),
        events: pageEvents,
        changes: changesIn(pageEvents),
      },
      page,
    };
  };

  if (request.before !== undefined) {
    const boundary = spans.findIndex(
      (_, index) => pageOffset(spans, index) === request.before,
    );
    if (boundary < 0) invalidCursor();
    if (mergedTrailing && boundary >= trailingStart) {
      if (mergedIndex === 0 && trailingStart === 0) {
        throw new ForgeError(
          "invalid_input",
          "No earlier session page is available.",
        );
      }
      return finish(mergedIndex, false);
    }
    if (boundary === 0) {
      throw new ForgeError(
        "invalid_input",
        "No earlier session page is available.",
      );
    }
    return finish(boundary - 1, false);
  }
  if (request.from !== undefined) {
    if (spans.length === 0) {
      if (request.from === 0) return finish(undefined, true);
      invalidCursor();
    }
    const boundary = spans.findIndex(
      (_, index) => pageOffset(spans, index) === request.from,
    );
    if (boundary < 0) invalidCursor();
    if (mergedTrailing && boundary >= trailingStart) {
      return finish(mergedIndex, true);
    }
    return finish(boundary, true);
  }
  if (spans.length === 0) return finish(undefined, false);
  if (mergedTrailing) return finish(mergedIndex, true);
  return finish(spans.length - 1, false);
}
