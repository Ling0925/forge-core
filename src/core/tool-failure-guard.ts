import type { ToolCall, ToolResult } from "../shared/schemas";
import { ForgeError } from "../shared/errors";

/** Bound repeated model-generated retries without replaying or hiding tool effects. */
export function createToolFailureGuard() {
  const failures: { key: string; path: string | undefined; result: string; count: number }[] = [];
  return (call: ToolCall, result: ToolResult): void => {
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); }
    catch { args = call.function.arguments; }
    const canonical = JSON.stringify(args, (_key, value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      return value;
    });
    const key = `${call.function.name}:${canonical}`;
    const path = args && typeof args === "object" && "path" in args && typeof args.path === "string" ? args.path : undefined;
    if (!result.isError) {
      for (let i = failures.length - 1; i >= 0; i--) {
        const item = failures[i];
        if (item && (item.key === key || result.changes?.some(change => change.path === item.path)))
          failures.splice(i, 1);
      }
      return;
    }
    const previous = failures.find(item => item.key === key && item.result === result.content);
    if (previous) {
      previous.count += 1;
      if (previous.count >= 3)
        throw new ForgeError("tool", `Stopped after three identical failures from ${call.function.name}. The same arguments cannot make progress; inspect the recorded error and change the approach before continuing.`);
    } else {
      if (failures.length >= 8) failures.shift();
      failures.push({ key, path, result: result.content, count: 1 });
    }
  };
}
