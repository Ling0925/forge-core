import { ForgeError } from "../../../shared/errors";

/** BrowserCommandResult.text is capped by the shared schema at 24,000 chars. */
const RESULT_TEXT_LIMIT = 24_000;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const cancelled = (): ForgeError =>
  new ForgeError("cancelled", "Browser operation cancelled.");

const invalidResult = (): ForgeError =>
  new ForgeError("tool", "agent-browser returned an invalid MCP tool result.");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets)
    if (secret) result = result.split(secret).join("[REDACTED]");
  return result;
}

export function boundText(text: string): string {
  if (text.length <= RESULT_TEXT_LIMIT) return text;
  const marker = "\n[Browser output truncated]";
  let end = RESULT_TEXT_LIMIT - marker.length;
  // Never split a surrogate pair; the schema counts UTF-16 code units.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${marker}`;
}

function cleanText(text: string, secrets: readonly string[]): string {
  return boundText(redact(text, secrets));
}

export function requireNonEmptyResult(
  value: string,
  secrets: readonly string[],
): string {
  const text = cleanText(value.trim(), secrets);
  return text.length ? text : "Browser command completed.";
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * Project one native MCP tools/call result. The raw response is kept so a
 * private screenshot is not truncated by the 48 KiB rich-content cap; the
 * model-facing text is reduced to the tool's real payload instead of echoing
 * agent-browser's duplicated stdout/lifecycle JSON.
 */
export function parseToolResult(
  raw: Readonly<Record<string, unknown>>,
): ToolResult {
  const content = raw.content;
  if (!Array.isArray(content)) throw invalidResult();
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) throw invalidResult();
    const type = textValue(item.type);
    if (type === "text") {
      const text = textValue(item.text);
      if (text === undefined) throw invalidResult();
      parts.push(text);
      continue;
    }
    // Images are read only from the private screenshot path. Other rich
    // content is outside the shared browser command contract.
    if (
      type !== "image" &&
      type !== "resource" &&
      type !== "resource_link" &&
      type !== "audio"
    )
      throw invalidResult();
  }
  const structured = isRecord(raw.structuredContent)
    ? raw.structuredContent
    : undefined;
  const response =
    structured && isRecord(structured.response)
      ? structured.response
      : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const upstreamError =
    response && response.success === false
      ? (textValue(response.error) ?? "agent-browser reported an error.")
      : undefined;
  let text = upstreamError;
  if (data && text === undefined) {
    for (const key of [
      "snapshot",
      "content",
      "text",
      "value",
      "url",
      "title",
      "path",
    ]) {
      const candidate = textValue(data[key]);
      if (candidate) {
        text = candidate;
        break;
      }
    }
    if (text === undefined) {
      if (typeof data.closed === "boolean")
        text = data.closed
          ? "Browser closed."
          : "Browser close was not confirmed.";
      else if (typeof data.clicked === "string")
        text = `Clicked ${data.clicked}.`;
      else if (typeof data.filled === "string") text = `Filled ${data.filled}.`;
      else if (typeof data.pressed === "string")
        text = `Pressed ${data.pressed}.`;
      else if (data.scrolled === true) text = "Scrolled.";
    }
  }
  if (text === undefined) text = parts.join("\n");
  return {
    text: text.trim(),
    isError: raw.isError === true || upstreamError !== undefined,
  };
}

export function imageMimeType(
  data: Buffer,
): "image/png" | "image/jpeg" | undefined {
  if (
    data.length >= PNG_SIGNATURE.length &&
    data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    return "image/png";
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "image/jpeg";
  return undefined;
}
