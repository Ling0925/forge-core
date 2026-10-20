import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { cleanupProcess } from "../mcp/cleanup";
import { ForgeError } from "../shared/errors";
import {
  type AfterToolHookEvent,
  type BeforeToolHookEvent,
  type BeforeToolHookResult,
  type RunEndHookEvent,
  TOOL_HOOK_MAX_ARGUMENT_BYTES,
  TOOL_HOOK_MAX_CONTENT_PREVIEW_BYTES,
  TOOL_HOOK_MAX_REASON_CHARS,
  TOOL_HOOK_NAMES,
  type ToolErrorHookEvent,
  type ToolHookDiagnostic,
  type ToolHookEntry,
  type ToolHookName,
  type ToolHookService,
  type ToolHookStatus,
  toolHooksConfigSchema,
  truncateToolHookText,
} from "../shared/tool-hooks";

/**
 * Host-configured executable tool lifecycle hooks.
 *
 * Guarantees:
 * - Configuration is passed explicitly by the host; nothing is auto-loaded
 *   from a workspace, repository, skill or session.
 * - Hooks run as real child processes with `argv` and no shell. Input is a
 *   single JSON document on stdin; stdout is only interpreted for an explicit
 *   before-hook allow/deny decision and is otherwise not surfaced.
 * - Environment is minimal (PATH/TMPDIR, plus SYSTEMROOT on Windows); no
 *   provider credentials or arbitrary host variables are forwarded.
 * - Hooks never alter tool arguments, grant permissions, replay tools or
 *   replace the original tool outcome. A failing before hook fails closed.
 * - Timeout, abort, close/error and dispose join the owned process group
 *   through a single cleanup path; an invocation never reports success while a
 *   descendant may still be running, and cleanup failure is reported as failure.
 * - Children run with `event.session.workspace` as cwd.
 * - Readonly calls (service option or per-call session permission) skip
 *   executable hooks; a before-gate skip allows the ordinary tool to proceed.
 * - Diagnostics are bounded and authored; raw exceptions, hook-supplied denial
 *   reasons and child output are never logged or returned.
 */

const SAFE_REASONS = {
  skipped:
    "Executable hooks are disabled in readonly mode; nothing was executed.",
  spawnFailed: "Hook process could not be started.",
  nonzeroExit: "Hook exited with a nonzero status.",
  invalidDecision:
    "Before hook produced no valid JSON decision; the tool was not run.",
  timedOut: "Hook exceeded its timeout and was terminated.",
  cancelled: "Hook was cancelled and terminated.",
  cleanupFailed: "Hook process tree could not be confirmed terminated.",
  denied: "The beforeTool hook denied this tool call.",
  disposed: "Hook service was disposed before the hook could start.",
} as const;

const beforeDecisionSchema = z
  .object({
    decision: z.enum(["allow", "deny"]),
    // Accepted for protocol compatibility but never exposed publicly.
    reason: z.string().max(2000).optional(),
  })
  .strict();

/**
 * Single-line, bounded, control-character-free public reason text.
 *
 * Diagnostics only ever carry authored labels, so this is defense in depth:
 * any text that is ever surfaced is flattened and has known secret values
 * passed by the host removed.
 */
function safeReason(text: string, redactValues: readonly string[]): string {
  let flattened = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    flattened += code < 0x20 || code === 0x7f ? " " : char;
  }
  let result = flattened.replace(/\s+/g, " ").trim();
  for (const value of redactValues) {
    if (value.length > 0) result = result.split(value).join("[redacted]");
  }
  return result.slice(0, TOOL_HOOK_MAX_REASON_CHARS);
}

interface Invocation {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputTruncated: boolean;
  readonly failedToStart: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Cleanup did not confirm the process tree is gone. */
  readonly cleanupFailed: boolean;
  /** The service was disposed before this invocation could start. */
  readonly disposed: boolean;
}

interface StreamCapture {
  readonly read: () => {
    readonly text: string;
    readonly bytes: number;
    readonly truncated: boolean;
  };
}

function captureStream(
  stream: NodeJS.ReadableStream,
  limit: number,
): StreamCapture {
  const chunks: Buffer[] = [];
  let kept = 0;
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (kept >= limit) return;
    const slice = chunk.subarray(0, limit - kept);
    kept += slice.length;
    chunks.push(Buffer.from(slice));
  });
  return {
    read: () => ({
      text: Buffer.concat(chunks).toString("utf8"),
      bytes,
      truncated: bytes > limit,
    }),
  };
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.platform === "win32" && process.env.SYSTEMROOT)
    env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

/**
 * Join an owned process tree exactly once. Concurrent timeout/abort/close/
 * dispose callers share the same promise. Returns false when cleanup could not
 * confirm the tree is gone; callers must report that as a failure rather than
 * swallowing it.
 */
