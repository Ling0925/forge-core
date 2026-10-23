import { z } from "zod";
import type {
  Permission,
  RunInput,
  SessionId,
  ToolResult,
  Usage,
} from "./schemas";

export const asyncTaskArguments = z
  .object({
    action: z.enum(["list", "read", "wait", "stop", "wake"]),
    id: z.string().uuid().optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(12000).default(6000),
    timeout_ms: z.number().int().min(0).max(120000).default(30000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action !== "list" && !value.id)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "Task id is required.",
      });
  });
export type AsyncTaskArguments = z.infer<typeof asyncTaskArguments>;
export type AsyncTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface AsyncTaskView {
  readonly id: string;
  readonly tool: string;
  readonly sessionId: SessionId;
  readonly wakeSessionId: SessionId;
  readonly status: AsyncTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly notification: "pending" | "queued" | "failed" | "suppressed";
  readonly persisted: boolean;
  readonly usage: Usage;
  readonly usageComplete: boolean;
}
/** Trusted, already-authorized work only. Never expose arbitrary tool execution
 * or session targeting through model arguments. Work must honor cancellation and
 * recheck live permission immediately before committing effects. */
export interface AsyncTaskStart {
  readonly tool: string;
  readonly sessionId: SessionId;
  readonly wakeSessionId: SessionId;
  /** Pinned main-session selection; no prompt, credentials or callback in storage. */
  readonly resume: Pick<
    RunInput,
    "model" | "providerSourceId" | "routeGroupId" | "permission"
  >;
  readonly signal: AbortSignal;
  readonly execute: (
    signal: AbortSignal,
    onUsage: (usage: Usage | undefined) => void,
  ) => Promise<ToolResult>;
  readonly redact?: (text: string) => string;
}
export interface AsyncTaskService {
  start(input: AsyncTaskStart): Promise<AsyncTaskView>;
  manage(
    input: AsyncTaskArguments,
    context: {
      sessionId: SessionId;
      permission: Permission;
      signal: AbortSignal;
    },
  ): Promise<ToolResult>;
  /** Stop owned work and work delegated to this main session, joining real completion. */
  cancelSession(sessionId: SessionId): Promise<boolean>;
  dispose(): Promise<void>;
}
