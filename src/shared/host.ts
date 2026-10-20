import { z } from "zod";
import {
  approvalRequestSchema,
  permissionSchema,
  sessionIdSchema,
  sessionStatusSchema,
} from "./schemas";

export const HOST_PROTOCOL_VERSION = 1;
export const hostStateSchema = z
  .object({
    hostId: z.string().uuid(),
    protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
    runs: z
      .array(
        z
          .object({
            runId: z.string().uuid().brand<"RunId">(),
            sessionId: sessionIdSchema,
            status: sessionStatusSchema,
            stopping: z.boolean(),
            permission: permissionSchema.optional(),
            pendingApprovals: z.array(approvalRequestSchema).readonly(),
          })
          .strict()
          .readonly(),
      )
      .readonly(),
  })
  .strict()
  .readonly();
export type HostState = z.infer<typeof hostStateSchema>;
