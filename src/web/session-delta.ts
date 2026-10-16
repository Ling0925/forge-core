import { createHash, randomUUID } from "node:crypto";
import type { SessionSnapshot } from "../shared/schemas";
import type { SessionDelta } from "../shared/session-delta";

const keys = ["messages", "events", "changes"] as const;
function fingerprints(snapshot: SessionSnapshot) {
  const hash = (items: readonly unknown[]) => items.map(item =>
    createHash("sha256").update(JSON.stringify(item)).digest("hex"));
  return { messages: hash(snapshot.messages), events: hash(snapshot.events), changes: hash(snapshot.changes) };
}

// Keep only hashes, never a second copy of large transcripts, on the host.
export class SessionDeltaCache {
  private readonly entries = new Map<string, {
    readonly revision: string;
    readonly hashes: ReturnType<typeof fingerprints>;
  }>();

  encode(snapshot: SessionSnapshot, base?: string) {
    const previous = this.entries.get(snapshot.id);
    const hashes = fingerprints(snapshot);
    const revision = randomUUID();
    this.entries.delete(snapshot.id);
    this.entries.set(snapshot.id, { revision, hashes });
    let count = 0;
    let entries = 0;
    for (const entry of [...this.entries].reverse()) {
      entries++;
      count += keys.reduce((sum, key) => sum + entry[1].hashes[key].length, 0);
      if (count > 100_000 || entries > 16) this.entries.delete(entry[0]);
    }
    if (!base || previous?.revision !== base) return { revision, delta: null };
    const prefix = { messages: 0, events: 0, changes: 0 };
    for (const key of keys) {
      while (prefix[key] < hashes[key].length &&
        hashes[key][prefix[key]] === previous.hashes[key][prefix[key]]) prefix[key]++;
    }
    const delta: SessionDelta = {
      base, prefix,
      snapshot: {
        ...snapshot,
        messages: snapshot.messages.slice(prefix.messages),
        events: snapshot.events.slice(prefix.events),
        changes: snapshot.changes.slice(prefix.changes),
      },
    };
    return { revision, delta };
  }
}
