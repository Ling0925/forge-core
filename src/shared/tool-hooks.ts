import { z } from "zod";
import { permissionSchema } from "./schemas";

/**
 * Opt-in, host-configured tool lifecycle hooks.
 *
 * The host passes an explicit configuration object to
 * `createToolHookService` (see `src/core/tool-hooks.ts`). Nothing in this
 * module discovers, imports or auto-loads hooks from a workspace, repository,
 * `AGENTS.md`, skills or session content. No hooks configured means no
 * subprocesses, no events and no behavior change.
 */

export const TOOL_HOOK_NAMES = [
  "beforeTool",
  "afterTool",
  "toolError",
  "runEnd",
] as const;
export type ToolHookName = (typeof TOOL_HOOK_NAMES)[number];

export const TOOL_HOOK_MAX_HOOKS_PER_EVENT = 8;
export const TOOL_HOOK_MAX_ARGS = 64;
export const TOOL_HOOK_MAX_TOOL_FILTERS = 64;
export const TOOL_HOOK_DEFAULT_TIMEOUT_MS = 5000;
export const TOOL_HOOK_MIN_TIMEOUT_MS = 100;
export const TOOL_HOOK_MAX_TIMEOUT_MS = 30000;
export const TOOL_HOOK_DEFAULT_MAX_OUTPUT_BYTES = 8192;
export const TOOL_HOOK_MIN_OUTPUT_BYTES = 256;
export const TOOL_HOOK_MAX_OUTPUT_BYTES = 65536;
/** Bound for the tool-argument JSON text forwarded to a before hook. */
export const TOOL_HOOK_MAX_ARGUMENT_BYTES = 16 * 1024;
/** Bound for the outcome preview forwarded to after/error hooks. */
export const TOOL_HOOK_MAX_CONTENT_PREVIEW_BYTES = 4 * 1024;
export const TOOL_HOOK_MAX_REASON_CHARS = 500;

const noBreaks = (value: string) => !/[\r\n\0]/.test(value);

const hookIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Hook ids must be lowercase kebab-case.");
const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Tool names are bounded identifiers.");

const configuredHookFields = {
  /** Stable, host-authored diagnostic label. */
  id: hookIdSchema,
  /** Executable path. Never passed through a shell. */
  command: z.string().min(1).max(4096).refine(noBreaks),
  /** argv elements. Never concatenated or shell-interpreted. */
  args: z
    .array(z.string().max(8192).refine(noBreaks))
    .max(TOOL_HOOK_MAX_ARGS)
    .readonly()
    .default([]),
  /** Optional exact tool-name filter for before/after/toolError hooks. */
  tools: z
    .array(toolNameSchema)
    .min(1)
    .max(TOOL_HOOK_MAX_TOOL_FILTERS)
    .readonly()
    .optional(),
  timeoutMs: z
    .number()
    .int()
    .min(TOOL_HOOK_MIN_TIMEOUT_MS)
    .max(TOOL_HOOK_MAX_TIMEOUT_MS)
    .default(TOOL_HOOK_DEFAULT_TIMEOUT_MS),
  maxOutputBytes: z
    .number()
    .int()
    .min(TOOL_HOOK_MIN_OUTPUT_BYTES)
    .max(TOOL_HOOK_MAX_OUTPUT_BYTES)
    .default(TOOL_HOOK_DEFAULT_MAX_OUTPUT_BYTES),
} as const;

export const toolHookEntrySchema = z
  .object(configuredHookFields)
  .strict()
  .readonly();
export type ToolHookEntry = z.infer<typeof toolHookEntrySchema>;

const hookListSchema = z
  .array(toolHookEntrySchema)
  .max(TOOL_HOOK_MAX_HOOKS_PER_EVENT)
  .readonly();

export const toolHooksConfigSchema = z
  .object({
    beforeTool: hookListSchema.default([]),
    afterTool: hookListSchema.default([]),
    toolError: hookListSchema.default([]),
    runEnd: hookListSchema.default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const name of TOOL_HOOK_NAMES) {
      for (const entry of value[name]) {
        if (ids.has(entry.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: "Hook ids must be unique across the whole configuration.",
          });
        }
        ids.add(entry.id);
        if (name === "runEnd" && entry.tools !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: "runEnd hooks do not accept a tool-name filter.",
          });
        }
      }
    }
  })
  .readonly();
export type ToolHooksConfig = z.infer<typeof toolHooksConfigSchema>;

/* ------------------------------------------------------------------ events */

export const toolHookSessionSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    workspace: z.string().min(1).max(4096),
    // Lazy so shared/schemas.ts can import toolHookDiagnosticSchema without a
    // module-initialization cycle through permissionSchema.
    permission: z.lazy(() => permissionSchema),
  })
  .strict()
  .readonly();
export type ToolHookSession = z.infer<typeof toolHookSessionSchema>;

