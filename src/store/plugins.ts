import { join } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import { pluginIdSchema } from "../shared/plugins";
import { jsonObjectSchema } from "../shared/schemas";
import { atomicJson, privateDirectory, readJson } from "./io";
import { fileLock } from "./lock";

const entrySchema = z
  .object({
    enabled: z.boolean(),
    config: jsonObjectSchema,
    revision: z.number().int().nonnegative().safe(),
  })
  .strict()
  .readonly();
const storeSchema = z
  .object({
    version: z.literal(1),
    plugins: z
      .record(pluginIdSchema, entrySchema)
      .refine((value) => Object.keys(value).length <= 64),
  })
  .strict();
export type PluginEntry = z.infer<typeof entrySchema>;

/** Host-owned configuration only. No workspace discovery, executable imports or installation. */
export async function openPluginStore(home: string) {
  const directory = await privateDirectory(home);
  const path = join(directory, "plugins.json");
  const read = async () => {
    try {
      const parsed = storeSchema.safeParse(await readJson(path, 128 * 1024));
      if (!parsed.success)
        throw new ForgeError(
          "storage",
          "Invalid plugins.json; correct the plugin configuration.",
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof ForgeError && error.code === "not_found")
        return storeSchema.parse({ version: 1, plugins: {} });
      throw error;
    }
  };
  return {
    async get(id: string): Promise<PluginEntry | undefined> {
      return (await read()).plugins[pluginIdSchema.parse(id)];
    },
    async update(
      id: string,
      change: (
        previous: PluginEntry | undefined,
      ) => Omit<PluginEntry, "revision">,
    ): Promise<PluginEntry> {
      pluginIdSchema.parse(id);
      const release = await fileLock(join(directory, "plugins.lock"));
      try {
        const state = await read();
        const previous = state.plugins[id];
        const next = change(previous);
        if (
          previous &&
          previous.enabled === next.enabled &&
          JSON.stringify(previous.config) === JSON.stringify(next.config)
        )
          return previous;
        const entry = entrySchema.parse({
          ...next,
          revision: (previous?.revision ?? 0) + 1,
        });
        await atomicJson(
          path,
          storeSchema.parse({
            ...state,
            plugins: { ...state.plugins, [id]: entry },
          }),
          128 * 1024,
        );
        return entry;
      } finally {
        await release();
      }
    },
  };
}
