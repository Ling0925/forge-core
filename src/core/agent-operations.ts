import { posix } from "node:path";
import { z } from "zod";
import type { AgentRuntimeDependencies, ApprovalHandler, RunControl } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { sessionIdSchema, settingsFields, type Permission, type RunInput, type SessionSnapshot, type ToolResult, type Usage } from "../shared/schemas";

export const MAX_ACTIVE_AGENTS = 4;
export const MAX_AGENTS_PER_RUN = 32;
const RESULT_BYTES = 65536;
export const isAgentTerminal = (status: string): boolean =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);

export interface ChildOperation {
  controller: AbortController;
  work: Promise<SessionSnapshot>;
  model: string;
  active: boolean;
  acceptingMessages: boolean;
  delivered: boolean;
  writePaths: readonly string[];
  isolation?: "shared" | "worktree";
  messages: string[];
  result?: SessionSnapshot;
  executionError?: boolean;
  resolution?: string;
  usage?: Usage;
  usageComplete?: boolean;
}
export interface AgentEnvironment {
  deps: AgentRuntimeDependencies;
  snapshot: SessionSnapshot;
  input: RunInput;
  permission: Permission;
  signal: AbortSignal;
  children: Map<string, ChildOperation>;
  runChild: (input: RunInput, approve: ApprovalHandler, signal: AbortSignal, control?: RunControl, maxToolCalls?: number) => Promise<SessionSnapshot>;
  approveChild: (id: SessionSnapshot["id"]) => ApprovalHandler;
  saveResolution?: (id: string, childUpdatedAt: string, resolution: string) => Promise<void>;
  onSettled?: (id: SessionSnapshot["id"], child: ChildOperation) => void;
}

const pathSchema = z.string().trim().min(1).max(512).refine(value =>
  !value.startsWith("/") && !/[\\:*?\[\]\x00-\x1f]/.test(value) && !value.split("/").includes(".."),
  "Expected a literal workspace-relative path, not a glob",
).transform(value => posix.normalize(value).replace(/\/$/, ""));
const spawnArgs = z.object({
  task: z.string().trim().min(1).max(16384),
  ownership: z.string().trim().min(1).max(4096).optional(),
  model: settingsFields.model.optional(),
  writePaths: z.array(pathSchema).max(32).optional(),
  maxToolCalls: z.number().int().min(1).max(10000).optional(),
  isolation: z.enum(["shared", "worktree"]).default("shared").describe("shared keeps the parent workspace; worktree uses a separate detached checkout of committed HEAD and retains its changes for inspection/merge."),
}).strict();
const listArgs = z.object({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(50).default(20),
  currentRun: z.boolean().default(false),
}).strict();
const waitArgs = z.object({
  ids: z.array(sessionIdSchema).max(MAX_AGENTS_PER_RUN).optional(),
  mode: z.enum(["all", "any"]).default("all"),
  timeout_ms: z.number().int().min(0).max(1800000).default(600000),
}).strict();
const idArgs = z.object({ id: sessionIdSchema }).strict();
const resultArgs = idArgs.extend({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(8192).default(4096),
}).strict();
const messageArgs = idArgs.extend({ message: z.string().trim().min(1).max(16384) }).strict();
const resolveArgs = idArgs.extend({ resolution: z.string().trim().min(1).max(4096) }).strict();

export const agentArgumentSchemas = {
  spawn_agent: spawnArgs, list_agents: listArgs, wait_agents: waitArgs,
  cancel_agent: idArgs, get_agent_result: resultArgs,
  send_agent_message: messageArgs, resolve_agent: resolveArgs,
} as const;

