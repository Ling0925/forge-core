import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema).readonly(),
    z.record(jsonValueSchema).readonly(),
  ]),
);
export const jsonObjectSchema = z.record(jsonValueSchema).readonly();
export const sessionIdSchema = z.string().uuid().brand<"SessionId">();
export type SessionId = z.infer<typeof sessionIdSchema>;
export const parseSessionId = (value: unknown): SessionId =>
  sessionIdSchema.parse(value);
export const timestampSchema = z.string().datetime({ offset: true });
export const permissionSchema = z.enum([
  "readonly",
  "workspace",
  "unrestricted",
]);
export type Permission = z.infer<typeof permissionSchema>;
