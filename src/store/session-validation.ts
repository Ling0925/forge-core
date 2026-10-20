import { isAbsolute } from "node:path";
import { ForgeError } from "../shared/errors";
import {
  type Message,
  type SessionSnapshot,
  sessionSnapshotSchema,
} from "../shared/schemas";
import type { RecordDelta } from "../shared/session-store";
import { storageError } from "./io";

const shape = sessionSnapshotSchema.unwrap();
const metadataSchema = shape.omit({
  messages: true,
  events: true,
  changes: true,
});
const pendingCalls = new WeakMap<SessionSnapshot, ReadonlySet<string>>();
function invalid(persisted: boolean): never {
  throw persisted
    ? storageError()
    : new ForgeError("invalid_input", "Invalid session snapshot.");
}
function advanceCalls(
  messages: readonly Message[],
  initial: ReadonlySet<string> = new Set(),
) {
  const pending = new Set(initial);
  for (const message of messages) {
    if (message.role === "assistant") {
      if (pending.size !== 0) throw storageError();
      for (const call of message.tool_calls ?? []) {
        if (pending.has(call.id)) throw storageError();
        pending.add(call.id);
      }
    } else if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) throw storageError();
    } else if (pending.size !== 0) throw storageError();
  }
  return pending;
}
function relationships(snapshot: SessionSnapshot, persisted: boolean) {
  if (
    !isAbsolute(snapshot.workspace) ||
    snapshot.updatedAt < snapshot.createdAt
  )
    invalid(persisted);
}
export function validateSnapshot(
  value: unknown,
  persisted: boolean,
): SessionSnapshot {
  const parsed = sessionSnapshotSchema.safeParse(value);
  if (!parsed.success) return invalid(persisted);
  const snapshot = parsed.data;
  relationships(snapshot, persisted);
  if (snapshot.events.some((event) => event.sessionId !== snapshot.id))
    invalid(persisted);
  pendingCalls.set(snapshot, advanceCalls(snapshot.messages));
  return snapshot;
}
function apply<T>(
  previous: readonly T[],
  change: RecordDelta<T>,
  limit: number,
  persisted: boolean,
) {
  if (
    !Number.isSafeInteger(change.keep) ||
    change.keep < 0 ||
    change.keep > previous.length ||
    change.keep + change.append.length > limit
  )
    invalid(persisted);
  if (change.keep === previous.length && !change.append.length) return previous;
  return Object.freeze([...previous.slice(0, change.keep), ...change.append]);
}
/** Validate only new records; history replacements deliberately revalidate tool pairing. */
export function validateChange(
  previous: SessionSnapshot,
  change: {
    metadata: unknown;
    messages: RecordDelta<unknown>;
    events: RecordDelta<unknown>;
    changes: RecordDelta<unknown>;
  },
  persisted: boolean,
) {
  const metadata = metadataSchema.safeParse(change.metadata);
  const messages = shape.shape.messages.safeParse(change.messages.append);
  const events = shape.shape.events.safeParse(change.events.append);
  const changes = shape.shape.changes.safeParse(change.changes.append);
  if (
    !metadata.success ||
    !messages.success ||
    !events.success ||
    !changes.success
  )
    return invalid(persisted);
  if (
    metadata.data.id !== previous.id ||
    events.data.some((event) => event.sessionId !== previous.id)
  )
    invalid(persisted);
  const snapshot = Object.freeze({
    ...metadata.data,
    messages: apply(
      previous.messages,
      { ...change.messages, append: messages.data },
      100_000,
      persisted,
    ),
    events: apply(
      previous.events,
      { ...change.events, append: events.data },
      1_000_000,
      persisted,
    ),
    changes: apply(
      previous.changes,
      { ...change.changes, append: changes.data },
      100_000,
      persisted,
    ),
  });
  relationships(snapshot, persisted);
  const pending =
    change.messages.keep === previous.messages.length
      ? advanceCalls(
          messages.data,
          pendingCalls.get(previous) ?? advanceCalls(previous.messages),
        )
      : advanceCalls(snapshot.messages);
  pendingCalls.set(snapshot, pending);
  return snapshot;
}
