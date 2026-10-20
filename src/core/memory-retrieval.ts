import type { SessionStore } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { searchMemorySchema, type ForgeMemoryInput, type MemoryRecord, type MemorySource, type MemoryStore } from "../shared/memory";
import type { SessionSnapshot } from "../shared/schemas";
import { historyText } from "./history";

/** Known credentials and common secret shapes only; not arbitrary-secret detection. */
export function redactMemoryText(text: string, secrets: readonly string[] = []): string {
  let value = text;
  for (const secret of secrets) if (secret) value = value.split(secret).join("[REDACTED]");
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[^\s"\\]+)/gi, "[REDACTED]")
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}]+)/gi, "$1[REDACTED]");
}
export interface MemoryEvidence {
  readonly ref: string;
  readonly source: MemorySource;
  readonly text: string;
  readonly truncated: boolean;
  readonly context?: { readonly role: string; readonly workspace: string; readonly sessionUpdatedAt: string; readonly origin?: string };
}
export const memoryRetrievalLimits = {
  sessions: 500, records: 50000, scanChars: 32_000_000,
  candidates: 60, inputChars: 48000, excerptChars: 1800, memoryChars: 6000,
} as const;
export async function retrieveMemoryEvidence(options: {
  readonly input: ForgeMemoryInput;
  readonly current: SessionSnapshot;
  readonly sessions: SessionStore;
  readonly memories: MemoryStore;
  readonly signal: AbortSignal;
  readonly secrets?: readonly string[];
  readonly limits?: Partial<Record<keyof typeof memoryRetrievalLimits, number>>;
}) {
  const { input, current, sessions, memories, signal } = options;
  const limits = { ...memoryRetrievalLimits, ...options.limits };
  const check = () => { if (signal.aborted) throw new ForgeError("cancelled", "Memory retrieval cancelled."); };
  const clean = (text: string) => redactMemoryText(text, options.secrets);
  const terms = [...new Set((input.keywords.length ? input.keywords : input.query.split(/[\s，。；、,;!?！？]+/u))
    .map(term => clean(term).toLowerCase().slice(0, 256)).filter(Boolean))].slice(0, 16);
  const score = (text: string) => {
    const lower = text.toLowerCase();
    return terms.reduce((sum, term) => sum + Number(lower.includes(term)), 0);
  };
  const coverage = { eligibleSessions: 0, scannedSessions: 0, unreadableSessions: 0, scannedRecords: 0,
    scannedChars: 0, matchedRecords: 0, matchedMemories: 0, scan_truncated: false, selection_truncated: false, excerpt_truncated: false };
  check();
  const listed = input.scope === "session" ? [current] : await sessions.list();
  const eligible = listed.filter(session => input.scope !== "workspace" || session.workspace === current.workspace);
  // The running session may have more recent accepted messages than its last disk save.
  const ordered = [current, ...eligible.filter(session => session.id !== current.id)];
  coverage.eligibleSessions = ordered.length;
  const candidates: (MemoryEvidence & { score: number })[] = [];
  for (const summary of ordered) {
    check();
    if (coverage.scannedSessions + coverage.unreadableSessions >= limits.sessions || coverage.scannedRecords >= limits.records || coverage.scannedChars >= limits.scanChars) {
      coverage.scan_truncated = true;
      break;
    }
    let snapshot: SessionSnapshot;
    try { snapshot = summary.id === current.id ? current : await sessions.get(summary.id); }
    catch { check(); coverage.unreadableSessions++; continue; }
    coverage.scannedSessions++;
    for (let index = snapshot.messages.length - 1; index >= 0; index--) {
      check();
      if (coverage.scannedRecords >= limits.records || coverage.scannedChars >= limits.scanChars) {
        coverage.scan_truncated = true;
        break;
      }
      const message = snapshot.messages[index];
      if (!message || message.role === "system") continue;
      coverage.scannedRecords++;
      if (coverage.scannedRecords % 128 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); check(); }
      // Explicit projection excludes images, private reasoning and provider continuation.
      const raw = historyText(message);
      const remaining = limits.scanChars - coverage.scannedChars;
      if (raw.length > remaining) coverage.scan_truncated = true;
      const text = clean(raw).slice(0, remaining);
      coverage.scannedChars += Math.min(raw.length, remaining);
      const relevance = score(text);
      if (!relevance) continue;
      coverage.matchedRecords++;
      const positions = terms.map(term => text.toLowerCase().indexOf(term)).filter(position => position >= 0);
      const start = Math.max(0, Math.min(...positions) - 180);
      const excerpt = text.slice(start, start + limits.excerptChars);
      candidates.push({ ref: `s:${snapshot.id}:m${index + 1}`,
        source: { kind: "session", sessionId: snapshot.id, recordId: `m${index + 1}` },
        text: excerpt, truncated: start > 0 || start + excerpt.length < text.length || raw.length > remaining,
        context: { role: message.role, workspace: clean(snapshot.workspace), sessionUpdatedAt: snapshot.updatedAt,
          ...(message.role === "user" && message.origin ? { origin: message.origin } : {}) },
        score: relevance * 10 + (message.role === "user" && !message.origin ? 2 : 0) });
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length > limits.candidates) { candidates.pop(); coverage.selection_truncated = true; }
    }
  }
  const related = new Map<number, MemoryRecord>();
  for (const term of terms) {
    check();
    const result = await memories.search(searchMemorySchema.parse({ tags: input.tags, keywords: [term], limit: 50 }));
    if (result.nextOffset !== null) coverage.selection_truncated = true;
    for (const hit of result.hits) {
      if (related.has(hit.id)) continue;
      if (related.size >= limits.candidates) { coverage.selection_truncated = true; break; }
      const record = await memories.get(hit.id);
      check();
      if (record) related.set(record.id, record);
    }
  }
  coverage.matchedMemories = related.size;
  const memoryCandidates = [...related.values()]
    .sort((a, b) => score(`${b.tags.join(" ")} ${b.summary} ${b.details}`) - score(`${a.tags.join(" ")} ${a.summary} ${a.details}`))
    .map(record => {
      const text = clean(JSON.stringify({ tags: record.tags, summary: record.summary, updated_at: record.updated_at, details: record.details }));
      return { ref: `memory:${record.id}:v${record.version}`, source: { kind: "memory" as const, id: record.id, version: record.version },
        text: text.slice(0, limits.memoryChars), truncated: text.length > limits.memoryChars };
    });
  const evidence: MemoryEvidence[] = [];
  const selectedMemories = new Map<number, MemoryRecord>();
  let chars = 0;
  // Reserve half the input for each source type; unused space is shared below.
  const deferred: MemoryEvidence[] = [];
  for (const group of [memoryCandidates, candidates.map(({ score: _score, ...item }) => item)]) {
    let groupChars = 0;
    for (const item of group) {
      const size = JSON.stringify(item).length + 1;
      if (groupChars + size > limits.inputChars / 2) { deferred.push(item); continue; }
      evidence.push(item); groupChars += size; chars += size;
    }
  }
  for (const item of deferred) {
    const size = JSON.stringify(item).length + 1;
    if (chars + size > limits.inputChars) { coverage.selection_truncated = true; continue; }
    evidence.push(item); chars += size;
  }
  for (const item of evidence) {
    if (item.truncated) coverage.excerpt_truncated = true;
    if (item.source.kind === "memory") {
      const record = related.get(item.source.id);
      if (record) selectedMemories.set(record.id, record);
    }
  }
  check();
  return { evidence, memories: selectedMemories, coverage, terms };
}
