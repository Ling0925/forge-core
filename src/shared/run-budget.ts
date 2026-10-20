import { z } from "zod";
import type { Usage } from "./schemas";

export const DEFAULT_ROOT_TIMEOUT_MS = 30 * 60 * 1000;
export const rootToolLimitSchema = z.number().int().min(1).max(1_000_000);
export const rootTimeoutSchema = z
  .number()
  .int()
  .min(1000)
  .max(24 * 60 * 60 * 1000);
const count = z.number().int().nonnegative();
// These are observations after requests, not a token/currency admission limit.
const observedUsageSchema = z
  .object({
    basis: z.literal("reported"),
    reportedRequests: count,
    missingRequests: count,
    promptTokens: count,
    completionTokens: count,
    totalTokens: count,
    cachedPromptTokens: count,
    complete: z.boolean(),
  })
  .strict();
export const rootBudgetSnapshotSchema = z
  .object({
    rootRunId: z.string().uuid(),
    rootSessionId: z.string().uuid(),
    maxToolCalls: rootToolLimitSchema,
    timeoutMs: rootTimeoutSchema,
    startedAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    consumed: count,
    reserved: count,
    remaining: count,
    stopReason: z.enum(["tools", "deadline"]).nullable(),
    usage: observedUsageSchema,
    sessions: z
      .array(
        z
          .object({
            sessionId: z.string().uuid(),
            consumed: count,
            reserved: count,
            status: z.enum(["running", "completed", "failed", "cancelled"]),
            reason: z.string().max(64).nullable(),
            usage: observedUsageSchema,
          })
          .strict(),
      )
      .max(33),
  })
  .strict()
  .readonly();
export type RootBudgetSnapshot = z.infer<typeof rootBudgetSnapshotSchema>;
export interface ToolReservation {
  /** Commit one scheduled attempt. Failure/denial never refunds a dispatch. */
  dispatch(count?: number): void;
  /** Only still-undispatched slots are returned; idempotent. */
  release(): void;
}
export interface RootRunBudget {
  readonly signal: AbortSignal;
  readonly maxToolCalls: number;
  readonly timeoutMs: number;
  readonly remaining: number;
  readonly remainingTimeMs: number;
  readonly stopReason: "tools" | "deadline" | null;
  enter(sessionId: string): void;
  check(): void;
  checkAdmission(): void;
  reserve(sessionId: string, count: number): ToolReservation;
  /** A pending observation is incomplete until settled; late results never rewrite a closed run. */
  beginUsage(sessionId: string): (usage: Usage | undefined) => void;
  observeUsage(sessionId: string, usage: Usage | undefined): void;
  finishSession(
    sessionId: string,
    status: "completed" | "failed" | "cancelled",
    reason: string,
  ): void;
  snapshot(): RootBudgetSnapshot;
  /** Owner closes only after all owned work has settled. A closed ledger cannot resume. */
  close(): void;
}
