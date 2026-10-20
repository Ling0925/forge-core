import { randomUUID } from "node:crypto";
import { ForgeError } from "../shared/errors";
import {
  DEFAULT_ROOT_TIMEOUT_MS,
  type RootBudgetSnapshot,
  type RootRunBudget,
  rootBudgetSnapshotSchema,
  rootTimeoutSchema,
  rootToolLimitSchema,
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
/** Synchronous admission is atomic across all children in this root runtime. */
export function createRootRunBudget(options: {
  rootSessionId: string;
  maxToolCalls: number;
  timeoutMs?: number;
  /** Monotonic clock injection for deterministic boundary tests. */
  clock?: () => number;
}): RootRunBudget {
  const maxToolCalls = rootToolLimitSchema.parse(options.maxToolCalls);
  const timeoutMs = rootTimeoutSchema.parse(
    options.timeoutMs ?? DEFAULT_ROOT_TIMEOUT_MS,
  );
  const clock = options.clock ?? (() => performance.now());
  const start = clock();
  const startedAt = new Date();
  const rootRunId = randomUUID();
  const controller = new AbortController();
  const sessions = new Map<string, Session>();
  const usage = emptyUsage();
  let consumed = 0;
  let reserved = 0;
  let closed = false;
  let stopReason: "tools" | "deadline" | null = null;
  const expire = () => {
    if (closed) return;
    stopReason = "deadline";
    controller.abort();
  };
  const timer = setTimeout(expire, timeoutMs);
  timer.unref();
  const refresh = () => {
    if (!closed && clock() - start >= timeoutMs) expire();
  };
  const check = () => {
    refresh();
    if (closed)
      throw new ForgeError(
        "budget",
        "This root run has ended; its budget cannot be resumed.",
      );
    if (stopReason === "deadline")
      throw new ForgeError("budget", "Root run deadline exhausted.");
  };
  const checkAdmission = () => {
    check();
    if (consumed + reserved >= maxToolCalls) {
      stopReason = "tools";
      throw new ForgeError(
        "budget",
        "Root shared tool attempt budget exhausted.",
      );
    }
  };
  const session = (id: string) => {
    const item = sessions.get(id);
    if (!item)
      throw new ForgeError(
        "internal",
        "Session has not entered the root budget.",
      );
    return item;
  };
  return {
    signal: controller.signal,
    maxToolCalls,
    timeoutMs,
    get remainingTimeMs() {
      return Math.max(0, timeoutMs - (clock() - start));
    },
    get remaining() {
      return maxToolCalls - consumed - reserved;
    },
    get stopReason() {
      refresh();
      return stopReason;
    },
    enter(id) {
      check();
      if (sessions.has(id))
        throw new ForgeError(
          "budget",
          "A session cannot restart inside the same root run.",
        );
      if (sessions.size >= 33)
        throw new ForgeError("budget", "Root run session bound exhausted.");
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
    checkAdmission,
    reserve(id, count) {
      checkAdmission();
      if (!Number.isSafeInteger(count) || count < 1)
        throw new ForgeError("internal", "Invalid tool reservation.");
      if (count > maxToolCalls - consumed - reserved) {
        stopReason = "tools";
        throw new ForgeError(
          "budget",
          "Root shared tool attempt budget cannot admit this batch.",
        );
      }
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
      const item = sessions.get(id);
      if (item) {
        item.status = status;
        item.reason = reason;
      }
    },
    snapshot() {
      refresh();
      return rootBudgetSnapshotSchema.parse({
        rootRunId,
        rootSessionId: options.rootSessionId,
        maxToolCalls,
        timeoutMs,
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
        consumed,
        reserved,
        remaining: maxToolCalls - consumed - reserved,
        stopReason,
        usage,
        sessions: [...sessions.values()],
      });
    },
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