export function agentResultText(snapshot: SessionSnapshot): string {
  return snapshot.messages.findLast(message => message.role === "assistant" && !!message.content)?.content ?? "No result";
}
export function agentSummary(snapshot: SessionSnapshot, limit = 4096) {
  const text = agentResultText(snapshot);
  const terminal = snapshot.events.findLast(event => event.type === "run_finished");
  return {
    id: snapshot.id, status: snapshot.status, model: snapshot.model,
    workspace: snapshot.workspace, ...(snapshot.agentWorktree ? { worktree: snapshot.agentWorktree } : {}),
    summary: text.slice(0, limit), totalChars: text.length, truncated: text.length > limit,
    nextOffset: text.length > limit ? limit : null,
    errors: snapshot.events.filter(event => event.type === "error").slice(-1).map(event => ({
      code: event.error.code, message: event.error.message.slice(0, 256),
    })),
    ...(terminal?.type === "run_finished" && terminal.usage ? { usage: terminal.usage, usageComplete: terminal.usageComplete ?? false } : {}),
  };
}
export function childReport(id: string, child: ChildOperation, limit = 4096) {
  return {
    ...(child.result ? agentSummary(child.result, limit) : { id, model: child.model, status: child.active ? "running" : "failed", summary: "No terminal snapshot", truncated: false }),
    ...(child.executionError ? { status: "failed", error: "Child execution or cleanup failed; inspect effects before proceeding." } : {}),
    active: child.active, currentRun: true, handled: !!child.resolution,
    ...(child.usage ? { usage: child.usage, usageComplete: child.usageComplete ?? false } : {}),
  };
}
/** Reduce text per item, never slice serialized JSON or silently drop results. */
export function boundedReports<T>(items: readonly T[], report: (item: T, limit: number) => unknown): string {
  for (let limit = 4096; ; limit = Math.floor(limit / 2)) {
    const content = JSON.stringify(items.map(item => report(item, limit)));
    if (Buffer.byteLength(content, "utf8") <= RESULT_BYTES) return content;
    if (!limit) throw new ForgeError("budget", "Agent metadata exceeds the result budget; request fewer IDs.");
  }
}
function output(value: unknown): ToolResult {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content, "utf8") > RESULT_BYTES)
    throw new ForgeError("budget", "Agent result exceeds the output budget; request a smaller page.");
  return { content, isError: false };
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new ForgeError("cancelled", "Agent operation cancelled.");
}
const overlaps = (a: string, b: string): boolean =>
  a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const handled = (env: AgentEnvironment, child: SessionSnapshot): boolean =>
  !!env.snapshot.agentResolutions?.some(item => item.id === child.id && item.childUpdatedAt === child.updatedAt);
