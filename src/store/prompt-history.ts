import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import { atomicJson, checkEntry, privateDirectory, readJson } from "./io";
import { fileLock } from "./lock";

const MAX_BYTES = 1_000_000;
const schema = z.object({ version: z.literal(1), entries: z.array(z.string().max(16000)).max(1000) }).strict();
/** Best-effort privacy filter, not a secret detector. Opt-in remains mandatory. */
export function historyEligible(text: string): boolean {
  return text.trim().length > 0 && text.length <= 16000 && !/^\s/.test(text) && !text.startsWith("/") &&
    !/^(?:y|yes|n|no)$/i.test(text.trim()) &&
    !/(?:api[_-]?key|password|secret|token|authorization|bearer|PRIVATE KEY|sk-[\w-]{8,}|gh[pousr]_[\w]{20,})/i.test(text) &&
    !Array.from(text).some(char => { const n = char.codePointAt(0) ?? 0; return (n < 32 && n !== 10 && n !== 9) || (n >= 127 && n <= 159); });
}
function bounded(entries: readonly string[]): string[] {
  const result: string[] = [];
  let bytes = 32;
  for (let i = entries.length - 1; i >= 0 && result.length < 1000; i--) {
    const text = entries[i];
    if (!text || !historyEligible(text) || result[0] === text) continue;
    const size = Buffer.byteLength(JSON.stringify(text)) + 1;
    if (bytes + size > MAX_BYTES) break;
    result.unshift(text); bytes += size;
  }
  return result;
}
export async function openPromptHistory(home: string, workspace: string) {
  const root = await privateDirectory(home);
  const directory = await privateDirectory(join(root, "prompt-history"));
  const key = createHash("sha256").update(await realpath(workspace)).digest("hex");
  const path = join(directory, `${key}.json`);
  const load = async (): Promise<string[]> => {
    await privateDirectory(directory);
    if (!(await checkEntry(path))) return [];
    const parsed = schema.safeParse(await readJson(path, MAX_BYTES));
    if (!parsed.success) throw new ForgeError("storage", "Prompt history is invalid; recording is disabled.");
    return bounded(parsed.data.entries);
  };
  return {
    load,
    async append(text: string): Promise<void> {
      if (!historyEligible(text)) return;
      await privateDirectory(directory);
      const release = await fileLock(`${path}.lock`);
      try { await atomicJson(path, { version: 1, entries: bounded([...(await load()), text]) }, MAX_BYTES); }
      finally { await release(); }
    },
    async clear(): Promise<void> {
      await privateDirectory(directory);
      const release = await fileLock(`${path}.lock`);
      try { await atomicJson(path, { version: 1, entries: [] }, MAX_BYTES); }
      finally { await release(); }
    },
  };
}
