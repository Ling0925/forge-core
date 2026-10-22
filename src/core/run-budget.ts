import { randomUUID } from "node:crypto";
import { ForgeError } from "../shared/errors";
import {
  type RootBudgetSnapshot,
  type RootRunBudget,
  rootBudgetSnapshotSchema,
} from "../shared/run-budget";
import type { Usage } from "../shared/schemas";

type Observation = RootBudgetSnapshot["usage"];
type Session = RootBudgetSnapshot["sessions"][number];
const emptyUsage = (): Observation => ({
  basis: "reported",
  reportedRequests: 0,
  missingRequests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedPromptTokens: 0,
  complete: true,
});
function observe(target: Observation, usage: Usage | undefined): void {
  if (!usage) {
    target.missingRequests++;
    target.complete = false;
    return;
  }
  target.reportedRequests++;
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
  target.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
}
/** Shared observations only: tool attempts, elapsed time and child totals never stop a run. */
export function createRootRunBudget(options: {
  rootSessionId: string;
}): RootRunBudget {
  const startedAt = new Date().toISOString();
  const rootRunId = randomUUID();
  const sessions = new Map<string, Session>();
  const usage = emptyUsage();
  let consumed = 0;
  let reserved = 0;
  let closed = false;
  const check = () => {
    if (closed)
      throw new ForgeError(
        "budget",
        "This root run has ended; its ledger cannot be resumed.",
      );
  };
  const session = (id: string) => {
    const item = sessions.get(id);
    if (!item)
      throw new ForgeError(
        "internal",
        "Session has not entered the root ledger.",
      );
    return item;
  };
  return {
    enter(id) {
      check();
      if (sessions.has(id))
        throw new ForgeError(
          "budget",
          "A session cannot restart inside the same root run.",
        );
      sessions.set(id, {
        sessionId: id,
        consumed: 0,
        reserved: 0,
        status: "running",
        reason: null,
        usage: emptyUsage(),
      });
    },
    check,
    checkAdmission: check,
    reserve(id, count) {
      check();
      if (!Number.isSafeInteger(count) || count < 1)
        throw new ForgeError("internal", "Invalid tool reservation.");
      const item = session(id);
      reserved += count;
      item.reserved += count;
      let pending = count;
      return {
        dispatch(count = 1) {
          check();
          if (!Number.isSafeInteger(count) || count < 1 || pending < count)
            throw new ForgeError(
              "internal",
              "Tool reservation already consumed or released.",
            );
          pending -= count;
          reserved -= count;
          item.reserved -= count;
          consumed += count;
          item.consumed += count;
        },
        release() {
          reserved -= pending;
          item.reserved -= pending;
          pending = 0;
        },
      };
    },
    beginUsage(id) {
      if (closed) return () => {};
      const item = session(id);
      observe(usage, undefined);
      observe(item.usage, undefined);
      let settled = false;
      return (incoming) => {
        if (settled || closed) return;
        settled = true;
        if (!incoming) return;
        for (const target of [usage, item.usage]) {
          target.missingRequests--;
          observe(target, incoming);
          target.complete = target.missingRequests === 0;
        }
      };
    },
    observeUsage(id, incoming) {
      if (closed) return;
      observe(usage, incoming);
      observe(session(id).usage, incoming);
    },
    finishSession(id, status, reason) {
      if (closed) return;
      const item = sessions.get(id);
      if (item) {
        item.status = status;
        item.reason = reason;
      }
    },
    snapshot(sessionId) {
      return rootBudgetSnapshotSchema.parse({
        rootRunId,
        rootSessionId: options.rootSessionId,
        maxToolCalls: null,
        timeoutMs: null,
        startedAt,
        deadlineAt: null,
        consumed,
        reserved,
        remaining: null,
        stopReason: null,
        usage,
        // Child events do not duplicate the ever-growing whole-tree ledger.
        sessions: sessionId === undefined ? [...sessions.values()] : [session(sessionId)],
      });
    },
    close() {
      closed = true;
    },
  };
}
