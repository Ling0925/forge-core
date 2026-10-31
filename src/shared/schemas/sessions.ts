import { z } from "zod";
import { advisorRequestSchema } from "../agent-coordination";
import { agentProfileIdSchema, agentProfileSchema } from "../agent-profiles";
import {
  harnessAdaptationOptionsSchema,
  harnessAdaptationProgressSchema,
} from "../harness-adaptation";
import { imageAttachmentsSchema } from "../images";
import { providerAttemptSchema } from "../model-access";
import { rootBudgetSnapshotSchema } from "../run-budget";
import { toolHookDiagnosticSchema } from "../tool-hooks";
import {
  webCitationSchema,
  webSearchProgressSchema,
  webSearchRecordSchema,
} from "../web-search";
import { permissionSchema, sessionIdSchema, timestampSchema } from "./base";
import {
  approvalRequestSchema,
  fileChangeSchema,
  toolResultSchema,
} from "./changes";
import {
  messageSchema,
  toolCallPreviewSchema,
  toolCallSchema,
  usageSchema,
} from "./messages";
import { providerSourceIdSchema, settingsFields } from "./settings";

export const sessionStatusSchema = z.enum([
  "idle",
  "running",
  "awaiting_approval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export const errorInfoSchema = z
  .object({
    code: z.enum([
      "invalid_input",
      "not_found",
      "busy",
      "provider",
      "tool",
      "storage",
      "cancelled",
      "budget",
      "internal",
    ]),
    message: z.string().max(4096),
    retryable: z.boolean(),
  })
  .strict()
  .readonly();
export type ErrorInfo = z.infer<typeof errorInfoSchema>;
export const taskPlanSchema = z
  .object({
    // Optional only for snapshots/events written before independent plans.
    id: z.string().trim().min(1).max(128).optional(),
    title: z.string().trim().min(1).max(256).optional(),
    explanation: z.string().trim().min(1).max(4096),
    steps: z
      .array(
        z
          .object({
            step: z.string().trim().min(1).max(1024),
            status: z.enum(["pending", "in_progress", "completed"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (p) => p.steps.filter((s) => s.status === "in_progress").length <= 1,
    "At most one step may be in progress",
  );
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export const contextSummarySchema = z
  .object({
    content: z.string().max(8192),
    boundary: z.number().int().nonnegative(),
    fallback: z.boolean(),
  })
  .strict();
export const contextUsageSchema = z
  .object({
    windowTokens: z.number().int().positive().nullable(),
    budgetTokens: z.number().int().positive().optional(),
    budgetChars: z.number().int().positive().optional(),
    usedTokens: z.number().int().nonnegative(),
    estimated: z.boolean(),
    basis: z.enum(["projected", "request", "request-with-output"]),
    // Provider input count for this request, never the accumulated billing total.
    promptTokens: z.number().int().nonnegative().optional(),
    cachedPromptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    parts: z
      .object({
        instructions: z.number().int().nonnegative(),
        memory: z.number().int().nonnegative(),
        conversation: z.number().int().nonnegative(),
        tools: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .readonly();
export type ContextUsage = z.infer<typeof contextUsageSchema>;
// Read existing sessions without reinterpreting their old character counts as tokens.
const persistedContextUsageSchema = z.union([
  contextUsageSchema,
  z
    .object({
      budgetChars: z.number().int().positive(),
      usedChars: z.number().int().nonnegative(),
      parts: z
        .object({
          instructions: z.number().int().nonnegative(),
          memory: z.number().int().nonnegative(),
          conversation: z.number().int().nonnegative(),
          tools: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict()
    .transform(
      (): ContextUsage => ({
        windowTokens: null,
        usedTokens: 0,
        estimated: true,
        basis: "projected",
        parts: { instructions: 0, memory: 0, conversation: 0, tools: 0 },
      }),
    ),
]);
const eventBase = {
  sessionId: sessionIdSchema,
  timestamp: timestampSchema,
  turn: z.number().int().positive().optional(),
  step: z.number().int().positive().optional(),
  generationId: z.string().uuid().optional(),
};
export const agentEventSchema = z
  .discriminatedUnion("type", [
    // Only identity/lifecycle is durable; live reasoning still stays ephemeral.
    z
      .object({
        ...eventBase,
        type: z.literal("generation_started"),
        generationId: z.string().uuid(),
        messageIndex: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("generation_finished"),
        generationId: z.string().uuid(),
        status: z.enum(["completed", "failed", "cancelled", "superseded"]),
      })
      .strict(),
    // Provider-owned search progress, not an executable local function call.
    z
      .object({
        ...eventBase,
        type: z.literal("web_search"),
        search: webSearchProgressSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("web_search_result"),
        citations: z.array(webCitationSchema).max(256).readonly(),
        webSearches: z.array(webSearchRecordSchema).max(128).readonly(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("permission_changed"),
        permission: permissionSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("harness_adaptation"),
        progress: harnessAdaptationProgressSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("context_usage"),
        usage: persistedContextUsageSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("plan_updated"),
        plan: taskPlanSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("agent_update"),
        childSessionId: sessionIdSchema,
        status: sessionStatusSchema,
        model: settingsFields.model,
        summary: z.string().max(4096),
        currentTool: z
          .object({ name: z.string().max(256), target: z.string().max(1024) })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("advisor_update"),
        request: advisorRequestSchema,
      })
      .strict(),
    // Ephemeral cumulative child reply: never a parent message or stored event.
    z
      .object({
        ...eventBase,
        type: z.literal("agent_progress"),
        childSessionId: sessionIdSchema,
        text: z.string().max(65536),
        truncated: z.boolean(),
        childTurn: z.number().int().positive().optional(),
        childStep: z.number().int().positive().optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("text_delta"),
        text: z.string().max(131072),
      })
      .strict(),
    // Display-only reasoning preview. Ephemeral: emitted for live UI and never
    // persisted to the session transcript as assistant content.
    z
      .object({
        ...eventBase,
        type: z.literal("reasoning_delta"),
        text: z.string().max(131072),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("provider_attempt"),
        selection: providerAttemptSchema,
      })
      .strict(),
    // Bounded user-visible retry status. Carries no upstream body, prompt or
    // endpoint. Persisted so request retries remain inspectable after resume.
    z
      .object({
        ...eventBase,
        type: z.literal("provider_retry"),
        attempt: z.number().int().min(1).max(5),
        maxAttempts: z.literal(5),
        reason: z.enum(["protocol", "network", "timeout", "http", "upstream"]),
      })
      .strict(),
    // Clear the live partial text/reasoning of the failed attempt before the
    // replacement stream so the UI never shows duplicated or stale drafts.
    z
      .object({
        ...eventBase,
        type: z.literal("retry_reset"),
      })
      .strict(),
    // Ephemeral metadata only: neither executable arguments nor transcript evidence.
    z
      .object({
        ...eventBase,
        type: z.literal("tool_call_preview"),
        previewId: z.string().min(1).max(128),
        name: toolCallPreviewSchema.unwrap().shape.name,
        argumentsChars: toolCallPreviewSchema.unwrap().shape.argumentsChars,
        // Optional so older persisted/queued previews still parse unchanged.
        linesAdded: toolCallPreviewSchema.unwrap().shape.linesAdded,
        linesRemoved: toolCallPreviewSchema.unwrap().shape.linesRemoved,
      })
      .strict(),
    z.object({ ...eventBase, type: z.literal("tool_preview_reset") }).strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("tool_started"),
        callIndex: z.number().int().min(0).max(255).optional(),
        call: toolCallSchema,
        previewId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("tool_finished"),
        callIndex: z.number().int().min(0).max(255).optional(),
        toolCallId: toolCallSchema.unwrap().shape.id,
        result: toolResultSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("tool_hook"),
        diagnostic: toolHookDiagnosticSchema,
        toolCallId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("approval_requested"),
        request: approvalRequestSchema,
      })
      .strict(),
    // Any attached client may answer an approval, so the authoritative
    // settlement is broadcast: every other surface drops the same card instead
    // of waiting for a snapshot refresh. The payload is deliberately minimal
    // (identifier plus decision) and never carries the request body, command,
    // tool arguments or any credential. Older stored sessions stay readable
    // because this is one additional union branch, not a shape change.
    z
      .object({
        ...eventBase,
        type: z.literal("approval_resolved"),
        approvalId: z.string().uuid(),
        approved: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("state_changed"),
        status: sessionStatusSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("run_started"),
        budget: rootBudgetSnapshotSchema.optional(),
        messageIndex: z.number().int().nonnegative().optional(),
        model: settingsFields.model,
        permission: permissionSchema,
        title: z.string().min(1).max(256).optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("title_changed"),
        title: z.string().min(1).max(60),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("run_finished"),
        budget: rootBudgetSnapshotSchema.optional(),
        status: z.enum(["completed", "cancelled", "failed", "interrupted"]),
        turns: z.number().int().nonnegative(),
        steps: z.number().int().nonnegative().optional(),
        retries: z.number().int().nonnegative().optional(),
        messageIndex: z.number().int().nonnegative().optional(),
        toolCalls: z.number().int().nonnegative(),
        usage: usageSchema.optional(),
        usageComplete: z.boolean().optional(),
        // Own usage stays backward compatible; aggregate is provider-reported
        // usage across this run and its children, not a billing estimate.
        childUsage: usageSchema.optional(),
        totalUsage: usageSchema.optional(),
        childUsageComplete: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("step_started"),
        turn: z.number().int().positive(),
        step: z.number().int().positive(),
        messageIndex: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("step_finished"),
        turn: z.number().int().positive(),
        step: z.number().int().positive(),
        messageIndex: z.number().int().nonnegative(),
        status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("error"),
        error: errorInfoSchema,
      })
      .strict(),
    z
      .object({
        ...eventBase,
        type: z.literal("context_compacted"),
        removedMessages: z.number().int().nonnegative(),
        beforeChars: z.number().int().nonnegative(),
        afterChars: z.number().int().nonnegative(),
      })
      .strict(),
  ])
  .refine(
    (event) =>
      (event.type !== "tool_started" && event.type !== "tool_finished") ||
      (event.generationId === undefined) === (event.callIndex === undefined),
    "Tool generation identity and call index must be supplied together",
  )
  .readonly();
export type AgentEvent = z.infer<typeof agentEventSchema>;
export const sessionTitleSchema = z.string().trim().min(1).max(256);
const summaryFields = {
  version: z.literal(1),
  id: sessionIdSchema,
  title: sessionTitleSchema,
  workspace: z.string().min(1).max(4096),
  model: settingsFields.model,
  createdAt: timestampSchema,
  providerSourceId: providerSourceIdSchema.optional(),
  routeGroupId: z.string().min(1).optional(),
  updatedAt: timestampSchema,
  status: sessionStatusSchema,
  parentSessionId: sessionIdSchema.optional(),
  agentProfileId: agentProfileIdSchema.optional(),
  agentProfileName: z.string().min(1).max(80).optional(),
  archived: z.boolean().optional(),
};
export const sessionSummarySchema = z.object(summaryFields).strict().readonly();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const sessionSnapshotSchema = z
  .object({
    ...summaryFields,
    messages: z.array(messageSchema).max(100000).readonly(),
    // Durable user input waiting for the active native tool exchange to close.
    pendingSteering: z
      .array(
        messageSchema.refine(
          (message) => message.role === "user" && !message.origin,
        ),
      )
      .max(1000)
      .readonly()
      .optional(),
    events: z.array(agentEventSchema).max(1000000).readonly(),
    changes: z.array(fileChangeSchema).max(100000).readonly(),
    titleSource: z.enum(["default", "user", "auto"]).optional(),
    autoTitleAttempted: z.boolean().optional(),
    pendingTool: toolCallSchema.optional(),
    // Current-plan projection for existing clients; plans retains independent history.
    plan: taskPlanSchema.optional(),
    plans: z.array(taskPlanSchema).max(10000).readonly().optional(),
    parentSessionId: sessionIdSchema.optional(),
    agentTask: z.string().max(16384).optional(),
    // Immutable role snapshot: editing settings never retargets an existing child.
    agentProfile: agentProfileSchema.optional(),
    advisorRequests: z
      .array(advisorRequestSchema)
      .max(10000)
      .readonly()
      .optional(),
    agentWorktree: z
      .object({
        repository: z.string().min(1).max(4096),
        worktree: z.string().min(1).max(4096),
        baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
      })
      .strict()
      .readonly()
      .optional(),
    ownership: z.string().max(4096).optional(),
    writePaths: z
      .array(z.string().min(1).max(512))
      .max(32)
      .readonly()
      .optional(),
    agentResolutions: z
      .array(
        z
          .object({
            id: sessionIdSchema,
            childUpdatedAt: timestampSchema,
            resolution: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .max(10000)
      .readonly()
      .optional(),
    permissionCeiling: permissionSchema.optional(),
    contextSummary: contextSummarySchema.optional(),
    archived: z.boolean().optional(),
    forkedFrom: sessionIdSchema.optional(),
  })
  .strict()
  .readonly();
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export const createSessionInputSchema = z
  .object({
    workspace: summaryFields.workspace,
    title: summaryFields.title.optional(),
    model: settingsFields.model.optional(),
    providerSourceId: providerSourceIdSchema.optional(),
    routeGroupId: z.string().min(1).optional(),
  })
  .strict()
  .readonly();
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
export const textPromptSchema = z.string().trim().min(1).max(1000000);
export const runInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    prompt: z.string().trim().max(1000000),
    images: imageAttachmentsSchema.optional(),
    harness: harnessAdaptationOptionsSchema.optional(),
    mode: z.enum(["build", "plan"]).optional(),
    permission: permissionSchema.optional(),
    model: settingsFields.model.optional(),
    providerSourceId: providerSourceIdSchema.optional(),
    routeGroupId: z.string().min(1).optional(),
    /** Set by the Web host when forwarding a page request; selects Web-only
     * capabilities (chart tool + fence prompt). The CLI never sets it. */
    uiHost: z.literal("web").optional(),
  })
  .strict()
  .refine(
    (input) => Boolean(input.prompt || input.images?.length),
    "请输入消息或添加图片。",
  )
  .readonly();
export type RunInput = z.infer<typeof runInputSchema>;
