import { z } from "zod";
import type { Usage } from "./schemas";

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
    // Null means unlimited for new runs; numeric limits remain readable in history.
    maxToolCalls: rootToolLimitSchema.nullable(),
    timeoutMs: rootTimeoutSchema.nullable(),
    startedAt: z.string().datetime(),
    deadlineAt: z.string().datetime().nullable(),
    consumed: count,
    reserved: count,
    remaining: count.nullable(),
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
      ),
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
  /** Observation ledger only; no cumulative execution budget or deadline. */
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
  /** Child events carry only their own session row; root events retain the whole tree. */
  snapshot(sessionId?: string): RootBudgetSnapshot;
  /** Owner closes only after all owned work has settled. A closed ledger cannot resume. */
  close(): void;
}
