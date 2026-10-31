import { z } from "zod";
import { createDiffPatch, unavailablePatch } from "../diff";
import { publishedFilesSchema } from "../published-files";
import { sessionIdSchema } from "./base";
import { toolCallSchema } from "./messages";

export const diffPatchSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["complete", "truncated", "unavailable"]),
    reason: z.literal("budget").optional(),
    added: z.number().int().nonnegative().optional(),
    removed: z.number().int().nonnegative().optional(),
    omittedLines: z.number().int().nonnegative(),
    omittedHunks: z.number().int().nonnegative(),
    hunks: z
      .array(
        z
          .object({
            oldStart: z.number().int().nonnegative(),
            oldLines: z.number().int().nonnegative(),
            newStart: z.number().int().nonnegative(),
            newLines: z.number().int().nonnegative(),
            lines: z
              .array(
                z
                  .object({
                    op: z.enum(["equal", "delete", "insert"]),
                    text: z.string().max(8192),
                  })
                  .strict()
                  .readonly(),
              )
              .max(400)
              .readonly(),
          })
          .strict()
          .readonly(),
      )
      .max(64)
      .readonly(),
  })
  .strict()
  .readonly();
export type DiffPatch = z.infer<typeof diffPatchSchema>;

/**
 * A file change carries only the exact hunk diff (`patch`). Older sessions
 * persisted bounded `before`/`after` display previews plus a `truncated` flag;
 * those are migrated into `patch` on read and never written again.
 */
const migrateFileChange = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (!("before" in record) && !("after" in record) && !("truncated" in record))
    return value;
  const { before, after, truncated, ...rest } = record;
  if (rest.patch !== undefined) return rest;
  // Only explicitly complete previews can yield an exact diff. A missing side
  // is empty only for a creation/deletion, never for an unknown modification.
  const complete =
    truncated === false &&
    (typeof before === "string" ||
      (rest.kind === "created" && before === null)) &&
    (typeof after === "string" || (rest.kind === "deleted" && after === null));
  const patch = complete
    ? createDiffPatch(
        typeof before === "string" ? before : "",
        typeof after === "string" ? after : "",
      )
    : unavailablePatch();
  return { ...rest, patch };
};

const fileChangeObjectSchema = z
  .object({
    path: z.string().min(1).max(4096),
    kind: z.enum(["created", "modified", "deleted"]),
    // Generated from the full originals; absent only when it could not be computed.
    patch: diffPatchSchema.optional(),
  })
  .strict()
  .readonly();

export const fileChangeSchema = z.preprocess(
  migrateFileChange,
  fileChangeObjectSchema,
);
export type FileChange = z.infer<typeof fileChangeSchema>;
export const toolResultSchema = z
  .object({
    content: z.string().max(131072),
    isError: z.boolean(),
    changes: z.array(fileChangeSchema).max(256).readonly().optional(),
    files: publishedFilesSchema.optional(),
  })
  .strict()
  .readonly();
export type ToolResult = z.infer<typeof toolResultSchema>;
export const approvalRequestSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: sessionIdSchema,
    toolCallId: toolCallSchema.unwrap().shape.id,
    toolName: toolCallSchema.unwrap().shape.function.unwrap().shape.name,
    childSessionId: sessionIdSchema.optional(),
    description: z.string().max(8192),
    command: z.array(z.string().max(8192)).max(256).readonly().optional(),
  })
  .strict()
  .readonly();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
