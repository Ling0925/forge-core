import { z } from "zod";

export const advisorInputSchema = z.object({
  question: z.string().trim().min(1).max(2048),
  context: z.string().trim().max(4096).optional(),
  options: z.array(z.string().trim().min(1).max(256)).max(8).optional(),
  recommendation: z.string().trim().max(1024).optional(),
  timeout_ms: z.number().int().min(1000).max(1800000).default(600000),
}).strict().readonly();
export type AdvisorInput = z.infer<typeof advisorInputSchema>;
export const advisorAnswerInputSchema = z.object({
  requestId: z.string().uuid(),
  answer: z.string().trim().min(1).max(8192),
  nextInstruction: z.string().trim().min(1).max(4096).optional(),
}).strict().readonly();
export type AdvisorAnswerInput = z.infer<typeof advisorAnswerInputSchema>;
export const advisorRequestSchema = z.object({
  id: z.string().uuid(),
  parentSessionId: z.string().uuid(),
  parentRunId: z.string().uuid(),
  childSessionId: z.string().uuid(),
  toolCallId: z.string().min(1).max(256),
  question: z.string().min(1).max(2048),
  context: z.string().max(4096).optional(),
  options: z.array(z.string().max(256)).max(8).optional(),
  recommendation: z.string().max(1024).optional(),
  status: z.enum(["pending", "answered", "cancelled", "expired", "interrupted"]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  deadlineAt: z.string().datetime({ offset: true }),
  answer: z.string().min(1).max(8192).optional(),
  nextInstruction: z.string().min(1).max(4096).optional(),
  deliveredAt: z.string().datetime({ offset: true }).optional(),
}).strict().refine(record => record.status === "answered" ? record.answer !== undefined
  : record.answer === undefined && record.nextInstruction === undefined && record.deliveredAt === undefined,
"Only answered requests carry an answer or delivery receipt.").readonly();
export type AdvisorRequest = z.infer<typeof advisorRequestSchema>;

/** Trusted, run-scoped child port. Identity is captured by the host, never supplied by the model. */
export interface AdvisorParentPort {
  ask(input: AdvisorInput, toolCallId: string, signal: AbortSignal): Promise<AdvisorRequest>;
  delivered(requestId: string): Promise<void>;
}
/** Host coordinator; durable records are committed by the parent's single journal writer. */
export interface AdvisorCoordinator {
  forChild(childSessionId: string): AdvisorParentPort;
  answer(input: AdvisorAnswerInput): Promise<AdvisorRequest>;
  pending(): readonly AdvisorRequest[];
  /** Interrupt a child-result wait on a pending question; remove listeners when work wins. */
  wait(work: Promise<unknown>, signal: AbortSignal): Promise<void>;
  cancelChild(childSessionId: string): Promise<void>;
  close(status: "cancelled" | "interrupted"): Promise<void>;
}
