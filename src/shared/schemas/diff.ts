import { z } from "zod";

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
