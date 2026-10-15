import type { ToolCall } from "./schemas";

/** Display-only best-effort masking, not a permission or secret-detection boundary. */
export function redactCommandArguments(command: readonly string[] = []): readonly string[] {
  let redactNext = false;
  return command.map(arg => {
    if (redactNext) { redactNext = false; return "[REDACTED]"; }
    if (/^--?(?:api[-_]?key|access[-_]?token|token|password|secret|authorization)$/i.test(arg)) {
      redactNext = true; return arg;
    }
    return arg
      .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
      .replace(/((?:api[-_]?key|token|password|secret|authorization)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
  });
}

/** Never forward file bodies, edit text, MCP arguments or tool output. */
export function toolActivity(call: ToolCall): { name: string; target: string } {
  let target = "";
  try {
    const args: unknown = JSON.parse(call.function.arguments);
    if (typeof args === "object" && args !== null) {
      if (call.function.name === "run_command" && "argv" in args && Array.isArray(args.argv)) {
        target = redactCommandArguments(args.argv.filter((a): a is string => typeof a === "string")).join(" ");
      } else if (["read_file", "write_file", "edit_file", "make_directory", "list_files"].includes(call.function.name)
        && "path" in args && typeof args.path === "string") target = args.path;
    }
  } catch { /* Malformed arguments still show the tool name. */ }
  return { name: call.function.name.slice(0, 256), target: target.slice(0, 1024) };
}
