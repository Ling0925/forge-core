import type { lstat } from "node:fs/promises";
import { ForgeError } from "../shared/errors";
import type { FileChange, JsonValue, ToolResult } from "../shared/schemas";

export function fail(
  message: string,
  code: "tool" | "invalid_input" = "tool",
): never {
  throw new ForgeError(code, message);
}
export function check(signal: AbortSignal): void {
  if (signal.aborted)
    throw new ForgeError("cancelled", "Tool execution cancelled.");
}
export function signature(info: Awaited<ReturnType<typeof lstat>>): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
export function result(
  value: JsonValue,
  isError = false,
  changes?: readonly FileChange[],
): ToolResult {
  return {
    content: JSON.stringify(value),
    isError,
    ...(changes === undefined ? {} : { changes }),
  };
}
export function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return undefined;
}
export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new ForgeError("cancelled", "Tool execution cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
