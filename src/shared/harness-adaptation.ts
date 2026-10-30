import { z } from "zod";
import type { LocalToolRegistry } from "./contracts";

/** Omitted from RunInput by default. These limits apply only to the preflight. */
export const harnessAdaptationOptionsSchema = z
  .object({
    candidates: z.number().int().min(1).max(3).optional(),
    maxProbeTurns: z.number().int().min(1).max(6).optional(),
    maxProbeToolCalls: z.number().int().min(1).max(16).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    domain: z.string().trim().min(1).max(80).optional(),
    experience: z.enum(["off", "read", "read-write"]).optional(),
  })
  .strict()
  .readonly();
export type HarnessAdaptationOptions = z.infer<
  typeof harnessAdaptationOptionsSchema
>;
export const HARNESS_ADAPTATION_DEFAULTS = Object.freeze({
  candidates: 2,
  maxProbeTurns: 3,
  maxProbeToolCalls: 6,
  timeoutMs: 60000,
  domain: "general",
  experience: "read" as const,
});

/** Advisory text only: no permissions, code, tool definitions, plugins or hooks. */
export const harnessStrategySchema = z
  .object({
    planning: z.string().trim().max(2048),
    toolGuidance: z.string().trim().max(2048),
    verification: z.string().trim().max(2048),
  })
  .strict()
  .readonly();
export type HarnessStrategy = z.infer<typeof harnessStrategySchema>;
export const BASELINE_HARNESS_STRATEGY: HarnessStrategy = Object.freeze({
  planning: "",
  toolGuidance: "",
  verification: "",
});
export const harnessProbeEvidenceSchema = z
  .object({
    id: z.string().min(1).max(80),
    tool: z.string().min(1).max(128),
    arguments: z.string().max(2048),
    observation: z.string().max(2048),
    isError: z.boolean(),
    truncated: z.boolean(),
  })
  .strict()
  .readonly();
export const harnessProbeSchema = z
  .object({
    id: z.string().min(1).max(80),
    strategy: harnessStrategySchema,
    status: z.enum(["completed", "limited"]),
    answer: z.string().max(4096),
    answerTruncated: z.boolean(),
    evidence: z.array(harnessProbeEvidenceSchema).max(16).readonly(),
    turns: z.number().int().nonnegative().max(6),
    toolCalls: z.number().int().nonnegative().max(16),
  })
  .strict()
  .readonly();
export type HarnessProbe = z.infer<typeof harnessProbeSchema>;
export const harnessAdaptationReportSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["adopted", "baseline"]),
    strategy: harnessStrategySchema,
    rationale: z.string().min(1).max(2048),
    evidenceIds: z.array(z.string().min(1).max(80)).max(16).readonly(),
    probes: z.array(harnessProbeSchema).min(1).max(5).readonly(),
    experiencesUsed: z.array(z.string().uuid()).max(4).readonly(),
    modelRequests: z.number().int().nonnegative().max(33),
    toolCalls: z.number().int().nonnegative().max(80),
  })
  .strict()
  .readonly();
export type HarnessAdaptationReport = z.infer<
  typeof harnessAdaptationReportSchema
>;
export const harnessAdaptationProgressSchema = z
  .object({
    phase: z.enum([
      "baseline",
      "propose",
      "probe",
      "compose",
      "verify",
      "select",
      "completed",
      "experience",
    ]),
    probeId: z.string().min(1).max(80).optional(),
    report: harnessAdaptationReportSchema.optional(),
    experienceId: z.string().uuid().optional(),
  })
  .strict()
  .readonly();
export type HarnessAdaptationProgress = z.infer<
  typeof harnessAdaptationProgressSchema
>;

export const harnessExperienceScopeSchema = z
  .object({
    workspace: z.string().min(1).max(4096),
    model: z.string().min(1).max(256),
    domain: z.string().trim().min(1).max(80),
  })
  .strict()
  .readonly();
export type HarnessExperienceScope = z.infer<
  typeof harnessExperienceScopeSchema
>;
const experienceFields = {
  scope: harnessExperienceScopeSchema,
  sessionId: z.string().uuid(),
  reportId: z.string().uuid(),
  strategy: harnessStrategySchema,
  lesson: z.string().min(1).max(2048),
  evidence: z.array(z.string().max(2048)).min(1).max(4).readonly(),
};
export const harnessExperienceInputSchema = z
  .object(experienceFields)
  .strict()
  .readonly();
export type HarnessExperienceInput = z.infer<
  typeof harnessExperienceInputSchema
>;
export const harnessExperienceSchema = z
  .object({
    ...experienceFields,
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type HarnessExperience = z.infer<typeof harnessExperienceSchema>;
export interface HarnessExperienceStore {
  /** At most four recent entries from the exact scope; always untrusted data. */
  list(scope: HarnessExperienceScope): Promise<readonly HarnessExperience[]>;
  /** Called only after explicit opt-in and successful, non-readonly execution. */
  save(input: HarnessExperienceInput): Promise<HarnessExperience>;
}
export interface HarnessAdaptationHost {
  /** Fresh registry for each probe, never the formal run's read/write authority. */
  createProbeTools(): Promise<LocalToolRegistry>;
  readonly experiences?: HarnessExperienceStore;
  /** Host-owned secret redaction before feedback, persistence and projection. */
  readonly redact?: (text: string) => string;
}
