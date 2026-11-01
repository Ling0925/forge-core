import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import {
  type Delivery,
  ForgeError,
  type OutboxItem,
  type Suggestion,
  type Thread,
  type Trigger,
  type WorkItem,
  type WorkItemStore,
  createWorkItemSchema,
  deliverySchema,
  outboxItemSchema,
  suggestionSchema,
  threadSchema,
  triggerSchema,
  workItemQuerySchema,
  workItemSchema,
  workItemUpdateSchema,
} from "../shared";
import { checkEntry, hasCode, privateDirectory, storageError } from "./io";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY, event TEXT NOT NULL, received_at TEXT NOT NULL,
    payload TEXT NOT NULL, processed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
    explicit INTEGER NOT NULL, thread_id TEXT NOT NULL, summary TEXT NOT NULL,
    payload TEXT NOT NULL, received_at TEXT NOT NULL, disposition TEXT, reason TEXT
  );
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL, last_trigger_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY, status TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
    thread_ids TEXT NOT NULL, worker_session_id TEXT, profile_id TEXT NOT NULL,
    worktree TEXT, progress TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claimed_by TEXT,
    router_session_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    work_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, thread_id TEXT NOT NULL,
    PRIMARY KEY (work_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id TEXT PRIMARY KEY, thread_ids TEXT NOT NULL, brief TEXT NOT NULL, trigger_ids TEXT NOT NULL,
    state TEXT NOT NULL, work_id TEXT
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
    body TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, decided_at TEXT, sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  PRAGMA user_version = 2;
`;

function decode<T>(schema: z.ZodType<T>, row: Record<string, unknown>): T {
  const value = Object.fromEntries(
    Object.entries(row).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      ["payload", "thread_ids", "trigger_ids", "target", "body"].includes(key)
        ? JSON.parse(String(item))
        : key === "explicit"
          ? item === 1
          : item,
    ]),
  );
  return schema.parse(value);
}

const suggestionInput = suggestionSchema
  .unwrap()
  .pick({ threadIds: true, brief: true, triggerIds: true });
const outboxInputFields = {
  workId: true,
  kind: true,
  target: true,
  body: true,
} as const;
const outboxInput = z.discriminatedUnion("kind", [
  outboxItemSchema.unwrap().options[0].pick(outboxInputFields),
  outboxItemSchema.unwrap().options[1].pick(outboxInputFields),
  outboxItemSchema.unwrap().options[2].pick(outboxInputFields),
  outboxItemSchema.unwrap().options[3].pick(outboxInputFields),
]);
const missing = () =>
  new ForgeError("not_found", "Stored record was not found.");
const conflict = () =>
  new ForgeError(
    "invalid_input",
    "The record is no longer in the required state.",
  );

export async function openSuperAgentStore(directory: string) {
  let database: DatabaseSync | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const access = <T>(action: (db: DatabaseSync) => T): Promise<T> => {
    if (closed)
      return Promise.reject(new ForgeError("storage", "Store is closed."));
    const operation = queue.then(async () => {
      try {
        if (!database) {
          const root = await privateDirectory(directory);
          const path = join(root, "superagent.sqlite");
          if (!(await checkEntry(path))) {
            try {
              const file = await open(path, "wx", 0o600);
              await file.close();
            } catch (error) {
              if (!hasCode(error, "EEXIST")) throw error;
            }
          }
          await checkEntry(path);
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(path);
          try {
            db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
            const version = db
              .prepare("PRAGMA user_version")
              .get()?.user_version;
            if (version !== 0 && version !== 1 && version !== 2)
              throw new ForgeError("storage", "Unsupported database version.");
            if (version === 0 || version === 1) {
              db.exec("BEGIN IMMEDIATE");
              try {
                if (version === 0) db.exec(SCHEMA);
                else
                  db.exec(`
                    ALTER TABLE work_items ADD COLUMN router_session_id TEXT;
                    UPDATE work_items SET router_session_id = (
                      SELECT value FROM cursors WHERE key = 'superagent:work-router:' || work_items.id
                    );
                    DELETE FROM cursors WHERE key GLOB 'superagent:work-router:*';
                    PRAGMA user_version = 2;
                  `);
                db.exec("COMMIT");
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
            }
            db.exec(`
              CREATE INDEX IF NOT EXISTS triggers_disposition ON triggers (disposition, received_at, id);
              CREATE INDEX IF NOT EXISTS triggers_thread ON triggers (thread_id, received_at, id);
            `);
            database = db;
          } catch (error) {
            db.close();
            throw error;
          }
        }
        return action(database);
      } catch (error) {
        if (error instanceof ForgeError) throw error;
        throw storageError();
      }
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
  const transaction = <T>(action: (db: DatabaseSync) => T) =>
    access((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = action(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  const getWork = (db: DatabaseSync, id: string) => {
    const row = db
      .prepare("SELECT *, NULL AS pending_status FROM work_items WHERE id = ?")
      .get(id);
    return row ? decode(workItemSchema, row) : undefined;
  };
  const requireWork = (db: DatabaseSync, id: string) => {
    const item = getWork(db, id);
    if (!item) throw missing();
    return item;
  };
  const saveWork = (db: DatabaseSync, item: WorkItem) => {
    db.prepare(`INSERT INTO work_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, thread_ids=excluded.thread_ids,
      worker_session_id=excluded.worker_session_id, worktree=excluded.worktree,
      progress=excluded.progress, updated_at=excluded.updated_at, claimed_by=excluded.claimed_by`).run(
      item.id,
      item.status,
      item.title,
      item.brief,
      JSON.stringify(item.threadIds),
      item.workerSessionId,
      item.profileId,
      item.worktree,
      item.progress,
      item.createdAt,
      item.updatedAt,
      item.claimedBy,
      item.routerSessionId,
    );
    db.prepare("DELETE FROM subscriptions WHERE work_id = ?").run(item.id);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO subscriptions VALUES (?,?)",
    );
    for (const threadId of item.threadIds) insert.run(item.id, threadId);
    return item;
  };
  const changeWork = (id: string, change: (item: WorkItem) => WorkItem) =>
    transaction((db) =>
      saveWork(
        db,
        workItemSchema.parse({
          ...change(requireWork(db, id)),
          updatedAt: new Date().toISOString(),
        }),
      ),
    );
  const workItems: WorkItemStore = {
    async create(raw) {
      const input = createWorkItemSchema.parse(raw);
      const now = new Date().toISOString();
      const item = workItemSchema.parse({
        ...input,
        id: `wrk_${randomUUID()}`,
        status: "queued",
        pendingStatus: null,
        workerSessionId: null,
        worktree: input.worktree ?? null,
        progress: null,
        claimedBy: null,
        createdAt: now,
        updatedAt: now,
      });
      return transaction((db) => saveWork(db, item));
    },
    claim(id, claimedBy) {
      const owner = workItemSchema
        .unwrap()
        .shape.claimedBy.unwrap()
        .parse(claimedBy);
      return transaction((db) => {
        const result = db
          .prepare(
            "UPDATE work_items SET status = 'running', claimed_by = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
          )
          .run(owner, new Date().toISOString(), id);
        return result.changes === 0 ? undefined : getWork(db, id);
      });
    },
    async update(id, raw) {
      const patch = workItemUpdateSchema.parse(raw);
      return changeWork(id, (item) => ({
        ...item,
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.progress === undefined ? {} : { progress: patch.progress }),
      }));
    },
    linkThread: (id, threadId) =>
      changeWork(id, (item) => ({
        ...item,
        threadIds: [...new Set([...item.threadIds, threadId])],
      })),
    unlinkThread: (id, threadId) =>
      changeWork(id, (item) => ({
        ...item,
        threadIds: item.threadIds.filter((value) => value !== threadId),
      })),
    linkWorker: (id, sessionId, worktree) =>
      changeWork(id, (item) => ({
        ...item,
        workerSessionId: sessionId,
        ...(worktree === undefined ? {} : { worktree }),
      })),
    get: (id) => access((db) => getWork(db, id)),
    async list(raw = {}) {
      const query = workItemQuerySchema.parse(raw);
      return access((db) => {
        const conditions: string[] = [];
        const params: SQLInputValue[] = [];
        if (query.status !== undefined) {
          const statuses =
            typeof query.status === "string" ? [query.status] : query.status;
          conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
          params.push(...statuses);
        }
        if (query.threadId !== undefined) {
          conditions.push(
            "EXISTS (SELECT 1 FROM subscriptions s WHERE s.work_id = w.id AND s.thread_id = ?)",
          );
          params.push(query.threadId);
        }
        const where = conditions.length
          ? `WHERE ${conditions.join(" AND ")}`
          : "";
        return db
          .prepare(
            `SELECT w.*, NULL AS pending_status FROM work_items w ${where} ORDER BY created_at, id`,
          )
          .all(...params)
          .map((row) => decode(workItemSchema, row));
      });
    },
  };
  const transitionOutbox = (
    id: string,
    state: Exclude<OutboxItem["state"], "pending">,
    error: string | null = null,
  ) =>
    access((db) => {
      const decision = state === "approved" || state === "rejected";
      const now = new Date().toISOString();
      const row = db
        .prepare(`UPDATE outbox SET state = ?, error = ?, ${decision ? "decided_at = ?" : "sent_at = ?"}
      WHERE id = ? AND state = ? RETURNING *`)
        .get(
          state,
          error,
          decision || state === "sent" ? now : null,
          id,
          decision ? "pending" : "approved",
        );
      if (!row) throw conflict();
      return decode(outboxItemSchema, row);
    });
  return {
    workItems,
    async recordDelivery(raw: Omit<Delivery, "processedAt">): Promise<boolean> {
      const item = deliverySchema.parse({ ...raw, processedAt: null });
      return access(
        (db) =>
          db
            .prepare(
              "INSERT INTO deliveries VALUES (?,?,?,?,NULL) ON CONFLICT(id) DO NOTHING",
            )
            .run(
              item.id,
              item.event,
              item.receivedAt,
              JSON.stringify(item.payload),
            ).changes !== 0,
      );
    },
    unprocessedDeliveries: () =>
      access((db) =>
        db
          .prepare(
            "SELECT * FROM deliveries WHERE processed_at IS NULL ORDER BY received_at, id",
          )
          .all()
          .map((row) => decode(deliverySchema, row)),
      ),
    markDeliveryProcessed: (id: string) =>
      access((db) => {
        db.prepare(
          "UPDATE deliveries SET processed_at = ? WHERE id = ? AND processed_at IS NULL",
        ).run(new Date().toISOString(), id);
      }),
    async putTrigger(raw: Trigger) {
      const item = triggerSchema.parse(raw);
      return access((db) => {
        db.prepare(`INSERT INTO triggers VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET source=excluded.source, kind=excluded.kind, actor=excluded.actor,
        explicit=excluded.explicit, thread_id=excluded.thread_id, summary=excluded.summary, payload=excluded.payload,
        received_at=excluded.received_at, disposition=excluded.disposition, reason=excluded.reason`).run(
          item.id,
          item.source,
          item.kind,
          item.actor,
          Number(item.explicit),
          item.threadId,
          item.summary,
          JSON.stringify(item.payload),
          item.receivedAt,
          item.disposition,
          item.reason,
        );
      });
    },
    getTrigger: (id: string) =>
      access((db) => {
        const row = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id);
        return row ? decode(triggerSchema, row) : undefined;
      }),
    listTriggers: (
      query: {
        disposition?: string | readonly string[] | undefined;
        threadIds?: readonly string[] | undefined;
      } = {},
    ) =>
      access((db) => {
        const conditions: string[] = [];
        const params: SQLInputValue[] = [];
        if (query.disposition !== undefined) {
          const dispositions =
            typeof query.disposition === "string"
              ? [query.disposition]
              : query.disposition;
          conditions.push(
            `disposition IN (${dispositions.map(() => "?").join(",")})`,
          );
          params.push(...dispositions);
        }
        if (query.threadIds !== undefined) {
          conditions.push(
            `thread_id IN (${query.threadIds.map(() => "?").join(",")})`,
          );
          params.push(...query.threadIds);
        }
        const where = conditions.length
          ? `WHERE ${conditions.join(" AND ")}`
          : "";
        return db
          .prepare(`SELECT * FROM triggers ${where} ORDER BY received_at, id`)
          .all(...params)
          .map((row) => decode(triggerSchema, row));
      }),
    async upsertThread(raw: Thread) {
      const item = threadSchema.parse(raw);
      return access((db) => {
        db.prepare(`INSERT INTO threads VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, url=excluded.url, state=excluded.state, last_trigger_at=excluded.last_trigger_at`).run(
          item.id,
          item.title,
          item.url,
          item.state,
          item.lastTriggerAt,
        );
      });
    },
    getThread: (id: string) =>
      access((db) => {
        const row = db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
        return row ? decode(threadSchema, row) : undefined;
      }),
    getCursor: (key: string) =>
      access((db) => {
        const row = db
          .prepare("SELECT value FROM cursors WHERE key = ?")
          .get(key);
        return row ? z.string().parse(row.value) : undefined;
      }),
    setCursor: (key: string, value: string) =>
      access((db) => {
        db.prepare(
          "INSERT INTO cursors VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(key, value);
      }),
    async createSuggestion(raw: z.infer<typeof suggestionInput>) {
      const item: Suggestion = {
        ...suggestionInput.parse(raw),
        id: `sug_${randomUUID()}`,
        state: "pending",
        workId: null,
      };
      return access((db) => {
        db.prepare("INSERT INTO suggestions VALUES (?,?,?,?,?,?)").run(
          item.id,
          JSON.stringify(item.threadIds),
          item.brief,
          JSON.stringify(item.triggerIds),
          item.state,
          item.workId,
        );
        return item;
      });
    },
    getSuggestion: (id: string) =>
      access((db) => {
        const row = db
          .prepare("SELECT * FROM suggestions WHERE id = ?")
          .get(id);
        return row ? decode(suggestionSchema, row) : undefined;
      }),
    listSuggestions: (state?: Suggestion["state"]) =>
      access((db) =>
        db
          .prepare(
            `SELECT * FROM suggestions ${state === undefined ? "" : "WHERE state = ?"} ORDER BY rowid`,
          )
          .all(...(state === undefined ? [] : [state]))
          .map((row) => decode(suggestionSchema, row)),
      ),
    async updateSuggestion(id: string, raw: z.infer<typeof suggestionInput>) {
      const item = suggestionInput.parse(raw);
      return access((db) => {
        const row = db
          .prepare(
            "UPDATE suggestions SET thread_ids = ?, brief = ?, trigger_ids = ? WHERE id = ? AND state = 'pending' RETURNING *",
          )
          .get(
            JSON.stringify(item.threadIds),
            item.brief,
            JSON.stringify(item.triggerIds),
            id,
          );
        if (!row) throw conflict();
        return decode(suggestionSchema, row);
      });
    },
    decideSuggestion: (id: string, workId: string | null) =>
      access((db) => {
        const row = db
          .prepare(
            "UPDATE suggestions SET state = ?, work_id = ? WHERE id = ? AND state = 'pending' RETURNING *",
          )
          .get(workId === null ? "rejected" : "accepted", workId, id);
        if (!row) throw conflict();
        return decode(suggestionSchema, row);
      }),
    deleteSuggestion: (id: string) =>
      access(
        (db) =>
          db.prepare("DELETE FROM suggestions WHERE id = ?").run(id).changes !==
          0,
      ),
    async createOutboxItem(raw: z.infer<typeof outboxInput>) {
      const item: OutboxItem = {
        ...outboxInput.parse(raw),
        id: `out_${randomUUID()}`,
        state: "pending",
        error: null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
        sentAt: null,
      };
      return access((db) => {
        db.prepare("INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?,?,?)").run(
          item.id,
          item.workId,
          item.kind,
          JSON.stringify(item.target),
          JSON.stringify(item.body),
          item.state,
          item.error,
          item.createdAt,
          item.decidedAt,
          item.sentAt,
        );
        return item;
      });
    },
    getOutboxItem: (id: string) =>
      access((db) => {
        const row = db.prepare("SELECT * FROM outbox WHERE id = ?").get(id);
        return row ? decode(outboxItemSchema, row) : undefined;
      }),
    listOutbox: (state?: OutboxItem["state"]) =>
      access((db) =>
        db
          .prepare(
            `SELECT * FROM outbox ${state === undefined ? "" : "WHERE state = ?"} ORDER BY created_at, id`,
          )
          .all(...(state === undefined ? [] : [state]))
          .map((row) => decode(outboxItemSchema, row)),
      ),
    async updateOutboxItem(id: string, raw: z.infer<typeof outboxInput>) {
      const item = outboxInput.parse(raw);
      return access((db) => {
        const row = db
          .prepare(
            "UPDATE outbox SET work_id = ?, kind = ?, target = ?, body = ? WHERE id = ? AND state = 'pending' RETURNING *",
          )
          .get(
            item.workId,
            item.kind,
            JSON.stringify(item.target),
            JSON.stringify(item.body),
            id,
          );
        if (!row) throw conflict();
        return decode(outboxItemSchema, row);
      });
    },
    decideOutbox: (id: string, approve: boolean) =>
      transitionOutbox(id, approve ? "approved" : "rejected"),
    markOutboxSent: (id: string) => transitionOutbox(id, "sent"),
    markOutboxFailed: (id: string, error: string) =>
      transitionOutbox(id, "failed", error),
    deleteOutboxItem: (id: string) =>
      access(
        (db) =>
          db.prepare("DELETE FROM outbox WHERE id = ?").run(id).changes !== 0,
      ),
    async close() {
      closed = true;
      await queue;
      database?.close();
      database = undefined;
    },
  };
}

export type SuperAgentStore = Awaited<ReturnType<typeof openSuperAgentStore>>;
