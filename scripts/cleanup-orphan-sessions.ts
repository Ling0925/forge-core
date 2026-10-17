import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ForgeError } from "../src/shared/errors";
import { sessionIdSchema, sessionSnapshotSchema, type SessionSnapshot, type ToolResult } from "../src/shared/schemas";
import { atomicJson, privateDirectory, readJson, syncDirectory } from "../src/store/io";
import { openSessionStore } from "../src/store/sessions";
import { parseSessionBase } from "../src/store/session-journal";

type CleanupResult = {
  id: string;
  action: "skipped" | "would-interrupt" | "interrupted";
  reason?: string;
  closedCalls?: number;
  backup?: string;
};

/** Explicit IDs only; holding the normal session lock excludes any live owner. */
export async function cleanupOrphanSessions(
  home: string,
  ids: readonly string[],
  options: { before: string; apply?: boolean },
): Promise<CleanupResult[]> {
  const cutoff = Date.parse(options.before);
  if (!Number.isFinite(cutoff)) throw new Error("A valid --before timestamp is required.");
  const targets = [...new Set(ids.map(id => sessionIdSchema.parse(id)))];
  if (!targets.length) throw new Error("At least one explicit session ID is required.");
  const root = resolve(home);
  const store = await openSessionStore(root);
  const results: CleanupResult[] = [];
  let backupDirectory: string | undefined;
  for (const id of targets) {
    let release: () => Promise<void>;
    try {
      release = await store.acquire(id);
    } catch (error) {
      if (!(error instanceof ForgeError) || error.code !== "busy") throw error;
      results.push({ id, action: "skipped", reason: "locked by a live owner" });
      continue;
    }
    try {
      // Validate through the store, but retain raw historical fields rather than
      // rewriting legacy event/file-change representations during maintenance.
      const current = await store.get(id);
      const path = join(root, "sessions", `${id}.json`);
      const base = parseSessionBase(await readJson(path)).snapshot as SessionSnapshot;
      const journaled = JSON.stringify(sessionSnapshotSchema.parse(base)) !== JSON.stringify(current);
      const snapshot = journaled ? current : base;
      if (snapshot.status !== "running" && snapshot.status !== "awaiting_approval") {
        results.push({ id, action: "skipped", reason: `status is ${snapshot.status}` });
        continue;
      }
      if (Date.parse(snapshot.updatedAt) >= cutoff) {
        results.push({ id, action: "skipped", reason: "updated since cutoff" });
        continue;
      }
      const pending = new Set<string>();
      for (const message of snapshot.messages) {
        if (message.role === "assistant")
          for (const call of message.tool_calls ?? []) pending.add(call.id);
        if (message.role === "tool") pending.delete(message.tool_call_id);
      }
      const unfinishedEvents = new Set<string>();
      for (const event of snapshot.events) {
        if (event.type === "run_started") unfinishedEvents.clear();
        if (event.type === "tool_started") unfinishedEvents.add(event.call.id);
        if (event.type === "tool_finished") unfinishedEvents.delete(event.toolCallId);
      }
      for (const id of pending) unfinishedEvents.add(id);
      if (snapshot.pendingTool) unfinishedEvents.add(snapshot.pendingTool.id);
      const timestamp = new Date().toISOString();
      const result: ToolResult = {
        content: "Orphaned execution was interrupted by explicit session cleanup. No tool was replayed; inspect existing effects before retrying.",
        isError: true,
      };
      const { pendingTool: _pendingTool, ...rest } = snapshot;
      const next: SessionSnapshot = {
        ...rest,
        status: "interrupted",
        updatedAt: timestamp,
        messages: [...snapshot.messages, ...[...pending].map(tool_call_id => ({
          role: "tool" as const, tool_call_id, content: JSON.stringify(result),
        }))],
        events: [...snapshot.events, ...[...unfinishedEvents].map(toolCallId => ({
          sessionId: id, timestamp, type: "tool_finished" as const, toolCallId, result,
        })), { sessionId: id, timestamp, type: "state_changed", status: "interrupted" }],
      };
      sessionSnapshotSchema.parse(next);
      if (!options.apply) {
        results.push({ id, action: "would-interrupt", closedCalls: pending.size });
        continue;
      }
      backupDirectory ??= await privateDirectory(join(root, "session-cleanup-backups", randomUUID()));
      const backup = join(backupDirectory, `${id}.json`);
      if (journaled) {
        await atomicJson(backup, snapshot);
        await copyFile(path, join(backupDirectory, `${id}.base.json`), constants.COPYFILE_EXCL);
      } else await copyFile(path, backup, constants.COPYFILE_EXCL);
      const handle = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(backupDirectory);
      await atomicJson(path, next);
      await store.get(id);
      results.push({ id, action: "interrupted", closedCalls: pending.size, backup });
    } finally {
      await release();
    }
  }
  return results;
}

// Bundle with esbuild before running. This entry never opens provider settings,
// starts a harness, calls a model, deletes lock inodes, or replays tool calls.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1]) throw new Error(`Missing ${flag}.`);
    return args[index + 1] as string;
  };
  const home = value("--home");
  const before = value("--before");
  const ids: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--home" || arg === "--before") index++;
    else if (arg !== "--apply") ids.push(arg as string);
  }
  console.log(JSON.stringify(await cleanupOrphanSessions(home, ids, { before, apply: args.includes("--apply") }), null, 2));
}
