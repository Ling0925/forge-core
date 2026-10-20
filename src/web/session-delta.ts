import { createHash, randomUUID } from "node:crypto";
import type { SessionSnapshot } from "../shared/schemas";
import type { SessionDelta } from "../shared/session-delta";

const keys = ["messages", "events", "changes"] as const;
function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function fingerprints(snapshot: SessionSnapshot) {
  const { messages, events, changes, ...metadata } = snapshot;
  return {
    metadata: fingerprint(metadata),
    messages: messages.map(fingerprint),
    events: events.map(fingerprint),
    changes: changes.map(fingerprint),
  };
}

type Fingerprints = ReturnType<typeof fingerprints>;
type Version = { readonly revision: string; readonly hashes: Fingerprints };
export interface SessionDeltaCacheLimits {
  readonly maxSessions: number;
  readonly maxVersionsPerSession: number;
  readonly maxFingerprints: number;
}

function sameContent(left: Fingerprints, right: Fingerprints) {
  return (
    left.metadata === right.metadata &&
    keys.every(
      (key) =>
        left[key].length === right[key].length &&
        left[key].every((hash, i) => hash === right[key][i]),
    )
  );
}
function size(version: Version) {
  return 1 + keys.reduce((sum, key) => sum + version.hashes[key].length, 0);
}

// Keep only bounded fingerprints, never a second copy of large transcripts.
// A read does not create a version. Older content versions remain usable by
// other clients until per-session history or the global LRU budget evicts them.
export class SessionDeltaCache {
  private readonly entries = new Map<string, Map<string, Version>>();
  private fingerprintCount = 0;
  private readonly limits: SessionDeltaCacheLimits;

  constructor(limits: Partial<SessionDeltaCacheLimits> = {}) {
    this.limits = {
      maxSessions: 16,
      maxVersionsPerSession: 8,
      maxFingerprints: 100_000,
      ...limits,
    };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid session delta cache limit");
    }
  }

  encode(snapshot: SessionSnapshot, base?: string) {
    const versions =
      this.entries.get(snapshot.id) ?? new Map<string, Version>();
    const previous = base ? versions.get(base) : undefined;
    const hashes = fingerprints(snapshot);
    const latest = [...versions.values()].at(-1);
    const revision =
      latest && sameContent(latest.hashes, hashes)
        ? latest.revision
        : randomUUID();
    if (revision !== latest?.revision) {
      const version = { revision, hashes };
      versions.set(revision, version);
      this.fingerprintCount += size(version);
    }
    this.entries.delete(snapshot.id);
    this.entries.set(snapshot.id, versions);
    while (versions.size > this.limits.maxVersionsPerSession)
      this.evictVersion(snapshot.id, versions);
    while (
      this.entries.size > this.limits.maxSessions ||
      this.fingerprintCount > this.limits.maxFingerprints
    ) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.evictVersion(...oldest);
    }
    if (!previous) return { revision, delta: null };
    const prefix = { messages: 0, events: 0, changes: 0 };
    for (const key of keys) {
      while (
        prefix[key] < hashes[key].length &&
        hashes[key][prefix[key]] === previous.hashes[key][prefix[key]]
      )
        prefix[key]++;
    }
    const delta: SessionDelta = {
      base: previous.revision,
      prefix,
      snapshot: {
        ...snapshot,
        messages: snapshot.messages.slice(prefix.messages),
        events: snapshot.events.slice(prefix.events),
        changes: snapshot.changes.slice(prefix.changes),
      },
    };
    return { revision, delta };
  }

  private evictVersion(sessionId: string, versions: Map<string, Version>) {
    const oldest = versions.values().next().value;
    if (!oldest) return;
    versions.delete(oldest.revision);
    this.fingerprintCount -= size(oldest);
    if (!versions.size) this.entries.delete(sessionId);
  }
}
