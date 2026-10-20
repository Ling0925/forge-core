import { join } from "node:path";
import { ForgeError } from "../shared/errors";
import { toolHooksConfigSchema } from "../shared/tool-hooks";
import { atomicJson, privateDirectory, readJson } from "./io";
import { fileLock } from "./lock";

export async function openToolHooksStore(home: string) {
  const directory = await privateDirectory(home);
  const path = join(directory, "tool-hooks.json");
  const empty = { beforeTool: [], afterTool: [], toolError: [], runEnd: [] };
  return {
    async get() {
      let raw: unknown;
      try { raw = await readJson(path, 1024 * 1024); }
      catch (error) {
        if (error instanceof ForgeError && error.code === "not_found") return toolHooksConfigSchema.parse(empty);
        throw error;
      }
      const parsed = toolHooksConfigSchema.safeParse(raw);
      if (!parsed.success) throw new ForgeError("storage", "Invalid tool-hooks.json; correct it with forge hooks set or clear.");
      return parsed.data;
    },
    async set(value: unknown) {
      const parsed = toolHooksConfigSchema.safeParse(value);
      if (!parsed.success) throw new ForgeError("invalid_input", "Invalid hook configuration; see docs/TOOL_HOOKS.md.");
      const release = await fileLock(join(directory, "tool-hooks.lock"));
      try { await atomicJson(path, parsed.data, 1024 * 1024); }
      finally { await release(); }
      return parsed.data;
    },
  };
}
