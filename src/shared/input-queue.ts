import { z } from "zod";
import { ForgeError } from "./errors";
import { permissionSchema, runInputSchema, sessionIdSchema } from "./schemas";
import type { RunInput, SessionId, SessionStatus } from "./schemas";

export const enqueueInputSchema = z
  .object({ inputId: z.string().uuid(), input: runInputSchema })
  .strict();
export const queuedInputSchema = z
  .object({
    inputId: z.string().uuid(),
    sessionId: sessionIdSchema,
    sequence: z.number().int().positive().safe(),
    state: z.enum([
      "queued",
      "bound",
      "consumed",
      "cancelled",
      "uncertain",
      "blocked",
    ]),
    acceptedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    runId: z.string().uuid().nullable(),
    input: runInputSchema.nullable(),
    selection: z
      .object({
        model: z.string().min(1),
        providerSourceId: z.string().optional(),
        routeGroupId: z.string().optional(),
        mode: z.enum(["build", "plan"]),
        permission: permissionSchema,
      })
      .strict(),
    outcome: z
      .enum(["completed", "failed", "cancelled", "interrupted"])
      .optional(),
    reason: z.string().max(1024).optional(),
  })
  .strict()
  .readonly();
export type QueuedInput = z.infer<typeof queuedInputSchema>;
export const inputQueueSnapshotSchema = z
  .object({
    sessionId: sessionIdSchema,
    paused: z.boolean(),
    reason: z.string().max(1024).optional(),
    items: z.array(queuedInputSchema).max(4096).readonly(),
  })
  .strict()
  .readonly();
export type InputQueueSnapshot = z.infer<typeof inputQueueSnapshotSchema>;
export interface InputQueueService {
  enqueue(request: z.infer<typeof enqueueInputSchema>): Promise<QueuedInput>;
  list(sessionId: SessionId): Promise<InputQueueSnapshot>;
  cancel(sessionId: SessionId, inputId: string): Promise<boolean>;
  pause(sessionId: SessionId): Promise<InputQueueSnapshot>;
  resume(sessionId: SessionId): Promise<InputQueueSnapshot>;
}
export interface InputQueueRunner {
  isBusy(sessionId: SessionId): boolean;
  start(
    input: RunInput,
    runId: string,
    providerBinding: string,
    acknowledgedPredecessor?: string,
  ): Promise<SessionStatus>;
}
/** Trusted host lifecycle, never a public RPC accepting callbacks or bindings. */
export interface InputQueueHost extends InputQueueService {
  attach(runner: InputQueueRunner): Promise<void>;
  finished(sessionId: SessionId, status: SessionStatus): Promise<void>;
  stop(): void;
  dispose(): Promise<void>;
}

/** Internal signal: admission failed before constructing a provider or tools. */
export class QueueAdmissionError extends ForgeError {
  constructor() {
    super(
      "busy",
      "The predecessor is active or needs review. Explicit queue resume is required; no queued effects started.",
      true,
    );
  }
}
