import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import {
  type HarnessExperience,
  type HarnessExperienceInput,
  type HarnessExperienceScope,
  type HarnessExperienceStore,
  harnessExperienceInputSchema,
  harnessExperienceSchema,
  harnessExperienceScopeSchema,
} from "../shared/harness-adaptation";
import { atomicJson, privateDirectory, readJson, storageError } from "./io";
import { fileLock } from "./lock";

/** Entries retained per exact scope. Oldest entries are evicted first. */
export const MAX_HARNESS_EXPERIENCES = 64;
/** Recent window exposed to adaptation; the store never returns more. */
export const HARNESS_EXPERIENCE_LIST_LIMIT = 4;
/** Hard file bound; large enough for normal entries, always enforced. */
export const MAX_HARNESS_EXPERIENCE_BYTES = 2 * 1024 * 1024;

const experienceFileSchema = z
  .object({
    version: z.literal(1),
    scope: harnessExperienceScopeSchema,
    entries: z.array(harnessExperienceSchema).max(MAX_HARNESS_EXPERIENCES),
  })
  .strict()
  .superRefine((file, context) => {
    const reportIds = new Set<string>();
    const ids = new Set<string>();
    for (const entry of file.entries) {
      if (!sameScope(entry.scope, file.scope)) {
        context.addIssue({
          code: "custom",
          message: "Stored experience scope does not match its file",
        });
        return;
      }
      if (reportIds.has(entry.reportId) || ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate stored experience identity",
        });
        return;
      }
      reportIds.add(entry.reportId);
      ids.add(entry.id);
    }
  })
  .readonly();

const invalid = (message: string) => new ForgeError("invalid_input", message);

const sameScope = (
  left: HarnessExperienceScope,
  right: HarnessExperienceScope,
): boolean =>
  left.workspace === right.workspace &&
  left.model === right.model &&
  left.domain === right.domain;

/** The workspace is canonicalized so path aliases address one exact scope. */
const canonicalScope = (
  scope: HarnessExperienceScope,
): HarnessExperienceScope => {
  const parsed = harnessExperienceScopeSchema.safeParse({
    workspace: resolve(scope.workspace),
    model: scope.model,
    domain: scope.domain,
  });
  if (!parsed.success) throw invalid("Harness experience scope is invalid.");
  return parsed.data;
};

const scopeHash = (scope: HarnessExperienceScope): string =>
  createHash("sha256")
    .update(JSON.stringify([scope.workspace, scope.model, scope.domain]))
    .digest("hex");

/**
 * Retention is capped by count and by the hard byte bound. Schema-valid entries
 * can still be large enough that 64 of them exceed the limit, so the oldest are
 * evicted first instead of failing a legitimate save or writing an unreadable
 * file. A single oversized entry still fails closed through `atomicJson`.
 */
const retainable = (
  scope: HarnessExperienceScope,
  entries: readonly HarnessExperience[],
): readonly HarnessExperience[] => {
  let retained = entries.slice(-MAX_HARNESS_EXPERIENCES);
  while (retained.length > 1) {
    const file = JSON.stringify({ version: 1, scope, entries: retained });
    if (Buffer.byteLength(file) + 1 <= MAX_HARNESS_EXPERIENCE_BYTES)
      return retained;
    retained = retained.slice(1);
  }
  return retained;
};

/**
 * Private, per-scope experience library. Each file is strict-schema validated
 * and scope consistent; a damaged, oversized or symlinked record fails closed
 * instead of being reset, so concurrent writers never silently lose entries.
 */
export async function openHarnessExperienceStore(
  home: string,
): Promise<HarnessExperienceStore> {
  const root = await privateDirectory(home);
  const directory = await privateDirectory(join(root, "harness-experiences"));
  const queues = new Map<string, Promise<void>>();
  const pathFor = (scope: HarnessExperienceScope): string =>
    join(directory, `${scopeHash(scope)}.json`);

  const load = async (
    path: string,
    scope: HarnessExperienceScope,
  ): Promise<readonly HarnessExperience[]> => {
    let raw: unknown;
    try {
      raw = await readJson(path, MAX_HARNESS_EXPERIENCE_BYTES);
    } catch (error) {
      // A missing record is an empty library; anything else is not readable.
      if (error instanceof ForgeError && error.code === "not_found") return [];
      throw storageError();
    }
    const parsed = experienceFileSchema.safeParse(raw);
    if (!parsed.success || !sameScope(parsed.data.scope, scope))
      throw storageError();
    return parsed.data.entries;
  };

  // Serialize within this store first so overlapping saves queue instead of
  // competing for the cross-process lock. The lock still covers other stores.
  const serialized = async <T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    queues.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
  };

  const locked = async <T>(
    path: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await fileLock(`${path}.lock`);
      } catch (error) {
        if (!(error instanceof ForgeError) || error.code !== "busy")
          throw storageError();
        await new Promise<void>((done) => setTimeout(done, 10));
        continue;
      }
      try {
        return await work();
      } finally {
        await release();
      }
    }
    throw new ForgeError(
      "busy",
      "Harness experiences are currently locked.",
      true,
    );
  };

  return {
    async list(
      requested: HarnessExperienceScope,
    ): Promise<readonly HarnessExperience[]> {
      const parsed = harnessExperienceScopeSchema.safeParse(requested);
      if (!parsed.success)
        throw invalid("Harness experience scope is invalid.");
      const scope = canonicalScope(parsed.data);
      await privateDirectory(directory);
      const entries = await load(pathFor(scope), scope);
      return entries.slice(-HARNESS_EXPERIENCE_LIST_LIMIT).reverse();
    },

    async save(requested: HarnessExperienceInput): Promise<HarnessExperience> {
      const parsed = harnessExperienceInputSchema.safeParse(requested);
      if (!parsed.success)
        throw invalid("Harness experience input is invalid.");
      const scope = canonicalScope(parsed.data.scope);
      const input: HarnessExperienceInput = { ...parsed.data, scope };
      const path = pathFor(scope);
      await privateDirectory(directory);
      return serialized(path, () =>
        locked(path, async () => {
          await privateDirectory(directory);
          const entries = await load(path, scope);
          const existing = entries.find(
            (entry) => entry.reportId === input.reportId,
          );
          if (existing) return existing;
          const candidate = harnessExperienceSchema.safeParse({
            ...input,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
          });
          if (!candidate.success)
            throw invalid("Harness experience input is invalid.");
          const retained = retainable(scope, [...entries, candidate.data]);
          const file = experienceFileSchema.safeParse({
            version: 1,
            scope,
            entries: retained,
          });
          if (!file.success)
            throw invalid("Harness experience input is invalid.");
          try {
            await atomicJson(path, file.data, MAX_HARNESS_EXPERIENCE_BYTES);
          } catch {
            throw storageError();
          }
          return candidate.data;
        }),
      );
    },
  };
}
