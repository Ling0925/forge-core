import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { watch } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type AuthorizedDevice,
  type DeviceAuthorization,
  deviceCredentialSchema,
  deviceNameSchema,
  deviceRecordSchema,
} from "../shared/device-authorization";
import { ForgeError } from "../shared/errors";
import { atomicJson, privateDirectory, readJson } from "./io";
import { fileLock } from "./lock";

export const MAX_AUTHORIZED_DEVICES = 128;
export const MAX_PAIRING_INVITATIONS = 16;
const MAX_BYTES = 128 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const storedDevice = deviceRecordSchema
  .unwrap()
  .extend({ hash: hashSchema })
  .strict();
const invitation = z
  .object({
    id: z.string().uuid(),
    name: deviceNameSchema,
    hash: hashSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
const catalogSchema = z
  .object({
    version: z.literal(1),
    devices: z.array(storedDevice).max(MAX_AUTHORIZED_DEVICES),
    invitations: z.array(invitation).max(MAX_PAIRING_INVITATIONS),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.devices.map((item) => item.id)).size !==
        value.devices.length ||
      new Set(value.invitations.map((item) => item.id)).size !==
        value.invitations.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate device identity",
      });
    if (
      value.devices.some(
        (item) => (item.status === "revoked") !== (item.revokedAt !== null),
      )
    )
      context.addIssue({ code: "custom", message: "Invalid revocation state" });
  });
type Catalog = z.infer<typeof catalogSchema>;
const digest = (kind: "pair" | "device", credential: string) =>
  createHash("sha256").update(`forge:${kind}:v1\0${credential}`).digest("hex");
const matches = (hash: string, kind: "pair" | "device", value: string) =>
  timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(digest(kind, value), "hex"),
  );
const publicDevice = (
  value: z.infer<typeof storedDevice>,
): AuthorizedDevice => {
  const { hash: _private, ...record } = value;
  return deviceRecordSchema.parse(record);
};
const denied = () =>
  new ForgeError(
    "invalid_input",
    "Device authorization or pairing is unavailable.",
  );

