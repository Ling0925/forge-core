import { protocol } from "./errors";

export const MAX_PROVIDER_JSON_CHARS = 8_000_000;

// Bound unknown metadata before parsing; braces inside JSON strings do not nest.
export function parseProviderJson(text: string): unknown {
  if (text.length > MAX_PROVIDER_JSON_CHARS) throw protocol("output_limit");
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
      if (depth > 64) throw protocol("invalid_json");
    } else if (char === "}" || char === "]") depth -= 1;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw protocol("invalid_json");
  }
}
