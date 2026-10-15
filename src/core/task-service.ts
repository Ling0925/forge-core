import { z } from "zod";
import type { SessionStore } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { sessionIdSchema, type SessionId, type SessionSnapshot } from "../shared/schemas";
import type { CommandTaskAccess, TaskService, TaskView } from "../shared/task-view";
import { redactCommandArguments, toolActivity } from "../shared/tool-activity";

interface Options {
  store: SessionStore;
  commands: () => readonly CommandTaskAccess[];
  owns: (id: SessionId) => boolean;
  cancel: (id: SessionId) => Promise<boolean>;
  redact?: (text: string) => string;
}
const pageArgs = z.object({ offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(8192) });
const taskKind = z.enum(["agent", "command"]);
const taskId = z.string().uuid();
const terminal = (status: string) => ["completed", "failed", "cancelled", "interrupted"].includes(status);
const unknown = () => new ForgeError("not_found", "Task is not available in this parent session.");

/** Host-only view of direct children and owned command registries. No model call,
 * no read-delivery acknowledgements and no adoption of historical executions. */
export function createTaskService(options: Options): TaskService {
  const { store } = options;
  const clean = (text: string): string => {
    const value = options.redact?.(text) ?? text;
    return redactCommandArguments([value])[0] ?? "";
  };
  async function family(raw: SessionId) {
    const parentId = sessionIdSchema.parse(raw);
    await store.get(parentId);
    const children = (await store.list()).filter(item => item.parentSessionId === parentId);
    return { parentId, children, ids: new Set<SessionId>([parentId, ...children.map(item => item.id)]) };
  }
  function agentView(snapshot: SessionSnapshot): TaskView {
    const owned = options.owns(snapshot.id);
    const active = owned && !terminal(snapshot.status);
    const lastRun = snapshot.events.findLastIndex(event => event.type === "run_started");
    const events = snapshot.events.slice(Math.max(0, lastRun));
    const finished = events.findLast(event => event.type === "run_finished");
    const started = events.find(event => event.type === "run_started");
    const pending = new Map<string, import("../shared/schemas").ToolCall>();
    for (const event of events) {
      if (event.type === "tool_started") pending.set(event.call.id, event.call);
      if (event.type === "tool_finished") pending.delete(event.toolCallId);
    }
    const call = [...pending.values()].at(-1) ?? snapshot.pendingTool;
    const activity = active && call ? toolActivity(call) : undefined;
    return { id: snapshot.id, kind: "agent", sessionId: snapshot.id,
      title: clean(snapshot.agentTask ?? snapshot.title).slice(0, 256), status: snapshot.status,
      active, controllable: active, historical: !owned, model: clean(snapshot.model).slice(0, 256),
      ...(activity ? { activity: clean(`${activity.name} ${activity.target}`).slice(0, 320) } : {}),
      ...(started ? { startedAt: started.timestamp } : {}),
      ...(finished?.type === "run_finished" && finished.usage ? { usage: finished.usage } : {}),
    };
  }
  function commandViews(ids: Set<SessionId>) {
    const result: { access: CommandTaskAccess; task: TaskView }[] = [];
    const seen = new Set<string>();
    for (const access of options.commands()) for (const sessionId of ids) {
      for (const task of access.list(sessionId)) {
        if (task.sessionId !== sessionId || task.kind !== "command" || seen.has(task.id)) continue;
        seen.add(task.id);
        result.push({ access, task: { ...task, title: clean(task.title).slice(0, 256),
          ...(task.activity ? { activity: clean(task.activity).slice(0, 320) } : {}) } });
      }
    }
    return result;
  }
  return {
    async listTasks(parentId, offset = 0, limit = 20) {
      pageArgs.extend({ limit: z.number().int().min(1).max(50) }).parse({ offset, limit });
      const group = await family(parentId);
      // Load only the bounded page of agent transcripts after sorting summary metadata.
      const agents = group.children.map(child => ({ kind: "agent" as const, id: child.id,
        active: options.owns(child.id) && !terminal(child.status), updatedAt: child.updatedAt }));
      const commands = commandViews(group.ids).map(item => ({ ...item, kind: "command" as const,
        id: item.task.id, active: item.task.active, updatedAt: item.task.startedAt ?? "" }));
      const all = [...agents, ...commands].sort((a, b) => Number(b.active) - Number(a.active)
        || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const tasks: TaskView[] = [];
      for (const item of all.slice(offset, offset + limit)) {
        if (item.kind === "command") tasks.push(item.task);
        else {
          const snapshot = await store.get(item.id);
          if (snapshot.parentSessionId === group.parentId) tasks.push(agentView(snapshot));
        }
      }
      const next = offset + Math.min(limit, Math.max(0, all.length - offset));
      return { tasks, offset, nextOffset: next < all.length ? next : null, truncated: next < all.length };
    },
    async getTask(parentId, kind, id, offset = 0, limit = 4096) {
      taskKind.parse(kind); taskId.parse(id); pageArgs.parse({ offset, limit });
      const group = await family(parentId);
      if (kind === "command") {
        const entry = commandViews(group.ids).find(entry => entry.task.id === id);
        if (!entry) throw unknown();
        // Access already performs whole-output redaction. Read a bounded whole
        // capture before secondary host redaction so secrets never split pages.
        let output = ""; let position = 0; let note: string | undefined;
        let incomplete = false;
        for (let page = 0; page < 12; page++) {
          const detail = entry.access.read(entry.task.sessionId, id, position, 12000);
          if (!detail) throw unknown();
          output += detail.content;
          note = detail.note;
          incomplete = detail.truncated;
          if (detail.nextOffset === null || detail.nextOffset <= position) break;
          position = detail.nextOffset;
        }
        const content = clean(output);
        const end = Math.min(content.length, offset + limit);
        return { task: entry.task, content: content.slice(offset, end), offset,
          nextOffset: end < content.length ? end : null, truncated: end < content.length || incomplete,
          ...(note ? { note: clean(note).slice(0, 512) } : {}) };
      }
      const childId = sessionIdSchema.parse(id);
      if (!group.children.some(child => child.id === childId)) throw unknown();
      const snapshot = await store.get(childId);
      if (snapshot.parentSessionId !== group.parentId) throw unknown();
      const task = agentView(snapshot);
      const report = snapshot.messages.findLast(message => message.role === "assistant" && !!message.content)?.content ?? "No report yet.";
      // Do not echo arbitrary upstream errors; only a code plus a safe diagnostic.
      const errors = snapshot.events.filter(event => event.type === "error").slice(-1)
        .map(event => `\nError: ${event.error.code}. Inspect the child session before retrying.`).join("");
      const body = clean(`${report}${errors}`);
      const end = Math.min(body.length, offset + limit);
      return { task, content: body.slice(offset, end), offset, nextOffset: end < body.length ? end : null,
        truncated: end < body.length,
        note: task.historical ? "Historical/read-only snapshot; running status may be stale. No task was resumed."
          : "UI observation only; this does not acknowledge results for the parent model.",
      };
    },
    async stopTask(parentId, kind, id) {
      taskKind.parse(kind); taskId.parse(id);
      const group = await family(parentId);
      if (kind === "command") {
        const entry = commandViews(group.ids).find(entry => entry.task.id === id);
        if (!entry || !entry.task.active || !entry.task.controllable || entry.task.historical) return false;
        return entry.access.stop(entry.task.sessionId, id);
      }
      const childId = sessionIdSchema.parse(id);
      if (!group.children.some(child => child.id === childId) || !options.owns(childId)) return false;
      const snapshot = await store.get(childId);
      if (snapshot.parentSessionId !== group.parentId || terminal(snapshot.status) || !options.owns(childId)) return false;
      return options.cancel(childId);
    },
  };
}