/** Private hash-only authoritative catalog. No positive authorization cache. */
export async function openDeviceAuthorization(options: {
  directory: string;
  now?: () => number;
}): Promise<DeviceAuthorization> {
  const directory = await privateDirectory(join(options.directory, "devices"));
  const path = join(directory, "authorizations.json");
  const lockPath = join(directory, "authorizations.lock");
  const now = options.now ?? Date.now;
  let closed = false;
  const listeners = new Set<() => void | Promise<void>>();
  const read = async (): Promise<Catalog> => {
    if (closed) throw denied();
    return catalogSchema.parse(await readJson(path, MAX_BYTES));
  };
  const write = async (catalog: Catalog) => {
    const checked = catalogSchema.parse(catalog);
    if (Buffer.byteLength(JSON.stringify(checked)) > MAX_BYTES) throw denied();
    await atomicJson(path, checked);
  };
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (closed) throw denied();
      let release: (() => Promise<void>) | undefined;
      try {
        release = await fileLock(lockPath);
      } catch (error) {
        if (
          !(error instanceof ForgeError) ||
          error.code !== "busy" ||
          attempt === 199
        )
          throw denied();
        await new Promise((done) => setTimeout(done, 5));
        continue;
      }
      try {
        return await work();
      } finally {
        await release();
      }
    }
    throw denied();
  };
  await locked(async () => {
    try {
      await read();
    } catch (error) {
      if (!(error instanceof ForgeError) || error.code !== "not_found")
        throw denied();
      await write({ version: 1, devices: [], invitations: [] });
    }
  });
  let notifying: Promise<void> | undefined;
  let dirty = false;
  const notify = (): Promise<void> => {
    dirty = true;
    if (!notifying)
      notifying = (async () => {
        while (dirty && !closed) {
          dirty = false;
          await Promise.allSettled(
            [...listeners].map((listener) => Promise.resolve().then(listener)),
          );
        }
      })().finally(() => {
        notifying = undefined;
      });
    return notifying.then(() => (dirty && !closed ? notify() : undefined));
  };
  // Watch is an eager invalidation hint. Every request/event still reads the
  // authoritative catalog; the interval also closes idle sockets after a missed hint.
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(directory, { persistent: false }, () => {
      void notify();
    });
    watcher.on("error", () => {
      void notify();
    });
  } catch {
    /* Authoritative checks and the bounded idle fallback remain active. */
  }
  const poll = setInterval(() => {
    if (listeners.size) void notify();
  }, 1000);
  poll.unref();
  const credential = () =>
    `${randomUUID()}.${randomBytes(32).toString("base64url")}`;
  return {
    async createPairing(rawName, ttlMs = 300_000) {
      const name = deviceNameSchema.parse(rawName);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600_000)
        throw denied();
      return locked(async () => {
        const catalog = await read();
        catalog.invitations = catalog.invitations.filter(
          (item) => Date.parse(item.expiresAt) > now(),
        );
        if (
          catalog.invitations.length >= MAX_PAIRING_INVITATIONS ||
          catalog.devices.length >= MAX_AUTHORIZED_DEVICES
        )
          throw denied();
        const token = credential();
        const id = token.split(".")[0] ?? "";
        const expiresAt = new Date(now() + ttlMs).toISOString();
        catalog.invitations.push({
          id,
          name,
          hash: digest("pair", token),
          expiresAt,
        });
        await write(catalog);
        return { token, expiresAt };
      });
    },
    async exchange(raw) {
      const parsed = deviceCredentialSchema.safeParse(raw);
      if (!parsed.success) throw denied();
      return locked(async () => {
        const catalog = await read();
        const id = parsed.data.split(".")[0];
        const invitation = catalog.invitations.find((item) => item.id === id);
        if (
          !invitation ||
          Date.parse(invitation.expiresAt) <= now() ||
          !matches(invitation.hash, "pair", parsed.data) ||
          catalog.devices.length >= MAX_AUTHORIZED_DEVICES
        )
          throw denied();
        const value = credential();
        const record = {
          id: value.split(".")[0] ?? "",
          name: invitation.name,
          scope: "host" as const,
          createdAt: new Date(now()).toISOString(),
          status: "active" as const,
          revokedAt: null,
          hash: digest("device", value),
        };
        catalog.invitations = catalog.invitations.filter(
          (item) => item.id !== id,
        );
        catalog.devices.push(record);
        await write(catalog);
        return { credential: value, device: publicDevice(record) };
      });
    },
    async list() {
      return (await read()).devices.map(publicDevice);
    },
    async verify(raw) {
      try {
        const parsed = deviceCredentialSchema.safeParse(raw);
        if (!parsed.success) return undefined;
        const record = (await read()).devices.find(
          (item) => item.id === parsed.data.split(".")[0],
        );
        return record?.status === "active" &&
          matches(record.hash, "device", parsed.data)
          ? publicDevice(record)
          : undefined;
      } catch {
        return undefined;
      }
    },
    async isAuthorized(id) {
      try {
        return (await read()).devices.some(
          (item) => item.id === id && item.status === "active",
        );
      } catch {
        return false;
      }
    },
    async revoke(rawId) {
      const id = z.string().uuid().parse(rawId);
      await locked(async () => {
        const catalog = await read();
        const record = catalog.devices.find((item) => item.id === id);
        if (!record) throw denied();
        if (record.status === "active") {
          record.status = "revoked";
          record.revokedAt = new Date(now()).toISOString();
          await write(catalog);
        }
      });
      await notify();
    },
    subscribe(listener) {
      if (closed) throw denied();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      clearInterval(poll);
      watcher?.close();
      listeners.clear();
      await notifying;
    },
  };
}
