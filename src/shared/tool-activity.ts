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

// Scalar keys surfaced as a tool's human-readable target, in priority order.
const targetKeys = ["path", "argv", "command", "query", "url", "id", "cwd"];

/** Never forward file bodies, edit text, MCP arguments or tool output. Only a
 * bounded scalar target is surfaced; an unmatched payload adds nothing rather
 * than dumping raw JSON onto the activity line. */
export function toolActivity(call: ToolCall): { name: string; target: string } {
  let target = "";
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    if (typeof parsed === "object" && parsed !== null) {
      const args = parsed as Record<string, unknown>;
      if (call.function.name === "run_command" && Array.isArray(args.argv)) {
        const argv = args.argv.filter((a): a is string => typeof a === "string");
        target = redactCommandArguments(argv).join(" ");
      } else {
        for (const key of targetKeys) {
          const field = args[key];
          if (typeof field === "string" && field) { target = field; break; }
          if (Array.isArray(field)) {
            const parts = field.filter((a): a is string => typeof a === "string");
            if (parts.length) { target = parts.join(" "); break; }
          }
        }
      }
    }
  } catch { /* Malformed arguments still show the tool name. */ }
  return { name: call.function.name.slice(0, 256), target: target.slice(0, 1024) };
}

/** Redacted command line and working directory for a command tool's expanded
 * evidence. Returns empties for non-command tools or malformed arguments. */
export function commandActivity(call: ToolCall): { command: string; cwd: string } {
  let command = "";
  let cwd = "";
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    if (typeof parsed === "object" && parsed !== null) {
      const args = parsed as Record<string, unknown>;
      const argv = Array.isArray(args.argv)
        ? args.argv.filter((a): a is string => typeof a === "string")
        : typeof args.command === "string"
          ? [args.command]
          : [];
      command = redactCommandArguments(argv).join(" ");
      if (typeof args.cwd === "string") cwd = args.cwd;
    }
  } catch { /* Expanded view simply omits the command. */ }
  return { command: command.slice(0, 4096), cwd: cwd.slice(0, 2048) };
}