function cleanupOnce(
  child: ChildProcess,
  active: Set<ChildProcess>,
  cleaning: Map<ChildProcess, Promise<boolean>>,
  cleaned: WeakSet<ChildProcess>,
): Promise<boolean> {
  if (cleaned.has(child)) return Promise.resolve(true);
  const existing = cleaning.get(child);
  if (existing) return existing;
  const pending = (async () => {
    try {
      // Non-Linux cleanup cannot address a tree and only signals the direct
      // child; once that child has exited there is nothing left to join.
      if (
        process.platform !== "linux" &&
        (child.exitCode !== null || child.signalCode !== null)
      ) {
        cleaned.add(child);
        active.delete(child);
        return true;
      }
      await cleanupProcess(child);
      cleaned.add(child);
      active.delete(child);
      return true;
    } catch {
      // Leave the child in `active` so a later dispose can retry and report
      // the failure; never pretend cleanup succeeded.
      return false;
    } finally {
      cleaning.delete(child);
    }
  })();
  cleaning.set(child, pending);
  return pending;
}

export interface CreateToolHookServiceOptions {
  /**
   * When true, executable hooks are disabled and every matching hook returns
   * an explicit `skipped` diagnostic instead of spawning anything. A call whose
   * `event.session.permission` is `"readonly"` is also skipped per call.
   */
  readonly readonlyMode?: boolean;
  /**
   * Known secret values (for example credential fragments from tool arguments)
   * that must never appear in a public diagnostic. Diagnostic reasons are
   * authored labels, so this is defense in depth.
   */
  readonly redactValues?: readonly string[];
}

