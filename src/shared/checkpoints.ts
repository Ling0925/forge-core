import { z } from "zod";

export const checkpointMetadataSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().min(1).max(256),
    toolCallId: z.string().min(1).max(256),
    path: z.string().min(1).max(4096),
    kind: z.enum(["created", "modified"]),
    state: z.enum(["pending", "completed", "restored"]),
    beforeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    beforeMode: z.number().int().min(0).max(0o7777).nullable(),
    afterHash: z.string().regex(/^[a-f0-9]{64}$/),
    afterMode: z.number().int().min(0).max(0o7777).optional(),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    restoredAt: z.string().datetime().optional(),
  })
  .strict();
export type CheckpointMetadata = z.infer<typeof checkpointMetadataSchema>;
export const checkpointDtoSchema = checkpointMetadataSchema.readonly();
export type CheckpointDto = z.infer<typeof checkpointDtoSchema>;

export interface RestoreOptions {
  readonly signal?: AbortSignal;
  readonly isSessionActive: (sessionId: string) => Promise<boolean>;
}
export interface CheckpointService {
  list(signal?: AbortSignal): Promise<readonly CheckpointMetadata[]>;
  getDiff(id: string, signal?: AbortSignal): Promise<string>;
  restore(id: string, options: RestoreOptions): Promise<CheckpointMetadata>;
}
