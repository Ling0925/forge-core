import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { invalidToolInput } from "../shared/tool-input";
import type { ToolCall, ToolDefinition, ToolResult } from "../shared/schemas";
import type { CommandTaskAccess, TaskView } from "../shared/task-view";
import { redactCommandArguments } from "../shared/tool-activity";

const RESULT_LIMIT = 128 * 1024;
const taskArguments = z.object({
  action: z.enum(["list", "read", "wait", "stop"]),
  id: z.string().min(1).max(128).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(12000).default(12000),
  timeout_ms: z.number().int().min(0).max(120000).default(30000),
}).strict().superRefine((args, ctx) => {
  if (args.action !== "list" && args.id === undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "Required for read, wait and stop; use list to discover task IDs." });
});
const completionMetadata = z.object({
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().max(32).regex(/^[A-Z0-9]+$/).nullable().optional(),
  timed_out: z.boolean().optional(),
  truncated: z.boolean().optional(),
  output_id: z.string().uuid().optional(),
  preview_truncated: z.boolean().optional(),
  spawn_failed: z.boolean().optional(),
});
const taskDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "command_task",
    description: "Inspect/join/stop this run's already-approved commands; readonly denied. Running reads return status only; settled output is redacted before UTF-16 pagination (not arbitrary-secret detection). Wait timeout does not cancel; stop joins. Capacity: 4 active/32 total. No cross-run recovery; uninspected tasks are joined at parent finalization.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "read", "wait", "stop"] },
        id: { type: "string", minLength: 1, maxLength: 128, description: "Required for read, wait and stop. Use an ID returned by run_command or command_task list; omit for list." },
        offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 12000, default: 12000 },
        timeout_ms: { type: "integer", minimum: 0, maximum: 120000, default: 30000 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};

type Outcome = { result: ToolResult } | { error: unknown };
type Task = {
  id: string;
  sessionId: ToolContext["sessionId"];
  startedAt: string;
  title: string;
  controller: AbortController;
  started: boolean;
  delivered: boolean;
  metadata: z.infer<typeof completionMetadata>;
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  done: Promise<Outcome>;
  output?: string;
  resultIsError?: boolean;
  outputTruncated: boolean;
};

function result(value: unknown, isError = false): ToolResult {
  return { content: JSON.stringify(value), isError };
}
function cancelled(): ForgeError {
  return new ForgeError("cancelled", "Tool execution cancelled.");
}

