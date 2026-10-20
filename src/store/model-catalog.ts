import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import { modelCatalogSchema, type ModelCatalog } from "../shared/model-catalog";
import type { ProviderConfig } from "../shared/schemas";
import { atomicJson, privateDirectory, readJson } from "./io";
import { fileLock } from "./lock";

const maxBytes = 16 * 1024 * 1024;
const snapshotSchema = z.object({
  version: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  requestedAt: z.number().int().nonnegative(),
  fetchedAt: z.string().datetime(),
  models: modelCatalogSchema,
}).strict();
const cancelled = () => new ForgeError("cancelled", "Model discovery cancelled.");

export function modelCatalogCacheKey(config: ProviderConfig, sourceId?: string): string {
  // Credential changes must not reuse another account's catalog. Neither the
  // credential nor the endpoint is stored in the file name or cache payload.
  return createHash("sha256").update(JSON.stringify([
    sourceId ?? null, config.baseUrl.replace(/\/+$/, ""),
    config.apiMode ?? "chat-completions", config.apiKey,
  ])).digest("hex");
}

type Pending = {
  controller: AbortController;
  users: number;
  promise: Promise<ModelCatalog>;
};

export async function openModelCatalogStore(home: string) {
  const directory = await privateDirectory(join(home, "model-catalogs"));
  const pending = new Map<string, Pending>();
  const pathFor = (key: string) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new ForgeError("invalid_input", "Invalid model catalog key.");
    return join(directory, `${key}.json`);
  };
  const read = async (key: string) => {
    try {
      const parsed = snapshotSchema.safeParse(await readJson(pathFor(key), maxBytes));
      return parsed.success && parsed.data.key === key ? parsed.data : undefined;
    } catch {
      // Missing/corrupt cache is not authoritative. Safe store I/O still rejects
      // symlinks and unsafe file permissions when attempting to write it.
      return undefined;
    }
  };
  const subscribe = (task: Pending, signal?: AbortSignal): Promise<ModelCatalog> => {
    task.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        task.users--;
        if (task.users === 0) task.controller.abort();
        complete();
      };
      const abort = () => finish(() => reject(cancelled()));
      signal?.addEventListener("abort", abort, { once: true });
      task.promise.then(models => finish(() => resolve(models)), error => finish(() => reject(error)));
      if (signal?.aborted) abort();
    });
  };
  return {
    async load(
      key: string,
      loader: (signal: AbortSignal) => Promise<ModelCatalog>,
      signal?: AbortSignal,
      refresh = false,
    ): Promise<ModelCatalog> {
      if (signal?.aborted) throw cancelled();
      const path = pathFor(key);
      if (!refresh) {
        const cached = await read(key);
        if (signal?.aborted) throw cancelled();
        if (cached) return cached.models;
      }
      let task = pending.get(key);
      // Refresh is a new request, never the answer to a pre-refresh request.
      if (refresh || !task || task.controller.signal.aborted) {
        const controller = new AbortController();
        const requestedAt = Date.now();
        const owned: Pending = { controller, users: 0, promise: Promise.resolve([]) };
        owned.promise = Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw cancelled();
          const models = modelCatalogSchema.parse(await loader(controller.signal));
          if (controller.signal.aborted) throw cancelled();
          if (pending.get(key) === owned) {
            // Serialize only the short commit, not the network request. A late
            // older request (including another process) must not replace newer data.
            try {
              const release = await fileLock(join(directory, `${key}.lock`), controller.signal);
              try {
                const current = await read(key);
                if (!controller.signal.aborted && pending.get(key) === owned &&
                    (!current || current.requestedAt <= requestedAt)) {
                  await atomicJson(path, { version: 1, key, requestedAt,
                    fetchedAt: new Date().toISOString(), models }, maxBytes);
                }
              } finally { await release(); }
            } catch {
              // Cache persistence is best-effort; a storage problem must not
              // discard an otherwise usable provider response or touch old data.
            }
          }
          if (controller.signal.aborted) throw cancelled();
          return models;
        }).finally(() => {
          if (pending.get(key) === owned) pending.delete(key);
        });
        pending.set(key, owned);
        task = owned;
      }
      return subscribe(task, signal);
    },
  };
}
export type ModelCatalogStore = Awaited<ReturnType<typeof openModelCatalogStore>>;
