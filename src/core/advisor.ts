import { randomUUID } from "node:crypto";
import {
  type AdvisorCoordinator,
  type AdvisorInput,
  type AdvisorRequest,
  advisorAnswerInputSchema,
  advisorInputSchema,
  advisorRequestSchema,
} from "../shared/agent-coordination";
import { ForgeError } from "../shared/errors";

type Entry = {
  record: AdvisorRequest;
  input: string;
  done: Promise<AdvisorRequest>;
  resolve(value: AdvisorRequest): void;
  reject(error: unknown): void;
  cleanup(): void;
};
interface Options {
  parentSessionId: string;
  parentRunId: string;
  isChildActive(childId: string): boolean;
  persist(record: AdvisorRequest): Promise<void>;
  now?: () => string;
}

/** Current-run coordination only. Persistence is owned by the parent's one journal writer. */
export function createAdvisorCoordinator(options: Options): AdvisorCoordinator {
  const now = options.now ?? (() => new Date().toISOString());
  const entries = new Map<string, Entry>();
  const calls = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let writes: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  let fault: unknown;
  const pulse = () => {
    for (const listener of [...listeners]) listener();
  };
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const work = writes.then(action);
    writes = work.catch(() => undefined);
    return work;
  };
  const check = () => {
    if (fault) throw fault;
  };
  const commit = async (entry: Entry, record: AdvisorRequest) => {
    try {
      await options.persist(advisorRequestSchema.parse(record));
      entry.record = record;
      if (record.status !== "pending") {
        entry.cleanup();
        entry.resolve(record);
      }
      pulse();
    } catch (error) {
      fault = new ForgeError(
        "storage",
        "Could not persist advisor coordination; no task was replayed.",
      );
      entry.cleanup();
      entry.reject(fault);
      pulse();
      throw fault;
    }
  };
  const settle = async (
    entry: Entry,
    status: "cancelled" | "expired" | "interrupted",
  ) => {
    if (entry.record.status === "pending")
      await commit(entry, { ...entry.record, status, updatedAt: now() });
  };
  const pending = () => {
    check();
    return [...entries.values()]
      .map((entry) => entry.record)
      .filter((record) => record.status === "pending");
  };
  const terminalFromSignal = (
    entry: Entry,
    status: "cancelled" | "expired",
  ) => {
    void serial(() => settle(entry, status)).catch(() => undefined);
  };

  return {
    forChild(childSessionId) {
      return {
        async ask(rawInput, toolCallId, signal) {
          const input: AdvisorInput = advisorInputSchema.parse(rawInput);
          const entry = await serial(async () => {
            check();
            if (
              closed ||
              signal.aborted ||
              !options.isChildActive(childSessionId)
            )
              throw new ForgeError(
                "cancelled",
                "The parent or child run is no longer accepting advisor requests.",
              );
            const key = `${childSessionId}:${toolCallId}`;
            const existing = calls.get(key);
            if (existing) {
              if (existing.input !== JSON.stringify(input))
                throw new ForgeError(
                  "invalid_input",
                  "An advisor call identifier cannot be reused with a different question.",
                );
              return existing;
            }
            if (
              pending().some(
                (request) => request.childSessionId === childSessionId,
              )
            )
              throw new ForgeError(
                "busy",
                "This child already has a pending advisor question.",
              );
            const { timeout_ms, ...question } = input;
            const createdAt = now();
            const record = advisorRequestSchema.parse({
              ...question,
              id: randomUUID(),
              parentSessionId: options.parentSessionId,
              parentRunId: options.parentRunId,
              childSessionId,
              toolCallId,
              status: "pending",
              createdAt,
              updatedAt: createdAt,
              deadlineAt: new Date(Date.now() + timeout_ms).toISOString(),
            });
            let resolve!: Entry["resolve"];
            let reject!: Entry["reject"];
            const done = new Promise<AdvisorRequest>((yes, no) => {
              resolve = yes;
              reject = no;
            });
            // The caller may still be awaiting the initial commit when it fails.
            void done.catch(() => undefined);
            const next: Entry = {
              record,
              input: JSON.stringify(input),
              done,
              resolve,
              reject,
              cleanup: () => {},
            };
            await commit(next, record);
            entries.set(record.id, next);
            calls.set(key, next);
            const abort = () => terminalFromSignal(next, "cancelled");
            const timer = setTimeout(
              () => terminalFromSignal(next, "expired"),
              timeout_ms,
            );
            next.cleanup = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
            };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            pulse(); // Registration and wake happen only after persistence succeeds.
            return next;
          });
          return entry.done;
        },
        delivered(requestId) {
          return serial(async () => {
            check();
            const entry = entries.get(requestId);
            if (
              !entry ||
              entry.record.childSessionId !== childSessionId ||
              entry.record.status !== "answered"
            )
              throw new ForgeError(
                "invalid_input",
                "Unknown answered request for this child run.",
              );
            if (entry.record.deliveredAt) return;
            await commit(entry, {
              ...entry.record,
              deliveredAt: now(),
              updatedAt: now(),
            });
          });
        },
      };
    },
    answer(rawInput) {
      const input = advisorAnswerInputSchema.parse(rawInput);
      return serial(async () => {
        check();
        const entry = entries.get(input.requestId);
        if (!entry)
          throw new ForgeError(
            "invalid_input",
            "Unknown advisor request in this run; historical requests cannot be answered.",
          );
        if (entry.record.status === "answered") {
          if (
            entry.record.answer === input.answer &&
            entry.record.nextInstruction === input.nextInstruction
          )
            return entry.record;
          throw new ForgeError(
            "invalid_input",
            "This request was already answered differently.",
          );
        }
        if (
          closed ||
          entry.record.status !== "pending" ||
          !options.isChildActive(entry.record.childSessionId)
        )
          throw new ForgeError(
            "invalid_input",
            "This advisor request is no longer pending in an active child.",
          );
        if (Date.now() >= Date.parse(entry.record.deadlineAt)) {
          await settle(entry, "expired");
          throw new ForgeError(
            "invalid_input",
            "This advisor request expired; an answer cannot revive the child task.",
          );
        }
        const { requestId: _requestId, ...reply } = input;
        const answered: AdvisorRequest = {
          ...entry.record,
          ...reply,
          status: "answered",
          updatedAt: now(),
        };
        if (JSON.stringify(answered).length > 120000)
          throw new ForgeError(
            "invalid_input",
            "Advisor reply exceeds the tool-result bound after escaping; provide a shorter answer.",
          );
        await commit(entry, answered);
        return entry.record;
      });
    },
    pending,
    async wait(work, signal) {
      check();
      if (signal.aborted)
        throw new ForgeError("cancelled", "Advisor wait cancelled.");
      if (pending().length) return;
      let wake = () => {};
      let abort = () => {};
      try {
        const change = new Promise<void>((resolve, reject) => {
          wake = () => {
            if (fault) reject(fault);
            else if (pending().length) resolve();
          };
          abort = () =>
            reject(new ForgeError("cancelled", "Advisor wait cancelled."));
          listeners.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          else wake();
        });
        await Promise.race([work, change]);
      } finally {
        listeners.delete(wake);
        signal.removeEventListener("abort", abort);
      }
      check();
    },
    cancelChild(childId) {
      return serial(async () => {
        for (const entry of entries.values())
          if (entry.record.childSessionId === childId)
            await settle(entry, "cancelled");
      });
    },
    close(status) {
      if (closing) return closing;
      closed = true; // Reject new admission before queued commits or child cleanup.
      pulse();
      closing = serial(async () => {
        let failed: unknown;
        for (const entry of entries.values()) {
          try {
            await settle(entry, status);
          } catch (error) {
            failed ??= error;
          } finally {
            entry.cleanup();
            if (entry.record.status === "pending")
              entry.reject(
                failed ??
                  new ForgeError("cancelled", "Advisor coordinator closed."),
              );
          }
        }
        if (failed) throw failed;
      });
      return closing;
    },
  };
}
