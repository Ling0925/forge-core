import { Worker } from "node:worker_threads";
import { ForgeError } from "../shared/errors";

export function globMatcher(pattern?: string): (path: string) => boolean {
  if (pattern === undefined) return () => true;
  if (pattern.startsWith("/") || pattern.includes("\\") || pattern.includes("\0") ||
      pattern.split("/").some(part => part === ".." || part === "")) {
    throw new ForgeError("tool", "glob must be a relative file pattern using *, ** and ?.");
  }
  const parts = pattern.replace(/^\.\//, "").split("/");
  // Dynamic programming avoids running a user-generated regex on the main thread.
  function component(pattern: string, value: string): boolean {
    let row = Array<boolean>(value.length + 1).fill(false);
    row[0] = true;
    for (const token of pattern) {
      const next = Array<boolean>(value.length + 1).fill(false);
      next[0] = token === "*" && row[0] === true;
      for (let i = 1; i <= value.length; i += 1) {
        next[i] = token === "*" ? row[i] === true || next[i - 1] === true
          : row[i - 1] === true && (token === "?" || token === value[i - 1]);
      }
      row = next;
    }
    return row[value.length] === true;
  }
  return path => {
    const names = path.split("/");
    let row = Array<boolean>(names.length + 1).fill(false);
    row[0] = true;
    for (const part of parts) {
      const next = Array<boolean>(names.length + 1).fill(false);
      next[0] = part === "**" && row[0] === true;
      for (let i = 1; i <= names.length; i += 1) {
        next[i] = part === "**" ? row[i] === true || next[i - 1] === true
          : row[i - 1] === true && component(part, names[i - 1] ?? "");
      }
      row = next;
    }
    return row[names.length] === true;
  };
}

export interface LineHit { readonly index: number; readonly column: number }
interface ScanResult {
  readonly hits: readonly LineHit[];
  readonly count: number;
  readonly complete: boolean;
}
// Self-contained so the same bounded scan can execute inside the regex worker.
function scanLines(text: string, query: string | RegExp, insensitive: boolean,
  skip: number, limit: number, first: boolean): ScanResult {
  const hits: LineHit[] = [];
  let count = 0;
  const needle = typeof query === "string" && insensitive ? query.toLowerCase() : query;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const column = typeof needle === "string"
      ? (insensitive ? line.toLowerCase() : line).indexOf(needle)
      : (needle.exec(line)?.index ?? -1);
    if (column < 0) continue;
    count += 1;
    if (count > skip && hits.length < limit) hits.push({ index, column });
    if (first || (limit > 0 && hits.length >= limit)) {
      return { hits, count, complete: index === lines.length - 1 };
    }
  }
  return { hits, count, complete: true };
}

export function createLineMatcher(query: string, regex: boolean, caseSensitive: boolean,
  signal: AbortSignal) {
  let worker: Worker | undefined;
  let deadline = 0;
  if (regex) {
    // Reject costly/unsupported constructs before compilation. The worker deadline
    // remains authoritative for patterns that pass this deliberately small subset.
    if (query.length > 512 || /\\[1-9]|\\k<|\(\?|\)[*+?{]/.test(query) ||
        (query.match(/[|({]/g)?.length ?? 0) > 64 || /\{\d{5,}/.test(query)) {
      throw new ForgeError("tool", "Regex is too complex; simplify it or use literal search.");
    }
  }
  return {
    async find(text: string, skip: number, limit: number, first = false): Promise<ScanResult> {
      if (signal.aborted) throw new ForgeError("cancelled", "Tool execution cancelled.");
      if (!regex) return scanLines(text, query, !caseSensitive, skip, limit, first);
      if (!worker) {
        // Static source avoids bundler-injected function-name helpers. Compile
        // only on request, after find has installed its response listeners.
        worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          parentPort.on('message', ({ text, skip, limit, first }) => {
            let expression;
            try { expression = new RegExp(workerData.query, workerData.caseSensitive ? '' : 'i'); }
            catch { parentPort.postMessage({ error: 'Invalid regex.' }); return; }
            const lines = text.split('\\n');
            const hits = [];
            let count = 0;
            for (let index = 0; index < lines.length; index += 1) {
              const match = expression.exec(lines[index]);
              if (!match) continue;
              count += 1;
              if (count > skip && hits.length < limit) hits.push({ index, column: match.index });
              if (first || (limit > 0 && hits.length >= limit)) {
                parentPort.postMessage({ hits, count, complete: index === lines.length - 1 });
                return;
              }
            }
            parentPort.postMessage({ hits, count, complete: true });
          });
        `, { eval: true, workerData: { query, caseSensitive },
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
        // Keep an observer installed during filesystem reads between find calls.
        worker.on("error", () => { deadline = 0; });
        worker.on("exit", () => { deadline = 0; });
        deadline = Date.now() + 3000;
      }
      const current = worker;
      return new Promise<ScanResult>((resolve, reject) => {
        const finish = (error?: ForgeError, value?: ScanResult) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          current.removeListener("message", message);
          current.removeListener("error", failed);
          current.removeListener("exit", exited);
          if (error) reject(error);
          else if (value) resolve(value);
        };
        const failed = () => finish(new ForgeError("tool", "Regex worker failed within its resource limit."));
        const exited = () => failed();
        const abort = () => finish(new ForgeError("cancelled", "Tool execution cancelled."));
        const message = (value: ScanResult & { error?: string }) => {
          if (value.error) finish(new ForgeError("tool", value.error));
          else finish(undefined, value);
        };
        const timer = setTimeout(() => finish(new ForgeError("tool", "Regex deadline exceeded; simplify the pattern.")),
          Math.max(1, Math.min(1000, deadline - Date.now())));
        current.once("message", message);
        current.once("error", failed);
        current.once("exit", exited);
        signal.addEventListener("abort", abort, { once: true });
        current.postMessage({ text, skip, limit, first });
      });
    },
    async dispose(): Promise<void> { if (worker) { await worker.terminate(); worker = undefined; } },
  };
}

export function relativeQueryPath(root: string, path: string): string {
  return root === "." ? path : path === root ? path.split("/").at(-1) ?? path : path.slice(root.length + 1);
}

export function pageEntries<T>(values: readonly T[], offset: number, limit: number) {
  const entries: T[] = [];
  let length = 0;
  for (const value of values.slice(offset, offset + limit)) {
    length += JSON.stringify(value).length;
    if (length > 90000) break;
    entries.push(value);
  }
  const next = offset + entries.length;
  return { entries, offset, next_offset: next < values.length ? next : null,
    truncated: next < values.length };
}