async function ownedSnapshot(env: AgentEnvironment, id: string): Promise<SessionSnapshot> {
  // Authorize via relationship before loading a transcript. Never expose unrelated session data.
  const owned = (await env.deps.store.list()).some(item => item.id === id && item.parentSessionId === env.input.sessionId);
  if (!owned) throw new ForgeError("invalid_input", "Unknown child of this parent session.");
  const child = await env.deps.store.get(sessionIdSchema.parse(id));
  if (child.parentSessionId !== env.input.sessionId)
    throw new ForgeError("invalid_input", "Unknown child of this parent session.");
  return child;
}
async function pauseUntil(work: Promise<unknown>, signal: AbortSignal, timeout: number): Promise<void> {
  check(signal);
  if (timeout === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(resolve, timeout);
        abort = () => reject(new ForgeError("cancelled", "Agent wait cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  check(signal);
}

export async function executeAgentOperation(name: string, args: Record<string, unknown>, env: AgentEnvironment): Promise<ToolResult> {
  const { children, deps, snapshot, input } = env;
  check(env.signal);
  switch (name) {
    case "spawn_agent": {
      const parsed = spawnArgs.parse(args);
      if (snapshot.parentSessionId) throw new ForgeError("invalid_input", "Child agents cannot spawn further agents.");
      if ([...children.values()].filter(child => child.active).length >= MAX_ACTIVE_AGENTS)
        throw new ForgeError("busy", "Four child agents are active; wait for a slot before spawning.");
      if (children.size >= MAX_AGENTS_PER_RUN)
        throw new ForgeError("budget", "The separate 32-child total budget for this run is exhausted.");
      if (parsed.maxToolCalls !== undefined && parsed.maxToolCalls > deps.settings.maxToolCalls)
        throw new ForgeError("invalid_input", "Child tool budget cannot exceed the parent per-run ceiling.");
      const writePaths = [...new Set(parsed.writePaths ?? [])];
      if (parsed.isolation === "worktree" && env.permission === "readonly")
        throw new ForgeError("tool", "Readonly mode cannot create a worktree.");
      if (parsed.isolation === "worktree" && !deps.agentWorktrees)
        throw new ForgeError("tool", "This host does not provide agent worktrees.");
      if (parsed.isolation === "worktree" && !deps.childContextFactory && !deps.childToolFactory)
        throw new ForgeError("tool", "This host cannot construct tools for an isolated child workspace.");
      const conflicts = parsed.isolation === "worktree" ? [] : [...children.entries()].filter(([, child]) => child.active && child.isolation !== "worktree" && child.writePaths.some(a => writePaths.some(b => overlaps(a, b))));
      if (conflicts.length) return { content: JSON.stringify({ code: "scope_conflict", error: "Declared write paths overlap active children. Wait or assign disjoint paths; this is coordination, not a sandbox.", ids: conflicts.map(([id]) => id) }), isError: true };
      const child = await deps.store.create({ workspace: snapshot.workspace, title: parsed.task.slice(0, 256), model: parsed.model ?? snapshot.model,
        ...(snapshot.providerSourceId ? { providerSourceId: snapshot.providerSourceId } : {}) });
      await deps.store.save({ ...child, parentSessionId: input.sessionId, agentTask: parsed.task,
        ...(parsed.ownership ? { ownership: parsed.ownership } : {}),
        ...(parsed.writePaths ? { writePaths } : {}), permissionCeiling: env.permission });
      let childWorkspace = child.workspace;
      if (parsed.isolation === "worktree" && deps.agentWorktrees) {
        try {
          const isolated = await deps.agentWorktrees.create({ workspace: snapshot.workspace, sessionId: child.id, signal: env.signal });
          childWorkspace = isolated.workspace;
          const { workspace: _workspace, ...agentWorktree } = isolated;
          await deps.store.save({ ...await deps.store.get(child.id), workspace: childWorkspace, agentWorktree });
        } catch (error) {
          await deps.store.save({ ...await deps.store.get(child.id), status: env.signal.aborted ? "cancelled" : "failed" });
          throw error;
        }
      }
      const controller = new AbortController();
      const operation: ChildOperation = {
        controller, work: Promise.resolve(child), model: child.model, active: true,
        acceptingMessages: true, delivered: false, writePaths, isolation: parsed.isolation, messages: [],
      };
      // Reserve before any child code runs; release the active slot only after cleanup settles.
      children.set(child.id, operation);
      operation.work = Promise.resolve().then(() => env.runChild({
        sessionId: child.id, model: child.model,
        prompt: `${parsed.task}\nOwnership: ${parsed.ownership ?? "unspecified"}`,
        permission: env.permission, ...(input.mode ? { mode: input.mode } : {}),
      }, env.approveChild(child.id), AbortSignal.any([env.signal, controller.signal]), {
        drainSteering(final = false) {
          if (final && operation.messages.length === 0) operation.acceptingMessages = false;
          return operation.messages.splice(0);
        },
      }, parsed.maxToolCalls)).then(result => {
        operation.result = result;
        return result;
      }, async error => {
        operation.executionError = true;
        // Persist failures outside the child loop too (construction/disposal/lock
        // failures). A completed model answer is not successful resource cleanup.
        try {
          const release = await deps.store.acquire(child.id);
          try {
            const stored = await deps.store.get(child.id);
            const timestamp = deps.now?.() ?? new Date().toISOString();
            const failed: SessionSnapshot = { ...stored, updatedAt: timestamp,
              status: env.signal.aborted || controller.signal.aborted ? "cancelled" : "failed",
              events: [...stored.events, { type: "error", sessionId: child.id, timestamp,
                error: { code: "tool", message: "Child execution or cleanup failed; inspect effects before proceeding.", retryable: false } }],
            };
            await deps.store.save(failed);
            operation.result = failed;
          } finally { await release(); }
        } catch { /* Original failure remains visible; never replay uncertain effects. */ }
        throw error;
      }).finally(() => {
        operation.active = false;
        operation.acceptingMessages = false;
        try { env.onSettled?.(child.id, operation); } catch { /* Display is not transactional. */ }
      });
      void operation.work.catch(() => undefined);
      deps.onChildOperation?.(child.id, controller, operation.work);
      return output({ childSessionId: child.id, model: child.model, workspace: childWorkspace, isolation: parsed.isolation, declaredWritePathCount: writePaths.length,
        warning: parsed.isolation === "worktree"
          ? "Separate checkout of committed HEAD; parent uncommitted files are not copied. Changes are retained here for inspection and merge."
          : "Shared workspace. Declared paths only prevent overlapping assignments; commands and file writes are not sandboxed by ownership." });
    }
    case "list_agents": {
      const { offset, limit, currentRun } = listArgs.parse(args);
      const all = (await deps.store.list()).filter(child => child.parentSessionId === input.sessionId && (!currentRun || children.has(child.id)));
      const agents: unknown[] = [];
      let next = offset;
      for (const item of all.slice(offset, offset + limit)) {
        const operation = children.get(item.id);
        const details = operation?.result ?? await deps.store.get(item.id);
        const entry = { ...item, currentRun: !!operation, active: operation?.active ?? false,
          ownership: details.ownership?.slice(0, 512), ownershipTruncated: (details.ownership?.length ?? 0) > 512,
          writePaths: details.writePaths?.slice(0, 8), writePathsTruncated: (details.writePaths?.length ?? 0) > 8,
          controllable: !!operation?.active, handled: !!operation?.resolution || handled(env, details) };
        if (Buffer.byteLength(JSON.stringify([...agents, entry]), "utf8") > RESULT_BYTES - 1024) break;
        agents.push(entry); next++;
      }
      return output({ agents, total: all.length, offset, nextOffset: next < all.length ? next : null, truncated: next < all.length });
    }
    case "wait_agents": {
      const parsed = waitArgs.parse(args);
      const ids = [...new Set(parsed.ids ?? [...children.keys()])];
      const history = new Map<string, SessionSnapshot>();
      const errors = new Map<string, string>();
      for (const id of ids) if (!children.has(id)) {
        try { history.set(id, await ownedSnapshot(env, id)); }
        catch (error) {
          if (!(error instanceof ForgeError) || error.code !== "invalid_input") throw error;
          errors.set(id, "Unknown child of this parent session.");
        }
      }
      const ready = (id: string) => errors.has(id) || history.has(id) || !children.get(id)?.active;
      const pending = ids.filter(id => !ready(id)).map(id => children.get(id)!.work.catch(() => undefined));
      if (pending.length && !(parsed.mode === "any" && ids.some(ready)))
        await pauseUntil(parsed.mode === "any" ? Promise.race(pending) : Promise.all(pending), env.signal, parsed.timeout_ms);
      check(env.signal);
      const content = boundedReports(ids, (id, limit) => {
        const child = children.get(id);
        if (child) return childReport(id, child, limit);
        const stored = history.get(id);
        if (stored) return { ...agentSummary(stored, limit), currentRun: false, active: false, controllable: false, handled: handled(env, stored),
          ...(!isAgentTerminal(stored.status) ? { warning: "Not owned by this run; persisted status may be stale. No execution was resumed." } : {}) };
        return { id, error: errors.get(id) };
      });
      for (const id of ids) { const child = children.get(id); if (child && !child.active) child.delivered = true; }
      return { content, isError: false };
    }
    case "get_agent_result": {
      const { id, offset, limit } = resultArgs.parse(args);
      const operation = children.get(id);
      const child = operation?.result ?? await ownedSnapshot(env, id);
      const text = agentResultText(child);
      const end = Math.min(text.length, offset + limit);
      return output({ id, status: operation?.executionError ? "failed" : child.status, model: child.model,
        workspace: child.workspace, ...(child.agentWorktree ? { worktree: child.agentWorktree } : {}),
        content: text.slice(offset, end), offset, totalChars: text.length, nextOffset: end < text.length ? end : null,
        truncated: end < text.length, currentRun: !!operation, active: operation?.active ?? false,
        handled: !!operation?.resolution || handled(env, child),
        errors: agentSummary(child, 0).errors, usage: operation?.usage ?? agentSummary(child, 0).usage,
        usageComplete: operation?.usageComplete ?? agentSummary(child, 0).usageComplete ?? false,
        ownership: child.ownership?.slice(0, 512), ownershipTruncated: (child.ownership?.length ?? 0) > 512,
        writePaths: child.writePaths?.slice(0, 8), writePathsTruncated: (child.writePaths?.length ?? 0) > 8 });
    }
    case "cancel_agent": {
      const { id } = idArgs.parse(args);
      const child = children.get(id);
      if (!child) throw new ForgeError("invalid_input", "Child is not controlled by this run; historical sessions cannot be cancelled here.");
      child.acceptingMessages = false;
      child.controller.abort();
      await child.work.catch(() => undefined);
      const result = output(childReport(id, child));
      child.delivered = true;
      return result;
    }
    case "send_agent_message": {
      const { id, message } = messageArgs.parse(args);
      const child = children.get(id);
      if (!child?.active || !child.acceptingMessages || child.controller.signal.aborted)
        throw new ForgeError("invalid_input", "Child is not accepting messages in this run; no task was restarted.");
      if (child.messages.length >= 8) throw new ForgeError("budget", "Child steering queue is full; wait for it to consume pending messages.");
      child.messages.push(message);
      return output({ id, queued: true, pendingMessages: child.messages.length });
    }
    case "resolve_agent": {
      const { id, resolution } = resolveArgs.parse(args);
      const operation = children.get(id);
      if (operation?.active) throw new ForgeError("busy", "Wait for the child and inspect its effects before resolving its outcome.");
      const child = operation?.result ?? await ownedSnapshot(env, id);
      if (!isAgentTerminal(child.status) && !operation?.executionError)
        throw new ForgeError("busy", "Only settled child outcomes can be resolved; persisted running state may be stale.");
      if (!env.saveResolution) throw new ForgeError("internal", "Resolution persistence is unavailable.");
      await env.saveResolution(id, child.updatedAt, resolution);
      if (operation) { operation.resolution = resolution; operation.delivered = true; }
      return output({ id, status: operation?.executionError ? "failed" : child.status, handled: true, resolution });
    }
    default: throw new ForgeError("invalid_input", "Unknown agent operation.");
  }
}
