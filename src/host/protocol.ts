import { z } from "zod";
import { HOST_PROTOCOL_VERSION, hostStateSchema } from "../shared/host";
import {
  rpcRequestSchema,
  rpcResponseSchema,
  runEventSchema,
} from "../shared/ipc";

export const helloSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
    hostId: z.string().uuid().optional(),
    cursor: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export const localRequestSchema = z
  .object({
    kind: z.literal("request"),
    hostId: z.string().uuid(),
    connectionId: z.string().uuid(),
    sequence: z.number().int().positive().safe(),
    request: rpcRequestSchema,
  })
  .strict();
const eventSchema = z
  .object({ cursor: z.number().int().positive().safe(), data: runEventSchema })
  .strict();
export const localMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("hello"),
      state: hostStateSchema,
      connectionId: z.string().uuid(),
      cursor: z.number().int().nonnegative().safe(),
      reset: z.boolean(),
      replay: z.array(eventSchema),
      recovery: z.array(runEventSchema),
    })
    .strict(),
  z.object({ kind: z.literal("event"), ...eventSchema.shape }).strict(),
  z
    .object({ kind: z.literal("response"), response: rpcResponseSchema })
    .strict(),
  z
    .object({ kind: z.literal("error"), message: z.string().max(1024) })
    .strict(),
]);
