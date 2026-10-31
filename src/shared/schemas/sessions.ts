import { z } from "zod";
import { advisorRequestSchema } from "../agent-coordination";
import { agentProfileIdSchema, agentProfileSchema } from "../agent-profiles";
import { harnessAdaptationOptionsSchema } from "../harness-adaptation";
import { imageAttachmentsSchema } from "../images";
import { permissionSchema, sessionIdSchema, timestampSchema } from "./base";
import { fileChangeSchema } from "./changes";
import {
  agentEventSchema,
  sessionStatusSchema,
  taskPlanSchema,
} from "./events";
import { messageSchema, toolCallSchema } from "./messages";
import { providerSourceIdSchema, settingsFields } from "./settings";

export const contextSummarySchema = z
  .object({
    content: z.string().max(8192),
    boundary: z.number().int().nonnegative(),
    fallback: z.boolean(),
  })
  .strict();
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
