import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ForgeError, toErrorInfo } from "../shared/errors";
import {
  QueueAdmissionError,
  enqueueInputSchema,
  inputQueueSnapshotSchema,
  queuedInputSchema,
} from "../shared/input-queue";
import type {
  InputQueueHost,
  InputQueueRunner,
  QueuedInput,
} from "../shared/input-queue";
import {
  errorMessageSchema,
  runInputSchema,
  sessionIdSchema,
} from "../shared/schemas";
import type {
  ProviderConfig,
  RunInput,
  SessionId,
  SessionSnapshot,
} from "../shared/schemas";
import {
  atomicJson,
  privateDirectory,
  readJson,
  storageError,
} from "../store/io";
import { fileLock } from "../store/lock";

const MAX_PENDING = 500;
const MAX_SESSION_PENDING = 100;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPTS = 4096;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const inputProviderBinding = (
  config: ProviderConfig,
  model: string,
  sourceId?: string,
) => digest([sourceId ?? null, config.baseUrl, config.apiMode ?? null, model]);
export function inputPredecessor(snapshot: SessionSnapshot) {
  const active =
    ["running", "awaiting_approval"].includes(snapshot.status) ||
    !!snapshot.pendingTool;
  return {
    active,
    unsafe:
      active ||
      ["failed", "cancelled", "interrupted"].includes(snapshot.status),
    // Titles, context counters and unrelated metadata do not acknowledge or
    // invalidate review of a particular predecessor and uncertain tool intent.
    token: digest([
      snapshot.id,
      snapshot.status,
      snapshot.pendingTool ?? null,
      snapshot.events.findLast((event) => event.type === "run_started") ?? null,
      snapshot.events.findLast((event) => event.type === "run_finished") ??
        null,
    ]),
  };
}
type Predecessor = ReturnType<typeof inputPredecessor>;
const storedItemSchema = queuedInputSchema.unwrap().extend({
  requestHash: z.string().length(64),
  providerBinding: z.string().length(64),
  acknowledgedPredecessor: z.string().length(64).optional(),
});
const ledgerSchema = z
  .object({
    version: z.literal(1),
    nextSequence: z.number().int().positive().safe(),
    items: z.array(storedItemSchema).max(MAX_RECEIPTS),
    sessions: z.record(
      z
        .object({
          paused: z.boolean(),
          reason: errorMessageSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();
type Ledger = z.infer<typeof ledgerSchema>;
type StoredItem = z.infer<typeof storedItemSchema>;
const pending = (item: QueuedInput) =>
  ["queued", "bound", "blocked", "uncertain"].includes(item.state);
const publicItem = ({
  requestHash: _requestHash,
  providerBinding: _providerBinding,
  acknowledgedPredecessor: _acknowledgedPredecessor,
  ...item
}: StoredItem): QueuedInput => queuedInputSchema.parse(item);

/** One durable ledger and one host consumer. Accepted inputs never depend on a page lease. */
export async function openInputQueue(options: {
  directory: string;
  validateSession(id: SessionId): Promise<void>;
  /** acknowledge=true must inspect under the session lock with no live owner. */
  predecessor?(id: SessionId, acknowledge?: boolean): Promise<Predecessor>;
  prepare(
    input: RunInput,
  ): Promise<{ input: RunInput; providerBinding: string }>;
}): Promise<InputQueueHost> {
  const directory = await privateDirectory(
    join(options.directory, "input-queue"),
  );
  const path = join(directory, "queue.json");
  const receipts = await privateDirectory(join(directory, "receipts"));
  const ledgerIO = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      if (error instanceof ForgeError && error.code === "storage") {
        stopped = true;
        storageFailed = true;
      }
      throw error;
    }
  };
  const compact = async (ledger: Ledger) => {
    for (const item of ledger.items) {
      if (item.state === "consumed" || item.state === "cancelled")
        await ledgerIO(
          atomicJson(join(receipts, `${item.inputId}.json`), item),
        );
    }
    ledger.items = ledger.items.filter(pending);
    const sessions = new Set<string>(
      ledger.items.map((item) => item.sessionId),
    );
    for (const [id, state] of Object.entries(ledger.sessions))
      if (!state.paused && !sessions.has(id)) delete ledger.sessions[id];
  };
  const receipt = async (id: string): Promise<StoredItem | undefined> => {
    try {
      const parsed = storedItemSchema.safeParse(
        await ledgerIO(readJson(join(receipts, `${id}.json`))),
      );
      if (!parsed.success || parsed.data.inputId !== id) throw storageError();
      return parsed.data;
    } catch (error) {
      if (error instanceof ForgeError && error.code === "not_found")
        return undefined;
      throw error;
    }
  };
  let serial: Promise<unknown> = Promise.resolve();
  const acquireLedger = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        return await fileLock(join(directory, "queue.lock"));
      } catch (error) {
        if (
          !(error instanceof ForgeError) ||
          error.code !== "busy" ||
          Date.now() >= deadline
        )
          throw error;
        // No ledger mutation/effect has started; waiting for its lock is safe.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  const transaction = <T>(
    change: (ledger: Ledger) => Promise<T> | T,
    write = true,
  ): Promise<T> => {
    const work = serial.then(async () => {
      const release = write ? await ledgerIO(acquireLedger()) : async () => {};
      try {
        let ledger: Ledger;
        try {
          const parsed = ledgerSchema.safeParse(await ledgerIO(readJson(path)));
          if (!parsed.success) throw storageError();
          ledger = parsed.data;
          const ids = new Set<string>();
          let sequence = 0;
          if (Object.keys(ledger.sessions).length > MAX_RECEIPTS)
            throw storageError();
          for (const item of ledger.items) {
            if (
              ids.has(item.inputId) ||
              item.sequence <= sequence ||
              item.sequence >= ledger.nextSequence ||
              (item.input && item.input.sessionId !== item.sessionId) ||
              (["queued", "blocked"].includes(item.state) &&
                (!item.input || item.runId !== null)) ||
              (["bound", "uncertain"].includes(item.state) &&
                (!item.input || !item.runId)) ||
              (item.state === "consumed" &&
                (!item.outcome ||
                  !item.runId ||
                  (item.outcome === "completed" && item.input !== null))) ||
              (item.state === "cancelled" &&
                (item.runId !== null || item.input !== null))
            )
              throw storageError();
            ids.add(item.inputId);
            sequence = item.sequence;
          }
        } catch (error) {
          if (!(error instanceof ForgeError) || error.code !== "not_found") {
            if (error instanceof ForgeError && error.code === "storage") {
              stopped = true;
              storageFailed = true;
            }
            throw error;
          }
          ledger = { version: 1, nextSequence: 1, items: [], sessions: {} };
        }
        if (write) await compact(ledger);
        const result = await change(ledger);
        if (write) {
          await compact(ledger);
          await ledgerIO(atomicJson(path, ledger, 48 * 1024 * 1024));
        }
        return result;
      } finally {
        await ledgerIO(release());
      }
    });
    serial = work.catch(() => undefined);
    return work;
  };
  const snapshot = (ledger: Ledger, sessionId: SessionId) => {
    const blocked = ledger.items.find(
      (item) =>
        item.sessionId === sessionId &&
        (item.state === "blocked" ||
          (item.state === "uncertain" &&
            ledger.sessions[sessionId]?.paused !== false)),
    );
    return inputQueueSnapshotSchema.parse({
      sessionId,
      ...(ledger.sessions[sessionId] ?? { paused: false }),
      ...(blocked ? { paused: true, reason: blocked.reason } : {}),
      items: ledger.items
        .filter((item) => item.sessionId === sessionId)
        .map(publicItem),
    });
  };
  const block = (ledger: Ledger, item: StoredItem, error: unknown) => {
    item.error = toErrorInfo(error);
    item.reason = item.error.message;
    item.state = item.runId ? "uncertain" : "blocked";
    item.updatedAt = new Date().toISOString();
    const state = ledger.sessions[item.sessionId];
    if (state) {
      state.paused = true;
      state.reason = item.reason;
    }
  };
  let runner: InputQueueRunner | undefined;
  let ownerRelease: (() => Promise<void>) | undefined;
  let attaching: Promise<void> | undefined;
  let stopped = false;
  let storageFailed = false;
  const check = () => {
    if (stopped)
      throw new ForgeError(
        storageFailed ? "storage" : "cancelled",
        storageFailed
          ? "Queue persistence failed. Inspect queued/bound records and restart the host before scheduling more work."
          : "The queue host is stopping.",
      );
  };
  const setState = (
    ledger: Ledger,
    id: SessionId,
    state: Ledger["sessions"][string],
  ) => {
    if (
      !ledger.sessions[id] &&
      Object.keys(ledger.sessions).length >= MAX_RECEIPTS
    )
      throw new ForgeError(
        "busy",
        "The durable queue session limit has been reached.",
      );
    ledger.sessions[id] = state;
  };
  const dirty = new Set<SessionId>();
  const active = new Map<SessionId, Promise<void>>();
  const schedule = (sessionId: SessionId) => {
    if (!runner || stopped) return;
    if (active.has(sessionId)) {
      dirty.add(sessionId);
      return;
    }
    const host = runner;
    const operation = Promise.resolve()
      .then(async () => {
        while (!stopped && !host.isBusy(sessionId)) {
          const item = await transaction(async (ledger) => {
            if (stopped || ledger.sessions[sessionId]?.paused) return undefined;
            const item = ledger.items.find(
              (item) =>
                item.sessionId === sessionId &&
                pending(item) &&
                (item.state !== "uncertain" ||
                  ledger.sessions[sessionId]?.paused !== false),
            );
            if (!item?.input || item.state !== "queued") return undefined;
            try {
              const predecessor = await options.predecessor?.(sessionId);
              if (
                predecessor?.unsafe &&
                item.acknowledgedPredecessor !== predecessor.token
              ) {
                item.state = "blocked";
                item.reason =
                  "Previous execution needs review. Explicit resume is required.";
                item.updatedAt = new Date().toISOString();
                setState(ledger, sessionId, {
                  paused: true,
                  reason: item.reason,
                });
                return undefined;
              }
              const prepared = await options.prepare(item.input);
              if (prepared.providerBinding !== item.providerBinding)
                throw new ForgeError(
                  "provider",
                  "The accepted provider or model is unavailable or changed. Restore the selection and explicitly resume.",
                );
            } catch (error) {
              block(ledger, item, error);
              return undefined;
            }
            // Bind durably BEFORE calling any runtime code. Recovery never replays a bound item.
            item.state = "bound";
            item.runId = randomUUID();
            item.updatedAt = new Date().toISOString();
            return { ...item };
          });
          if (!item?.input || !item.runId || stopped) return;
          let status: "completed" | "failed" | "cancelled" | "interrupted" =
            "failed";
          try {
            const result = await host.start(
              item.input,
              item.runId,
              item.providerBinding,
              item.acknowledgedPredecessor,
              item.origin,
            );
            if (
              result === "completed" ||
              result === "failed" ||
              result === "cancelled" ||
              result === "interrupted"
            )
              status = result;
          } catch (error) {
            await transaction((ledger) => {
              const entry = ledger.items.find(
                (candidate) => candidate.inputId === item.inputId,
              );
              if (
                !entry ||
                entry.state !== "bound" ||
                entry.runId !== item.runId
              )
                throw storageError();
              if (error instanceof QueueAdmissionError) entry.runId = null;
              block(ledger, entry, error);
            });
            return;
          }
          await transaction((ledger) => {
            const entry = ledger.items.find(
              (candidate) => candidate.inputId === item.inputId,
            );
            if (!entry || entry.state !== "bound" || entry.runId !== item.runId)
              throw storageError();
            entry.state = "consumed";
            entry.outcome = status;
            // A rejected start may not have saved a transcript. Preserve failed
            // input for inspection without making it eligible for replay.
            if (status === "completed") entry.input = null;
            entry.updatedAt = new Date().toISOString();
            if (status !== "completed")
              setState(ledger, sessionId, {
                paused: true,
                reason: `Previous run ${status}. Explicit resume is required.`,
              });
          });
          if (status !== "completed") return;
        }
      })
      .catch(async (error) => {
        if (storageFailed) return;
        await transaction((ledger) => {
          const item = ledger.items.find(
            (item) => item.sessionId === sessionId && pending(item),
          );
          if (item) block(ledger, item, error);
        });
      })
      .finally(() => {
        active.delete(sessionId);
        if (dirty.delete(sessionId)) schedule(sessionId);
      });
    active.set(sessionId, operation);
    void operation.catch(() => undefined);
  };
  /** One durable acceptance path; origin is host-owned and never caller-supplied. */
  const accept = async (
    raw: unknown,
    origin?: "background_task",
  ): Promise<QueuedInput> => {
    const request = enqueueInputSchema.parse(raw);
    // Legacy-compatible hash: origin is compared separately so a notification
    // can never be swapped for, or reused as, ordinary explicit input.
    const requestHash = digest(request.input);
    const item = await transaction(async (ledger) => {
      const existing =
        ledger.items.find((item) => item.inputId === request.inputId) ??
        (await receipt(request.inputId));
      if (existing) {
        if (
          existing.sessionId !== request.input.sessionId ||
          existing.origin !== origin ||
          existing.requestHash !== requestHash
        )
          throw new ForgeError(
            "invalid_input",
            "This input ID was already accepted with different content.",
          );
        return publicItem(existing);
      }
      check();
      if (ledger.items.length >= MAX_RECEIPTS)
        throw new ForgeError(
          "busy",
          "The durable input receipt limit has been reached.",
        );
      const prepared = await options.prepare(request.input);
      const input = runInputSchema.parse(prepared.input);
      const bytes = Buffer.byteLength(JSON.stringify(input));
      const waiting = ledger.items.filter(pending);
      const own = waiting.filter((item) => item.sessionId === input.sessionId);
      const totalBytes = (items: readonly StoredItem[]) =>
        items.reduce(
          (sum, item) => sum + Buffer.byteLength(JSON.stringify(item.input)),
          bytes,
        );
      if (
        waiting.length >= MAX_PENDING ||
        own.length >= MAX_SESSION_PENDING ||
        totalBytes(ledger.items.filter((item) => item.input !== null)) >
          MAX_TOTAL_BYTES ||
        totalBytes(
          ledger.items.filter(
            (item) => item.sessionId === input.sessionId && item.input !== null,
          ),
        ) > MAX_SESSION_BYTES
      )
        throw new ForgeError(
          "busy",
          "The durable input queue is full. Nothing was accepted.",
          true,
        );
      if (!input.model || !input.permission)
        throw new ForgeError("internal", "Queue selection was not pinned.");
      const timestamp = new Date().toISOString();
      const entry: StoredItem = {
        inputId: request.inputId,
        sessionId: input.sessionId,
        ...(origin ? { origin } : {}),
        sequence: ledger.nextSequence++,
        state: "queued",
        acceptedAt: timestamp,
        updatedAt: timestamp,
        runId: null,
        input,
        selection: {
          model: input.model,
          ...(input.providerSourceId
            ? { providerSourceId: input.providerSourceId }
            : {}),
          ...(input.routeGroupId ? { routeGroupId: input.routeGroupId } : {}),
          mode: input.mode ?? "build",
          permission: input.permission,
        },
        requestHash,
        providerBinding: prepared.providerBinding,
      };
      const predecessor = await options.predecessor?.(input.sessionId);
      // Only an explicit user request may acknowledge a stale terminal failure.
      // A background notification waits for explicit resume and never resumes
      // a failed, cancelled, interrupted, paused or otherwise unsafe session.
      if (
        !origin &&
        predecessor?.unsafe &&
        !predecessor.active &&
        !runner?.isBusy(input.sessionId)
      ) {
        try {
          const checked = await options.predecessor?.(input.sessionId, true);
          if (checked && !checked.active)
            entry.acknowledgedPredecessor = checked.token;
        } catch (error) {
          if (!(error instanceof ForgeError) || error.code !== "busy")
            throw error;
        }
      }
      ledger.items.push(entry);
      return publicItem(entry);
    });
    schedule(item.sessionId);
    return item;
  };
  return {
    enqueue: (raw) => accept(raw),
    notify: (raw) => accept(raw, "background_task"),
    async list(id) {
      const sessionId = sessionIdSchema.parse(id);
      await options.validateSession(sessionId);
      const result = await transaction(
        (ledger) => snapshot(ledger, sessionId),
        false,
      );
      return storageFailed
        ? {
            ...result,
            paused: true,
            reason:
              "Queue persistence failed. Restart the host to inspect and recover bound inputs.",
          }
        : result;
    },
    async cancel(id, inputId) {
      const sessionId = sessionIdSchema.parse(id);
      await options.validateSession(sessionId);
      return transaction((ledger) => {
        const item = ledger.items.find(
          (item) => item.inputId === inputId && item.sessionId === sessionId,
        );
        if (!item || !["queued", "blocked"].includes(item.state)) return false;
        item.state = "cancelled";
        item.input = null;
        item.updatedAt = new Date().toISOString();
        return true;
      });
    },
    async pause(id) {
      const sessionId = sessionIdSchema.parse(id);
      await options.validateSession(sessionId);
      return transaction((ledger) => {
        setState(ledger, sessionId, { paused: true });
        return snapshot(ledger, sessionId);
      });
    },
    async resume(id) {
      const sessionId = sessionIdSchema.parse(id);
      check();
      await options.validateSession(sessionId);
      const result = await transaction(async (ledger) => {
        if (runner?.isBusy(sessionId)) throw new QueueAdmissionError();
        const predecessor = await options.predecessor?.(sessionId, true);
        setState(ledger, sessionId, { paused: false });
        for (const item of ledger.items)
          if (
            item.sessionId === sessionId &&
            ["blocked", "queued"].includes(item.state)
          ) {
            item.state = "queued";
            if (predecessor) item.acknowledgedPredecessor = predecessor.token;
            Reflect.deleteProperty(item, "reason");
            Reflect.deleteProperty(item, "error");
          }
        return snapshot(ledger, sessionId);
      });
      schedule(sessionId);
      return result;
    },
    attach(host) {
      if (attaching) return attaching;
      attaching = (async () => {
        ownerRelease = await fileLock(join(directory, "consumer.lock"));
        try {
          const sessions = await transaction(async (ledger) => {
            for (const item of ledger.items)
              if (item.state === "bound") {
                item.state = "uncertain";
                item.reason =
                  "The host stopped after binding this input. Inspect the associated run before creating a new input ID; it will not be replayed.";
                item.updatedAt = new Date().toISOString();
                const state = ledger.sessions[item.sessionId];
                if (state) {
                  state.paused = true;
                  state.reason = item.reason;
                }
              }
            return [
              ...new Set(
                ledger.items
                  .filter((item) => item.state === "queued")
                  .map((item) => item.sessionId),
              ),
            ];
          });
          runner = host;
          for (const sessionId of sessions) schedule(sessionId);
        } catch (error) {
          await ownerRelease();
          ownerRelease = undefined;
          throw error;
        }
      })();
      return attaching;
    },
    async finished(sessionId, status) {
      if (status !== "completed")
        await transaction((ledger) => {
          // The bound item's scheduler owns its terminal transition.
          if (
            ledger.items.some(
              (item) => item.sessionId === sessionId && item.state === "bound",
            )
          )
            return;
          if (
            !ledger.items.some(
              (item) => item.sessionId === sessionId && pending(item),
            )
          )
            return;
          try {
            setState(ledger, sessionId, {
              paused: true,
              reason: `Previous run ${status}. Explicit resume is required.`,
            });
          } catch (error) {
            const item = ledger.items.find(
              (item) => item.sessionId === sessionId && pending(item),
            );
            if (item) block(ledger, item, error);
          }
        });
      schedule(sessionId);
    },
    stop() {
      stopped = true;
    },
    async dispose() {
      stopped = true;
      await attaching?.catch(() => undefined);
      await Promise.allSettled([...active.values()]);
      await serial;
      await ownerRelease?.();
      ownerRelease = undefined;
    },
  };
}
