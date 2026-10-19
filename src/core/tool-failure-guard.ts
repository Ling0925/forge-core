import type { ToolCall, ToolResult } from "../shared/schemas";
import { ForgeError } from "../shared/errors";

/** Bound repeated model-generated retries without replaying or hiding tool effects. */
export function createToolFailureGuard() {
  const failures: { key: string; tool: string; path: string | undefined; invalidInput: boolean; result: string; count: number }[] = [];
  return (call: ToolCall, result: ToolResult): void => {
    let args: unknown;
    try { args = JSON.parse(call.function.arguments); }
    catch { args = call.function.arguments; }
    const canonical = JSON.stringify(args, (_key, value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      return value;
    });
    const path = args && typeof args === "object" && "path" in args && typeof args.path === "string" ? args.path : undefined;
    let error: unknown;
    try { error = JSON.parse(result.content); }
    catch { error = undefined; }
    const invalidInput = result.isError && error !== null && typeof error === "object" && "code" in error && error.code === "invalid_input";
    const key = `${call.function.name}:${invalidInput ? `invalid_input:${path ?? ""}` : canonical}`;
    if (!result.isError) {
      for (let i = failures.length - 1; i >= 0; i--) {
        const item = failures[i];
        if (item && (item.key === key || (item.invalidInput && item.tool === call.function.name && item.path === path) || result.changes?.some(change => change.path === item.path)))
          failures.splice(i, 1);
      }
      return;
    }
    const previous = failures.find(item => item.key === key && item.result === result.content);
    if (previous) {
      previous.count += 1;
      if (previous.count >= 3)
        throw new ForgeError("tool", `Stopped after three identical failures from ${call.function.name}. ${invalidInput ? "Changing unrelated arguments does not fix this validation error; correct the reported field or use the indicated tool." : "The same arguments cannot make progress; inspect the recorded error and change the approach before continuing."}`);
    } else {
      if (failures.length >= 8) failures.shift();
      failures.push({ key, tool: call.function.name, path, invalidInput, result: result.content, count: 1 });
    }
  };
}
