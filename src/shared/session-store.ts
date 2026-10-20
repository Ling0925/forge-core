import type { SessionId, SessionSnapshot } from "./schemas";

export type SessionMetadata = Omit<
  SessionSnapshot,
  "messages" | "events" | "changes"
>;
export interface RecordDelta<T> {
  /** Retain this prefix, then append. Shorter prefixes explicitly replace history. */
  readonly keep: number;
  readonly append: readonly T[];
}
export interface SessionMutation {
  /** Compare-and-swap token; callers must also hold the existing session lock. */
  readonly baseRevision: string;
  /** Complete metadata replacement, so omitted optional fields are removed. */
  readonly metadata: SessionMetadata;
  readonly messages: RecordDelta<SessionSnapshot["messages"][number]>;
  readonly events: RecordDelta<SessionSnapshot["events"][number]>;
  readonly changes: RecordDelta<SessionSnapshot["changes"][number]>;
}
export interface VersionedSession {
  readonly revision: string;
  readonly snapshot: SessionSnapshot;
}
export interface SessionChange extends Omit<SessionMutation, "baseRevision"> {
  readonly before: string;
  readonly after: string;
}
export type SessionChanges =
  | { readonly revision: string; readonly changes: readonly SessionChange[] }
  | { readonly revision: string; readonly snapshot: SessionSnapshot };
export interface IncrementalSessionStore {
  read(id: SessionId): Promise<VersionedSession>;
  commit(id: SessionId, mutation: SessionMutation): Promise<VersionedSession>;
  /** Unknown/old generation tokens return a full snapshot. Never apply mismatched deltas. */
  changesSince(id: SessionId, revision: string): Promise<SessionChanges>;
}
