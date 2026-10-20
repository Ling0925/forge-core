import { z } from "zod";
import { sessionIdSchema } from "./schemas";

export const memoryIdSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const memoryVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const memoryTagsSchema = z.array(z.string().trim().min(1).max(80)).max(32)
  .transform(tags => [...new Set(tags)]);
export const memorySummarySchema = z.string().trim().min(1).max(1000);
export const memoryDetailsSchema = z.string().trim().min(1).max(32000);
export const memorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: sessionIdSchema, recordId: z.string().regex(/^m[1-9][0-9]*$/) }).strict(),
  z.object({ kind: z.literal("memory"), id: memoryIdSchema, version: memoryVersionSchema }).strict(),
]);
export type MemorySource = z.infer<typeof memorySourceSchema>;
export const memoryRecordSchema = z.object({
  id: memoryIdSchema, tags: memoryTagsSchema, summary: memorySummarySchema,
  details: memoryDetailsSchema, version: memoryVersionSchema,
  sources: z.array(memorySourceSchema).max(32), created_at: z.string(), updated_at: z.string(),
}).strict();
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const updateMemorySchema = z.object({
  id: memoryIdSchema.optional(), tags: memoryTagsSchema.optional(),
  summary: memorySummarySchema.optional(), details: memoryDetailsSchema.optional(),
  expected_version: memoryVersionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.id === undefined && (!value.summary || !value.details || value.expected_version !== undefined))
    ctx.addIssue({ code: "custom", message: "New memories require summary and details, without expected_version." });
  if (value.id !== undefined && value.tags === undefined && value.summary === undefined && value.details === undefined)
    ctx.addIssue({ code: "custom", message: "An update requires tags, summary or details." });
});
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;
export const deleteMemorySchema = z.object({ id: memoryIdSchema, expected_version: memoryVersionSchema.optional() }).strict();
export const getMemorySchema = z.object({
  id: memoryIdSchema, offset: z.number().int().min(0).max(32000).default(0),
  limit: z.number().int().min(1).max(12000).default(6000),
}).strict();
export const searchMemorySchema = z.object({
  tags: memoryTagsSchema.default([]),
  keywords: z.array(z.string().trim().min(1).max(256)).max(16).default([]),
  tag_mode: z.enum(["any", "all"]).default("any"),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export type SearchMemoryInput = z.infer<typeof searchMemorySchema>;
export interface MemorySearchResult {
  readonly hits: readonly (Omit<MemoryRecord, "details" | "sources"> & { readonly excerpt: string })[];
  readonly total: number;
  readonly nextOffset: number | null;
}
export const forgeMemorySchema = z.object({
  query: z.string().trim().min(1).max(1000),
  keywords: z.array(z.string().trim().min(1).max(256)).max(16).default([]),
  tags: memoryTagsSchema.default([]),
  scope: z.enum(["all", "workspace", "session"]).default("all"),
  dry_run: z.boolean().default(false),
}).strict();
export type ForgeMemoryInput = z.infer<typeof forgeMemorySchema>;
export const memoryProposalSchema = z.object({
  id: memoryIdSchema.optional(), tags: memoryTagsSchema,
  summary: memorySummarySchema, details: memoryDetailsSchema,
  refs: z.array(z.string().min(1).max(100)).min(1).max(32),
}).strict();
export const memorySynthesisSchema = z.object({ memories: z.array(memoryProposalSchema).max(12) }).strict();
export type MemoryChange = UpdateMemoryInput & { readonly sources: readonly MemorySource[] };
export interface MemoryStore {
  get(id: number): Promise<MemoryRecord | undefined>;
  search(input: SearchMemoryInput): Promise<MemorySearchResult>;
  update(input: UpdateMemoryInput, signal?: AbortSignal, beforeWrite?: () => void): Promise<MemoryRecord>;
  delete(input: z.infer<typeof deleteMemorySchema>, signal?: AbortSignal, beforeWrite?: () => void): Promise<{ id: number; deleted: boolean }>;
  /** Atomic batch; evidence versions and host write permission are checked at commit. */
  apply(changes: readonly MemoryChange[], expected: readonly { id: number; version: number }[], signal?: AbortSignal, beforeWrite?: () => void): Promise<readonly MemoryRecord[]>;
  close(): Promise<void>;
}
