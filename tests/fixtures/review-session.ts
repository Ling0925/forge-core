import { createDiffPatch } from "../../src/shared/diff";
import { sessionSnapshotSchema, type SessionSnapshot } from "../../src/shared/schemas";

export function reviewSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return sessionSnapshotSchema.parse({
    version: 1,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Review fixture",
    workspace: process.cwd(),
    model: "session-model",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "completed",
    messages: [],
    events: [],
    changes: [{ path: "src/example.ts", kind: "modified", patch: createDiffPatch("old\n", "new\n") }],
    ...overrides,
  });
}
