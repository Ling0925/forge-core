import { protocol, type ProviderStage } from "./errors";

export const MAX_PROVIDER_JSON_CHARS = 8_000_000;

// Bound unknown metadata before parsing; braces inside JSON strings do not nest.
export function parseProviderJson(text: string, stage: ProviderStage = "json_response"): unknown {
  const invalid = stage === "tool_arguments" ? "invalid_tool_call" : "invalid_json";
  if (text.length > MAX_PROVIDER_JSON_CHARS) throw protocol("output_limit", { stage,
    observed: text.length, limit: MAX_PROVIDER_JSON_CHARS, unit: "utf16_code_units" });
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > 64) throw protocol(invalid, { stage, observed: depth, limit: 64, unit: "nesting_depth" });
    } else if (char === "}" || char === "]") depth -= 1;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw protocol(invalid, { stage });
  }
}