export const toolHookToolSchema = z
  .object({
    name: toolNameSchema,
    callId: z.string().min(1).max(128),
    /** Raw tool-argument JSON text. Truncated to a bounded size before send. */
    arguments: z.string().max(131072),
  })
  .strict()
  .readonly();
export type ToolHookTool = z.infer<typeof toolHookToolSchema>;

export const toolHookOutcomeSchema = z
  .object({
    isError: z.boolean(),
    contentBytes: z.number().int().min(0).max(16777216),
    /** Bounded preview. The service truncates again before sending. */
    contentPreview: z.string().max(131072),
    truncated: z.boolean(),
    changeCount: z.number().int().min(0).max(256),
  })
  .strict()
  .readonly();
export type ToolHookOutcome = z.infer<typeof toolHookOutcomeSchema>;

export const toolHookRunSchema = z
  .object({
    status: z.enum(["completed", "failed", "cancelled"]),
    errorCode: z.string().min(1).max(64).optional(),
    toolCalls: z.number().int().min(0).max(1000000).optional(),
    steps: z.number().int().min(0).max(1000000).optional(),
  })
  .strict()
  .readonly();
export type ToolHookRun = z.infer<typeof toolHookRunSchema>;

export const beforeToolHookEventSchema = z
  .object({ session: toolHookSessionSchema, tool: toolHookToolSchema })
  .strict()
  .readonly();
export type BeforeToolHookEvent = z.infer<typeof beforeToolHookEventSchema>;

export const afterToolHookEventSchema = z
  .object({
    session: toolHookSessionSchema,
    tool: toolHookToolSchema,
    outcome: toolHookOutcomeSchema,
  })
  .strict()
  .readonly();
export type AfterToolHookEvent = z.infer<typeof afterToolHookEventSchema>;

export const toolErrorHookEventSchema = z
  .object({
    session: toolHookSessionSchema,
    tool: toolHookToolSchema,
    outcome: toolHookOutcomeSchema,
    /** Safe authored error category, never an exception body. */
    errorCode: z.string().min(1).max(64).optional(),
  })
  .strict()
  .readonly();
export type ToolErrorHookEvent = z.infer<typeof toolErrorHookEventSchema>;

export const runEndHookEventSchema = z
  .object({ session: toolHookSessionSchema, run: toolHookRunSchema })
  .strict()
  .readonly();
export type RunEndHookEvent = z.infer<typeof runEndHookEventSchema>;

/* ------------------------------------------------------------- diagnostics */

export const toolHookStatusSchema = z.enum([
  "ok",
  "denied",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
]);
export type ToolHookStatus = z.infer<typeof toolHookStatusSchema>;

/**
 * Bounded, structured, public diagnostic. Never contains raw child output.
 *
 * Exported as a Zod schema so the host can validate the structured
 * `{ type: "tool_hook", diagnostic }` agent event without importing the core
 * service.
 */
export const toolHookDiagnosticSchema = z
  .object({
    hook: z.enum(TOOL_HOOK_NAMES),
    id: hookIdSchema,
    status: toolHookStatusSchema,
    /** Authored reason label; never an exception message or child stderr. */
    reason: z.string().max(TOOL_HOOK_MAX_REASON_CHARS).optional(),
    exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
    durationMs: z.number().int().min(0).max(2147483647),
    /** Total bytes received from the child, even beyond the retained bound. */
    stdoutBytes: z.number().int().min(0).max(2147483647),
    stderrBytes: z.number().int().min(0).max(2147483647),
    outputTruncated: z.boolean(),
  })
  .strict()
  .readonly();
export type ToolHookDiagnostic = z.infer<typeof toolHookDiagnosticSchema>;

/** A before hook is a gate; observers report diagnostics only. */
export interface BeforeToolHookResult {
  readonly allowed: boolean;
  readonly denialReason?: string;
  readonly diagnostics: readonly ToolHookDiagnostic[];
}

export interface ToolHookRunOptions {
  readonly signal?: AbortSignal;
}

export interface ToolHookService {
  /** True when at least one hook is configured. */
  readonly configured: boolean;
  readonly hookCount: number;
  beforeTool(
    event: BeforeToolHookEvent,
    options?: ToolHookRunOptions,
  ): Promise<BeforeToolHookResult>;
  afterTool(
    event: AfterToolHookEvent,
    options?: ToolHookRunOptions,
  ): Promise<readonly ToolHookDiagnostic[]>;
  toolError(
    event: ToolErrorHookEvent,
    options?: ToolHookRunOptions,
  ): Promise<readonly ToolHookDiagnostic[]>;
  runEnd(
    event: RunEndHookEvent,
    options?: ToolHookRunOptions,
  ): Promise<readonly ToolHookDiagnostic[]>;
  dispose(): Promise<void>;
}

/** UTF-8-safe bound used for every string placed in the child's stdin. */
export function truncateToolHookText(
  text: string,
  limit: number,
): Readonly<{ text: string; truncated: boolean }> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
