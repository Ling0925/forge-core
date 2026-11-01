import { z } from "zod";
import { agentProfileIdSchema } from "./agent-profiles";
import { jsonValueSchema, timestampSchema } from "./schemas/base";

const idSchema = z.string().min(1);
const idsSchema = z.array(idSchema).readonly();

export const triggerSchema = z
  .object({
    id: idSchema,
    source: z.literal("github"),
    kind: z.string(),
    actor: z.string(),
    explicit: z.boolean(),
    threadId: idSchema,
    summary: z.string(),
    payload: jsonValueSchema,
    receivedAt: timestampSchema,
    disposition: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict()
  .readonly();
export type Trigger = z.infer<typeof triggerSchema>;

export const threadSchema = z
  .object({
    id: idSchema,
    title: z.string(),
    url: z.string(),
    state: z.string(),
    lastTriggerAt: timestampSchema,
  })
  .strict()
  .readonly();
export type Thread = z.infer<typeof threadSchema>;

export const workItemStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "ready",
  "blocked",
  "failed",
  "stopped",
  "done",
]);
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;
export const workItemSchema = z
  .object({
    id: idSchema,
    status: workItemStatusSchema,
    title: z.string(),
    brief: z.string(),
    threadIds: idsSchema,
    workerSessionId: idSchema.nullable(),
    profileId: agentProfileIdSchema,
    worktree: z.string().nullable(),
    progress: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    claimedBy: idSchema.nullable(),
  })
  .strict()
  .readonly();
export type WorkItem = z.infer<typeof workItemSchema>;
export const createWorkItemSchema = workItemSchema
  .unwrap()
  .pick({
    title: true,
    brief: true,
    threadIds: true,
    profileId: true,
  })
  .extend({ worktree: z.string().optional() })
  .strict()
  .readonly();
export type CreateWorkItem = z.infer<typeof createWorkItemSchema>;
export const workItemUpdateSchema = workItemSchema
  .unwrap()
  .pick({
    status: true,
    progress: true,
  })
  .partial()
  .strict()
  .readonly();
export type WorkItemUpdate = z.infer<typeof workItemUpdateSchema>;
export const workItemQuerySchema = z
  .object({
    status: z
      .union([workItemStatusSchema, z.array(workItemStatusSchema).readonly()])
      .optional(),
    threadId: idSchema.optional(),
  })
  .strict()
  .readonly();
export type WorkItemQuery = z.infer<typeof workItemQuerySchema>;

export interface WorkItemStore {
  create(input: CreateWorkItem): Promise<WorkItem>;
  claim(id: string, claimedBy: string): Promise<WorkItem | undefined>;
  update(id: string, update: WorkItemUpdate): Promise<WorkItem>;
  linkThread(id: string, threadId: string): Promise<WorkItem>;
  unlinkThread(id: string, threadId: string): Promise<WorkItem>;
  linkWorker(
    id: string,
    sessionId: string,
    worktree?: string,
  ): Promise<WorkItem>;
  get(id: string): Promise<WorkItem | undefined>;
  list(query?: WorkItemQuery): Promise<readonly WorkItem[]>;
}

export const suggestionSchema = z
  .object({
    id: idSchema,
    threadIds: idsSchema,
    brief: z.string(),
    triggerIds: idsSchema,
    state: z.enum(["pending", "accepted", "rejected"]),
    workId: idSchema.nullable(),
  })
  .strict()
  .readonly();
export type Suggestion = z.infer<typeof suggestionSchema>;
export const outboxKindSchema = z.enum([
  "comment",
  "label",
  "push",
  "pull_request",
]);
export const superAgentSendSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(outboxKindSchema.enum.comment),
      target: z.object({ thread: idSchema }).strict(),
      body: z.object({ text: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(outboxKindSchema.enum.label),
      target: z.object({ thread: idSchema }).strict(),
      body: z.object({ labels: z.array(z.string()) }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(outboxKindSchema.enum.push),
      target: z.object({}).strict(),
      body: z.object({ branch: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(outboxKindSchema.enum.pull_request),
      target: z.object({}).strict(),
      body: z
        .object({
          title: z.string(),
          body: z.string(),
          head: z.string(),
          base: z.string(),
        })
        .strict(),
    })
    .strict(),
]);
const outboxFields = {
  id: idSchema,
  workId: idSchema,
  state: z.enum(["pending", "approved", "rejected", "sent", "failed"]),
  error: z.string().nullable(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  sentAt: timestampSchema.nullable(),
};
export const outboxItemSchema = z
  .discriminatedUnion("kind", [
    superAgentSendSchema.options[0].extend(outboxFields),
    superAgentSendSchema.options[1].extend(outboxFields),
    superAgentSendSchema.options[2].extend(outboxFields),
    superAgentSendSchema.options[3].extend(outboxFields),
  ])
  .readonly();
export type OutboxItem = z.infer<typeof outboxItemSchema>;
export const deliverySchema = z
  .object({
    id: idSchema,
    event: z.string(),
    receivedAt: timestampSchema,
    payload: jsonValueSchema,
    processedAt: timestampSchema.nullable(),
  })
  .strict()
  .readonly();
export type Delivery = z.infer<typeof deliverySchema>;

const githubFields = {
  login: z.string().optional(),
  repos: z.array(z.string()).readonly().optional(),
  webhook: z
    .object({
      host: z.string().optional(),
      port: z.number().int().optional(),
    })
    .strict()
    .readonly()
    .optional(),
};
export const superAgentSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    workspace: z.string().optional(),
    routerProfileId: agentProfileIdSchema.optional(),
    workerProfileId: agentProfileIdSchema.optional(),
    github: z.object(githubFields).strict().readonly().optional(),
    maxWorkers: z.number().int().positive().optional(),
  })
  .strict()
  .readonly();
export type SuperAgentSettings = z.infer<typeof superAgentSettingsSchema>;
export const superAgentSettingsInputSchema = superAgentSettingsSchema
  .unwrap()
  .extend({
    github: z
      .object({ ...githubFields, webhookSecret: z.string().optional() })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export const publicSuperAgentSettingsSchema = superAgentSettingsSchema
  .unwrap()
  .extend({
    github: z
      .object({ ...githubFields, hasWebhookSecret: z.boolean() })
      .strict()
      .readonly()
      .optional(),
  })
  .strict()
  .readonly();
export type PublicSuperAgentSettings = z.infer<
  typeof publicSuperAgentSettingsSchema
>;

export const superAgentEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("superagent_trigger"), trigger: triggerSchema })
    .strict(),
  z
    .object({ type: z.literal("superagent_work"), work: workItemSchema })
    .strict(),
  z
    .object({
      type: z.literal("superagent_suggestion"),
      suggestion: suggestionSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("superagent_outbox"), item: outboxItemSchema })
    .strict(),
]);
export type SuperAgentEvent = z.infer<typeof superAgentEventSchema>;
