import { ForgeError } from "../shared/errors";
import { MCP_DISCOVERY_LIMIT, MCP_RESULT_LIMIT } from "./types";

export const MCP_TRUNCATION_MARKER =
  "\n[MCP output truncated: UTF-8 byte limit]";

export function boundedText(
  text: string,
  limit = MCP_RESULT_LIMIT,
): Readonly<{ text: string; truncated: boolean }> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit - Buffer.byteLength(MCP_TRUNCATION_MARKER);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(0, end).toString("utf8") + MCP_TRUNCATION_MARKER,
    truncated: true,
  };
}

export function checkDiscovery(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MCP_DISCOVERY_LIMIT)
    throw new ForgeError(
      "invalid_input",
      "MCP discovery exceeds the 256 KiB aggregate metadata budget.",
    );
}
