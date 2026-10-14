import { join } from "node:path";
import { z } from "zod";
import type { SettingsStore } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import {
  configureInputSchema,
  defaultPublicSettings,
  providerConfigSchema,
  publicSettingsSchema,
} from "../shared/schemas";
import type { PublicSettings } from "../shared/schemas";
import { atomicJson, privateDirectory, readJson, storageError } from "./io";
import { fileLock } from "./lock";

async function settingsLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    try {
      return await fileLock(path);
    } catch (error) {
      if (!(error instanceof ForgeError && error.code === "busy")) throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new ForgeError("busy", "Settings are currently locked.", true);
}

const fieldsSchema = configureInputSchema.unwrap().shape.settings.unwrap();
const configSchema = z
  .object({ version: z.literal(1), settings: fieldsSchema })
  .strict();
const credentialSchema = z
  .object({
    version: z.literal(1),
    apiKey: configureInputSchema.unwrap().shape.apiKey.unwrap(),
  })
  .strict();
async function optionalRecord(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path, 65536);
  } catch (error) {
    if (error instanceof ForgeError && error.code === "not_found")
      return undefined;
    throw error;
  }
}
export async function openSettingsStore(
  directory: string,
): Promise<SettingsStore> {
  const root = await privateDirectory(directory);
  const folder = await privateDirectory(join(root, "settings"));
  const configPath = join(folder, "config.json");
  const keyPath = join(folder, "credential.json");
  const transactionPath = join(folder, "state.json");
  const transactionSchema = z
    .object({
      version: z.literal(1),
      settings: fieldsSchema,
      apiKey: credentialSchema.shape.apiKey,
    })
    .strict();
  const locked = async <T>(operation: () => Promise<T>): Promise<T> => {
    const release = await settingsLock(join(folder, "state.lock"));
    try {
      return await operation();
    } finally {
      await release();
    }
  };
  const load = async () => {
    // After opening, absence is corruption, never a reason to combine projections.
    const parsed = transactionSchema.safeParse(
      await readJson(transactionPath, 65536),
    );
    if (!parsed.success) throw storageError();
    return { settings: parsed.data.settings, apiKey: parsed.data.apiKey };
  };
  const initialize = async () => {
    const transaction = await optionalRecord(transactionPath);
    if (transaction !== undefined) {
      await load();
      return;
    }
    // Import legacy files only while holding the cross-process writer lock, and
    // publish one authoritative snapshot before exposing any unlocked readers.
    const config = await optionalRecord(configPath);
    const credential = await optionalRecord(keyPath);
    const parsed = configSchema.safeParse(
      config ?? { version: 1, settings: {} },
    );
    const key = credentialSchema.safeParse(
      credential ?? { version: 1, apiKey: "" },
    );
    if (!parsed.success || !key.success) throw storageError();
    await atomicJson(
      transactionPath,
      { version: 1, settings: parsed.data.settings, apiKey: key.data.apiKey },
      65536,
    );
  };
  const effective = async (): Promise<
    Readonly<{ public: PublicSettings; apiKey: string }>
  > => {
    const stored = await load();
    const overlay = configureInputSchema.safeParse({
      settings: {
        ...(process.env.FORGE_BASE_URL === undefined
          ? {}
          : { baseUrl: process.env.FORGE_BASE_URL }),
        ...(process.env.FORGE_MODEL === undefined
          ? {}
          : { model: process.env.FORGE_MODEL }),
      },
      ...(process.env.FORGE_API_KEY === undefined
        ? {}
        : { apiKey: process.env.FORGE_API_KEY }),
    });
    if (!overlay.success)
      throw new ForgeError(
        "invalid_input",
        "Environment configuration failed validation.",
      );
    const settings = {
      ...defaultPublicSettings,
      ...stored.settings,
      ...overlay.data.settings,
    };
    const apiKey = overlay.data.apiKey ?? stored.apiKey;
    return {
      public: publicSettingsSchema.parse({
        ...settings,
        hasApiKey: apiKey !== "",
        isConfigured: settings.baseUrl !== "" && settings.model !== "",
      }),
      apiKey,
    };
  };
  await locked(initialize);
  let tail: Promise<void> = Promise.resolve();
  return {
    async getPublic() {
      return (await effective()).public;
    },
    async getProviderConfig() {
      const config = await effective();
      if (!config.public.baseUrl)
        throw new ForgeError(
          "invalid_input",
          "Configure a provider endpoint before listing models.",
        );
      return providerConfigSchema.parse({
        baseUrl: config.public.baseUrl,
        apiKey: config.apiKey,
        requestTimeoutMs: config.public.requestTimeoutMs,
        apiMode: config.public.apiMode,
        reasoningEffort: config.public.reasoningEffort,
      });
    },
    update(input) {
      const operation = tail.then(() =>
        locked(async () => {
          const parsed = configureInputSchema.safeParse(input);
          if (!parsed.success)
            throw new ForgeError(
              "invalid_input",
              "Settings failed validation.",
            );
          const stored = await load();
          const next = {
            version: 1,
            settings: { ...stored.settings, ...parsed.data.settings },
            apiKey: parsed.data.apiKey ?? stored.apiKey,
          };
          // Single authoritative commit includes endpoint and credential together.
          // Legacy files remain private compatibility projections, never read once
          // state.json exists; interruption cannot expose a mixed provider pair.
          await atomicJson(transactionPath, next, 65536);
          await atomicJson(keyPath, { version: 1, apiKey: next.apiKey }, 65536);
          await atomicJson(
            configPath,
            { version: 1, settings: next.settings },
            65536,
          );
          return (await effective()).public;
        }),
      );
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}
