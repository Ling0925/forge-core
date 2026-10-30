import type { HarnessAdaptationReport } from "../shared/harness-adaptation";
import type { Permission, SessionSnapshot, Usage } from "../shared/schemas";
import { CONTEXT_SCALE_FLOOR } from "./runtime-context";

/** Which subsystem a failure is attributed to when it is not a ForgeError. */
export type RunPhase = "storage" | "provider" | "tool";

/**
 * Mutable state of one agent run. Every runtime helper shares this single
 * object, so a write by one is observed by all others, exactly like the
 * closure locals it replaces.
 */
export interface RunState {
  snapshot: SessionSnapshot | undefined;
  canDelegate: boolean;
  /** Pinned once for background notifications; see effectivePermission. */
  notificationCap: Permission | undefined;
  hookFailed: boolean;
  ranEndHooks: boolean;
  turns: number;
  turn: number | undefined;
  activeStep: number | undefined;
  steps: number;
  retries: number;
  toolCalls: number;
  stopReason: string;
  usage: Usage;
  reportedUsageTurns: number;
  auxiliaryUsageComplete: boolean;
  adaptation: HarnessAdaptationReport | undefined;
  hadProviderRetries: boolean;
  phase: RunPhase;
  incompleteText: string;
  generation:
    | { id: string; step: number | undefined; finished: boolean }
    | undefined;
  /** Learned estimate->real-input scale for this run; see CONTEXT_SCALE_FLOOR. */
  contextScale: number;
  acceptingTitle: boolean;
}

/** A run whose session snapshot has been loaded (true once run() reads it). */
export type LoadedRunState = RunState & { snapshot: SessionSnapshot };

export const createRunState = (): RunState => ({
  snapshot: undefined,
  canDelegate: false,
  notificationCap: undefined,
  hookFailed: false,
  ranEndHooks: false,
  turns: 0,
  turn: undefined,
  activeStep: undefined,
  steps: 0,
  retries: 0,
  toolCalls: 0,
  stopReason: "completed",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  reportedUsageTurns: 0,
  auxiliaryUsageComplete: true,
  adaptation: undefined,
  hadProviderRetries: false,
  phase: "storage",
  incompleteText: "",
  generation: undefined,
  contextScale: CONTEXT_SCALE_FLOOR,
  acceptingTitle: true,
});
