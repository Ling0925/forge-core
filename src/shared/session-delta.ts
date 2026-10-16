import { z } from "zod";
import { sessionSnapshotSchema, type SessionSnapshot } from "./schemas";

const offset = z.number().int().nonnegative();
export const sessionDeltaSchema = z.object({
  base: z.string().uuid(),
  prefix: z.object({ messages: offset, events: offset, changes: offset }).strict(),
  snapshot: sessionSnapshotSchema,
}).strict();
export type SessionDelta = z.infer<typeof sessionDeltaSchema>;

export function applySessionDelta(
  previous: SessionSnapshot,
  revision: string,
  delta: SessionDelta,
): SessionSnapshot {
  if (revision !== delta.base || previous.id !== delta.snapshot.id)
    throw new Error("Session cache revision mismatch");
  for (const key of ["messages", "events", "changes"] as const) {
    if (delta.prefix[key] > previous[key].length)
      throw new Error("Invalid session cache prefix");
  }
  return {
    ...delta.snapshot,
    messages: [...previous.messages.slice(0, delta.prefix.messages), ...delta.snapshot.messages],
    events: [...previous.events.slice(0, delta.prefix.events), ...delta.snapshot.events],
    changes: [...previous.changes.slice(0, delta.prefix.changes), ...delta.snapshot.changes],
  };
}