/** In-memory ownership only: never adopts tasks from another registry or run. */
export function withCommandTasks(
  base: LocalToolRegistry,
  options: { redactValues?: readonly string[] } = {},
): LocalToolRegistry {
  if (!base.definitions.some((item) => item.function.name === "run_command"))
    throw new Error("Command tasks require a run_command tool.");
  if (base.definitions.some((item) => item.function.name === "command_task"))
    throw new Error("Duplicate tool name: command_task");
  const known = [...(options.redactValues ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  const tasks = new Map<string, Task>();
  let disposal: Promise<void> | undefined;
  const definitions = base.definitions.map((definition): ToolDefinition => {
    if (definition.function.name !== "run_command") return definition;
    const parameters = definition.function.parameters;
    const properties = parameters.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties))
      throw new Error("run_command requires object parameter properties.");
    return {
      ...definition,
      function: {
        ...definition.function,
        description: `${definition.function.description} Optional background (default false) returns a task id only after approval and successful spawn, with original command limits unchanged. Use command_task for status/completed output and join every task before parent completion.`,
        parameters: {
          ...parameters,
          properties: { ...properties, background: { type: "boolean", default: false } },
        },
      },
    };
  });
  definitions.push(taskDefinition);

  function redact(text: string): string {
    let clean = text;
    for (const value of known) clean = clean.split(value).join("[REDACTED]");
    return clean;
  }
  function commandTitle(call: ToolCall): string {
    try {
      const args: unknown = JSON.parse(call.function.arguments);
      if (!args || typeof args !== "object" || !("argv" in args) || !Array.isArray(args.argv)) return "Command";
      const argv = args.argv.slice(0, 4).filter((arg): arg is string => typeof arg === "string");
      const safe = redactCommandArguments(argv.map(redact));
      const parts: string[] = [];
      for (const [index, arg] of safe.entries()) {
        const item = index === 0 ? arg.split(/[\\/]/).at(-1) ?? "Command" : arg;
        if (item.length > 40 || /[\s\x00-\x1f\x7f]/.test(item)) { parts.push("…"); break; }
        // Never display shell source or inline scripts, even when they are short.
        if (index > 0 && /^(?:-[a-z]*[cep].*|--(?:eval|command)(?:=.*)?)$/i.test(item)) {
          parts.push(item.startsWith("--") ? item.split("=")[0]! : item.length <= 3 ? item : "-…", "…");
          break;
        }
        parts.push(item);
      }
      if (args.argv.length > argv.length) parts.push("…");
      return redactCommandArguments([redact(parts.join(" "))])[0]?.slice(0, 160) || "Command";
    } catch { return "Command"; }
  }
  function safeContent(content: string): string {
    // Decode first: a configured secret may contain newlines/quotes escaped in JSON.
    function clean(value: unknown): unknown {
      if (typeof value === "string") return redact(value);
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), clean(item)]));
      return value;
    }
    try {
      return redact(JSON.stringify(clean(JSON.parse(content))));
    } catch {
      return redact(content);
    }
  }
  function pending(task: Task): boolean {
    return task.status === "starting" || task.status === "running";
  }
  function summary(task: Task) {
    return {
      id: task.id,
      status: task.status,
      output_available: !pending(task),
      ...task.metadata,
      ...(task.resultIsError === undefined ? {} : { result_is_error: task.resultIsError }),
    };
  }
  function page(task: Task, offset: number, limit: number): ToolResult {
    if (pending(task)) return result({ ...summary(task), output_available: false });
    task.delivered = true;
    const output = task.output ?? "";
    const end = Math.min(output.length, offset + limit);
    return result({
      ...summary(task),
      output: output.slice(offset, end),
      offset,
      offset_units: "utf16_code_units",
      total_chars: output.length,
      next_offset: end < output.length ? end : null,
      truncated: end < output.length,
      output_truncated: task.outputTruncated,
    }, task.resultIsError);
  }
  async function wait(task: Task, timeout: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelled();
    if (!pending(task) || timeout === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        task.done,
        new Promise<void>((resolve, reject) => {
          timer = setTimeout(resolve, timeout);
          abort = () => reject(cancelled());
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }
  async function manage(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (context.permission === "readonly") return result({ error: "Readonly forbids command tasks." }, true);
    if (context.signal.aborted) throw cancelled();
    const parsed = taskArguments.safeParse((() => {
      try { return JSON.parse(call.function.arguments); } catch { return undefined; }
    })());
    if (!parsed.success) return invalidToolInput(parsed.error);
    const args = parsed.data;
    if (args.action === "list") {
      const owned = [...tasks.values()].filter((task) => task.started && task.sessionId === context.sessionId);
      return result({ tasks: owned.map(summary), pending_ids: owned.filter(pending).map((task) => task.id) });
    }
    const task = args.id ? tasks.get(args.id) : undefined;
    if (!task || task.sessionId !== context.sessionId)
      return result({ error: "Unknown command task for this registry/session." }, true);
    if (args.action === "stop") {
      if (pending(task)) task.controller.abort();
      await task.done; // Cancellation always joins; never replays the command.
    } else if (args.action === "wait") {
      await wait(task, args.timeout_ms, context.signal);
    }
    return page(task, args.offset, args.limit);
  }
  async function start(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    if (context.signal.aborted) throw cancelled();
    if (tasks.size >= 32) return result({ error: "Command task total limit (32) reached." }, true);
    if ([...tasks.values()].filter(pending).length >= 4)
      return result({ error: "Command task active limit (4) reached." }, true);
    const controller = new AbortController();
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const task: Task = {
      id: randomUUID(), sessionId: context.sessionId, controller,
      startedAt: new Date().toISOString(), title: commandTitle(call),
      started: false, delivered: false, metadata: {}, status: "starting", outputTruncated: false,
      done: Promise.resolve({ result: result({}) }),
    };
    // Reserve both limits before approval starts, including concurrent requests.
    tasks.set(task.id, task);
    const abort = () => controller.abort();
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    // Strip rather than set undefined: ToolContext uses exact optional types.
    const { onCommandOutput: _outputHook, ...backgroundContext } = context;
    const commandContext: ToolContext = {
      ...backgroundContext,
      signal: controller.signal,
      onCommandStarted: () => {
        task.started = true;
        task.startedAt = new Date().toISOString();
        task.status = "running";
        signalStarted();
        context.onCommandStarted?.();
      },
      // No raw chunks forwarded. Local owns private logs, redacts before paging,
      // and returns a bounded preview plus its run-scoped output_id.
    };
    task.done = Promise.resolve().then(() => base.execute(call, commandContext)).then(
      (completed): Outcome => {
        const content = safeContent(completed.content);
        try {
          const metadata = completionMetadata.safeParse(JSON.parse(content));
          if (metadata.success) task.metadata = metadata.data;
        } catch { /* Non-JSON base failures have no safe completion metadata. */ }
        const meta = task.metadata;
        const failed = completed.isError || meta.timed_out || meta.spawn_failed ||
          (meta.truncated && meta.preview_truncated === undefined) ||
          (meta.exit_code !== undefined && meta.exit_code !== 0) || meta.signal != null;
        task.status = controller.signal.aborted ? "cancelled" : failed ? "failed" : "completed";
        task.resultIsError = task.status !== "completed";
        task.outputTruncated = meta.truncated === true || Buffer.byteLength(content, "utf8") > RESULT_LIMIT;
        task.output = Buffer.byteLength(content, "utf8") > RESULT_LIMIT ? "[Output withheld after overflow]" : content;
        // Keep original results only for pre-start failures, which are returned as-is.
        return { result: task.started ? result({}) : completed };
      },
      (error: unknown): Outcome => {
        task.status = controller.signal.aborted ? "cancelled" : "failed";
        task.resultIsError = true;
        // Rejected executions do not have a complete, base-redacted output.
        task.output = JSON.stringify({ error: task.status === "cancelled" ? "Command task cancelled." : "Command task execution failed." });
        return task.started ? { result: result({}) } : { error };
      },
    ).finally(() => {
      context.signal.removeEventListener("abort", abort);
      if (!task.started) tasks.delete(task.id);
    });
    // A refusal, validation failure, or failed spawn wins without a fabricated id.
    await Promise.race([started, task.done]);
    if (!task.started) {
      const outcome = await task.done;
      if ("error" in outcome) throw outcome.error;
      return outcome.result;
    }
    return result({ ...summary(task), background: true });
  }

  function view(task: Task): TaskView {
    const active = pending(task);
    return {
      id: task.id, kind: "command", sessionId: task.sessionId, title: task.title,
      status: task.status, active, controllable: active && !disposal,
      historical: !!disposal, startedAt: task.startedAt,
      ...(task.metadata.exit_code === undefined ? {} : { exitCode: task.metadata.exit_code }),
    };
  }
  function owned(sessionId: ToolContext["sessionId"], id: string): Task | undefined {
    const task = tasks.get(id);
    return task?.started && task.sessionId === sessionId ? task : undefined;
  }
  const commandTasks: CommandTaskAccess = {
    list(sessionId) {
      return [...tasks.values()].filter((task) => task.started && task.sessionId === sessionId).map(view);
    },
    read(sessionId, id, offset, limit) {
      const task = owned(sessionId, id);
      if (!task) return undefined;
      const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
      const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 12000) : 12000;
      // UI observation never consumes model delivery and never exposes running chunks.
      const output = pending(task) ? "" : task.output ?? "";
      const end = Math.min(output.length, start + size);
      return {
        task: view(task), content: output.slice(start, end), offset: start,
        nextOffset: end < output.length ? end : null, truncated: end < output.length,
        ...(pending(task) ? { note: "Command is running; output is available only after completion." }
          : task.outputTruncated ? { note: "Command output was truncated or withheld." } : {}),
      };
    },
    async stop(sessionId, id) {
      const task = owned(sessionId, id);
      if (!task || disposal || !pending(task)) return false;
      task.controller.abort();
      await task.done;
      return true;
    },
  };

  return {
    definitions,
    commandTasks,
    async execute(call, context) {
      if (disposal) return result({ error: "Tool registry is disposed." }, true);
      if (call.function.name === "command_task") return manage(call, context);
      if (call.function.name !== "run_command") return base.execute(call, context);
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { return base.execute(call, context); }
      if (!args || typeof args !== "object" || Array.isArray(args) || !("background" in args))
        return base.execute(call, context);
      const { background, ...foreground } = args;
      if (typeof background !== "boolean") return invalidToolInput("background must be a boolean.");
      const command = { ...call, function: { ...call.function, arguments: JSON.stringify(foreground) } };
      // Do not change foreground permissions, contexts, results, or cancellation.
      if (!background || context.permission === "readonly") return base.execute(command, context);
      return start(command, context);
    },
    async settleBackground(sessionId, signal) {
      const owned = [...tasks.values()].filter((task) => task.sessionId === sessionId && !task.delivered);
      const abort = () => {
        for (const task of owned) if (pending(task)) task.controller.abort();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        await Promise.all(owned.map((task) => task.done));
        // A concurrent terminal read/settle may already have delivered a task.
        const undelivered = owned.filter((task) => task.started && !task.delivered);
        if (!undelivered.length) return undefined;
        for (const task of undelivered) task.delivered = true;
        return result({
          tasks: undelivered.map((task) => ({ id: task.id, status: task.status, ...task.metadata })),
        }, undelivered.some((task) => task.resultIsError));
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    async dispose() {
      disposal ??= (async () => {
        for (const task of tasks.values()) if (pending(task)) task.controller.abort();
        const outcomes = await Promise.allSettled([
          ...[...tasks.values()].map((task) => task.done),
          Promise.resolve().then(() => base.dispose()),
        ]);
        const errors = outcomes.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason);
        if (errors.length) throw new AggregateError(errors, "Command task registry disposal failed.");
      })();
      await disposal;
    },
  };
}