export function createToolHookService(
  config: unknown,
  options: CreateToolHookServiceOptions = {},
): ToolHookService {
  const parsed = toolHooksConfigSchema.safeParse(config);
  if (!parsed.success)
    throw new ForgeError(
      "invalid_input",
      "Tool hook configuration is invalid; hooks are disabled until corrected.",
    );
  const hooks = parsed.data;
  const readonlyMode = options.readonlyMode === true;
  const redactValues = (options.redactValues ?? []).filter(
    (value) => value.length > 0,
  );
  const active = new Set<ChildProcess>();
  const cleaning = new Map<ChildProcess, Promise<boolean>>();
  const cleaned = new WeakSet<ChildProcess>();
  let disposed = false;

  const cleanup = (child: ChildProcess) =>
    cleanupOnce(child, active, cleaning, cleaned);

  const entriesFor = (name: ToolHookName): readonly ToolHookEntry[] =>
    hooks[name];
  const hookCount = TOOL_HOOK_NAMES.reduce(
    (sum, name) => sum + hooks[name].length,
    0,
  );

  function matches(
    entry: ToolHookEntry,
    toolName: string | undefined,
  ): boolean {
    if (entry.tools === undefined) return true;
    if (toolName === undefined) return false;
    return entry.tools.includes(toolName);
  }

  function skipped(
    name: ToolHookName,
    entry: ToolHookEntry,
  ): ToolHookDiagnostic {
    return {
      hook: name,
      id: entry.id,
      status: "skipped",
      reason: SAFE_REASONS.skipped,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
    };
  }

  async function invoke(
    entry: ToolHookEntry,
    stdin: string,
    signal: AbortSignal | undefined,
    cwd: string,
  ): Promise<Invocation> {
    const base = {
      exitCode: null,
      stdout: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTruncated: false,
      failedToStart: false,
      timedOut: false,
      cancelled: false,
      cleanupFailed: false,
      disposed: false,
    } as const;
    if (disposed) return { ...base, failedToStart: true, disposed: true };
    if (signal?.aborted) return { ...base, cancelled: true };
    return await new Promise<Invocation>((resolve) => {
      let child: ChildProcess | undefined;
      let stdout: StreamCapture | undefined;
      let stderr: StreamCapture | undefined;
      const timeouts: { timer?: ReturnType<typeof setTimeout> } = {};
      let removeAbort = () => {};
      let timedOut = false;
      let cancelled = false;
      let failedToStart = false;
      let settled = false;
      let settling: Promise<void> | undefined;

      /**
       * The single settlement path. It always joins process-tree cleanup
       * before resolving, so a caller never observes a settled invocation
       * while an owned descendant may still be running. Concurrent close /
       * error / timeout / abort / dispose all share this one promise.
       */
      const settle = (exitCode: number | null): Promise<void> => {
        if (settling) return settling;
        settled = true;
        if (timeouts.timer) clearTimeout(timeouts.timer);
        removeAbort();
        settling = (async () => {
          let cleanupFailed = false;
          if (child) {
            cleanupFailed = !(await cleanup(child));
          }
          const out = stdout?.read() ?? {
            text: "",
            bytes: 0,
            truncated: false,
          };
          const err = stderr?.read() ?? {
            text: "",
            bytes: 0,
            truncated: false,
          };
          resolve({
            exitCode,
            stdout: out.text,
            stdoutBytes: out.bytes,
            stderrBytes: err.bytes,
            outputTruncated: out.truncated || err.truncated,
            failedToStart,
            timedOut,
            cancelled,
            cleanupFailed,
            disposed: false,
          });
        })();
        return settling;
      };

      const terminate = (kind: "timeout" | "abort") => {
        if (settled) return;
        if (kind === "timeout") timedOut = true;
        else cancelled = true;
        void settle(child?.exitCode ?? null);
      };

      try {
        child = spawn(entry.command, [...entry.args], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: minimalEnv(),
          shell: false,
          detached: true,
          windowsHide: true,
        });
      } catch {
        failedToStart = true;
        void settle(null);
        return;
      }
      const spawned = child;
      active.add(spawned);
      const spawnedStdout = spawned.stdout;
      const spawnedStderr = spawned.stderr;
      if (spawnedStdout) {
        stdout = captureStream(spawnedStdout, entry.maxOutputBytes);
      }
      if (spawnedStderr) {
        stderr = captureStream(spawnedStderr, entry.maxOutputBytes);
      }
      spawned.on("error", () => {
        // Includes spawn ENOENT/EACCES; no process exists to clean up.
        failedToStart = true;
        void settle(null);
      });
      spawned.on("close", (code) => {
        void settle(code ?? null);
      });
      spawned.stdin?.on("error", () => {
        // A child that exits before reading stdin must not surface EPIPE.
      });
      timeouts.timer = setTimeout(() => {
        terminate("timeout");
      }, entry.timeoutMs);
      timeouts.timer.unref?.();
      if (signal) {
        const onAbort = () => {
          terminate("abort");
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) terminate("abort");
      }
      try {
        spawned.stdin?.end(stdin);
      } catch {
        // A failed write is observed through close/error.
      }
    });
  }

  async function runEntries(
    name: ToolHookName,
    toolName: string | undefined,
    payload: unknown,
    session: BeforeToolHookEvent["session"],
    signal: AbortSignal | undefined,
  ): Promise<readonly ToolHookDiagnostic[]> {
    const diagnostics: ToolHookDiagnostic[] = [];
    // Per-call readonly permission is authoritative even if the service was
    // constructed while a different permission was active.
    const skipExecutable = readonlyMode || session.permission === "readonly";
    for (const entry of entriesFor(name)) {
      if (!matches(entry, toolName)) continue;
      if (skipExecutable) {
        diagnostics.push(skipped(name, entry));
        continue;
      }
      const text = JSON.stringify({
        hook: name,
        version: 1,
        ...(payload as Record<string, unknown>),
      });
      const started = Date.now();
      const invocation = await invoke(entry, text, signal, session.workspace);
      const diagnostic = diagnosticFor(name, entry, invocation, started);
      diagnostics.push(diagnostic);
      // A gate stops at the first hook that did not explicitly allow the call;
      // later before hooks are not run and the tool is not executed. Readonly
      // skips are not denials and are reported for every configured hook.
      if (
        name === "beforeTool" &&
        diagnostic.status !== "ok" &&
        diagnostic.status !== "skipped"
      )
        break;
    }
    return diagnostics;
  }

  function diagnosticFor(
    name: ToolHookName,
    entry: ToolHookEntry,
    invocation: Invocation,
    started: number,
  ): ToolHookDiagnostic {
    let status: ToolHookStatus;
    let reason: string | undefined;
    if (invocation.cleanupFailed) {
      // Never call a hook settled-successful when the process tree could not
      // be confirmed gone; the host must treat this as a failure.
      status = "failed";
      reason = safeReason(SAFE_REASONS.cleanupFailed, redactValues);
    } else if (invocation.cancelled) {
      status = "cancelled";
      reason = safeReason(SAFE_REASONS.cancelled, redactValues);
    } else if (invocation.timedOut) {
      status = "timed_out";
      reason = safeReason(SAFE_REASONS.timedOut, redactValues);
    } else if (invocation.disposed) {
      status = "failed";
      reason = safeReason(SAFE_REASONS.disposed, redactValues);
    } else if (invocation.failedToStart) {
      status = "failed";
      reason = safeReason(SAFE_REASONS.spawnFailed, redactValues);
    } else if (invocation.exitCode !== 0) {
      status = "failed";
      reason = safeReason(SAFE_REASONS.nonzeroExit, redactValues);
    } else if (name === "beforeTool") {
      const decision = decide(invocation);
      if (decision === undefined) {
        status = "failed";
        reason = safeReason(SAFE_REASONS.invalidDecision, redactValues);
      } else if (decision.decision === "deny") {
        status = "denied";
        // Never expose the hook-authored decision.reason: it may echo
        // credentials copied from tool arguments or the payload.
        reason = safeReason(SAFE_REASONS.denied, redactValues);
      } else {
        status = "ok";
      }
    } else {
      status = "ok";
    }
    const base = {
      hook: name,
      id: entry.id,
      status,
      durationMs: Math.max(0, Date.now() - started),
      stdoutBytes: invocation.stdoutBytes,
      stderrBytes: invocation.stderrBytes,
      outputTruncated: invocation.outputTruncated,
    } as const;
    if (reason === undefined) return base;
    if (invocation.exitCode === null) return { ...base, reason };
    return { ...base, exitCode: invocation.exitCode, reason };
  }

  function decide(
    invocation: Invocation,
  ): z.infer<typeof beforeDecisionSchema> | undefined {
    if (invocation.failedToStart || invocation.outputTruncated)
      return undefined;
    const trimmed = invocation.stdout.trim();
    if (trimmed.length === 0) return { decision: "allow" };
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    const parsed = beforeDecisionSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  function eventPayload(
    event:
      | BeforeToolHookEvent
      | AfterToolHookEvent
      | ToolErrorHookEvent
      | RunEndHookEvent,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { session: event.session };
    if ("tool" in event) {
      const args = truncateToolHookText(
        event.tool.arguments,
        TOOL_HOOK_MAX_ARGUMENT_BYTES,
      );
      payload.tool = {
        name: event.tool.name,
        callId: event.tool.callId,
        arguments: args.text,
        argumentsTruncated: args.truncated,
      };
    }
    if ("outcome" in event) {
      const preview = truncateToolHookText(
        event.outcome.contentPreview,
        TOOL_HOOK_MAX_CONTENT_PREVIEW_BYTES,
      );
      payload.outcome = {
        isError: event.outcome.isError,
        contentBytes: event.outcome.contentBytes,
        contentPreview: preview.text,
        previewTruncated: event.outcome.truncated || preview.truncated,
        changeCount: event.outcome.changeCount,
      };
    }
    if ("errorCode" in event && event.errorCode !== undefined)
      payload.errorCode = event.errorCode;
    if ("run" in event) payload.run = event.run;
    return payload;
  }

  return {
    configured: hookCount > 0,
    hookCount,
    async beforeTool(event, runOptions) {
      const diagnostics = await runEntries(
        "beforeTool",
        event.tool.name,
        eventPayload(event),
        event.session,
        runOptions?.signal,
      );
      const denied = diagnostics.find(
        (item) => item.status !== "ok" && item.status !== "skipped",
      );
      if (denied === undefined) return { allowed: true, diagnostics };
      return {
        allowed: false,
        denialReason:
          diagnostics.find((item) => item.status === "denied")?.reason ??
          "A beforeTool hook did not allow this tool call; the tool was not run.",
        diagnostics,
      } satisfies BeforeToolHookResult;
    },
    async afterTool(event, runOptions) {
      return await runEntries(
        "afterTool",
        event.tool.name,
        eventPayload(event),
        event.session,
        runOptions?.signal,
      );
    },
    async toolError(event, runOptions) {
      return await runEntries(
        "toolError",
        event.tool.name,
        eventPayload(event),
        event.session,
        runOptions?.signal,
      );
    },
    async runEnd(event, runOptions) {
      return await runEntries(
        "runEnd",
        undefined,
        eventPayload(event),
        event.session,
        runOptions?.signal,
      );
    },
    async dispose() {
      disposed = true;
      const children = [...active];
      active.clear();
      const results = await Promise.all(
        children.map((child) => cleanup(child)),
      );
      if (results.some((ok) => !ok))
        throw new ForgeError(
          "internal",
          "A tool hook process tree did not terminate during dispose.",
        );
    },
  };
}

/**
 * Narrow helper for the coordinator: build the bounded preview/outcome record
 * from an existing `ToolResult` without importing it here.
 */
export function toToolHookOutcome(result: {
  readonly content: string;
  readonly isError: boolean;
  readonly changes?: readonly unknown[] | undefined;
}): {
  readonly isError: boolean;
  readonly contentBytes: number;
  readonly contentPreview: string;
  readonly truncated: boolean;
  readonly changeCount: number;
} {
  const bytes = Buffer.byteLength(result.content, "utf8");
  const bounded = truncateToolHookText(
    result.content,
    TOOL_HOOK_MAX_CONTENT_PREVIEW_BYTES,
  );
  return {
    isError: result.isError,
    contentBytes: bytes,
    contentPreview: bounded.text,
    truncated: bounded.truncated,
    changeCount: Math.min(result.changes?.length ?? 0, 256),
  };
}
