import type { SessionStore } from "../shared/contracts";
import {
  type SessionId,
  type SessionSnapshot,
  sessionSnapshotSchema,
} from "../shared/schemas";
import type { RecordDelta, VersionedSession } from "../shared/session-store";

function records<T>(
  previous: readonly T[],
  next: readonly T[],
): RecordDelta<T> {
  if (previous === next) return { keep: previous.length, append: [] };
  let keep = 0;
  // Runtime state uses immutable records. Replaced objects are explicit rewrites;
  // do not serialize old message bodies to discover an unchanged prefix.
  while (keep < previous.length && previous[keep] === next[keep]) keep++;
  return { keep, append: next.slice(keep) };
}

/** One serialized writer under the session lock; CAS rejects external commits. */
export function createSessionWriter(store: SessionStore, id: SessionId) {
  let previous: VersionedSession | undefined;
  return {
    async read() {
      if (!store.incremental)
        return sessionSnapshotSchema.parse(await store.get(id));
      previous = await store.incremental.read(id);
      return previous.snapshot;
    },
    async save(snapshot: SessionSnapshot) {
      if (!store.incremental || !previous) {
        await store.save(sessionSnapshotSchema.parse(snapshot));
        return;
      }
      const { messages, events, changes, ...metadata } = snapshot;
      const result = await store.incremental.commit(id, {
        baseRevision: previous.revision,
        metadata,
        messages: records(previous.snapshot.messages, messages),
        events: records(previous.snapshot.events, events),
        changes: records(previous.snapshot.changes, changes),
      });
      // Retain the caller's immutable record identities, not the validator's
      // copies. The persisted result is validated by the incremental store.
      previous = { revision: result.revision, snapshot };
    },
  };
}
