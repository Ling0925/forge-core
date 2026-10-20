import { z } from "zod";
export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) =>
    Array.from(value).every(
      (char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127,
    ),
  );
export const deviceCredentialSchema = z
  .string()
  .regex(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
export const deviceRecordSchema = z
  .object({
    id: z.string().uuid(),
    name: deviceNameSchema,
    scope: z.literal("host"),
    createdAt: z.string().datetime(),
    status: z.enum(["active", "revoked"]),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict()
  .readonly();
export type AuthorizedDevice = z.infer<typeof deviceRecordSchema>;
export const pairingExchangeSchema = z
  .object({ token: deviceCredentialSchema })
  .strict();
export interface DeviceAuthorization {
  createPairing(
    name: string,
    ttlMs?: number,
  ): Promise<Readonly<{ token: string; expiresAt: string }>>;
  exchange(
    token: string,
  ): Promise<Readonly<{ credential: string; device: AuthorizedDevice }>>;
  list(): Promise<readonly AuthorizedDevice[]>;
  verify(credential: string): Promise<AuthorizedDevice | undefined>;
  isAuthorized(id: string): Promise<boolean>;
  revoke(id: string): Promise<void>;
  subscribe(listener: () => void | Promise<void>): () => void;
  close(): Promise<void>;
}
