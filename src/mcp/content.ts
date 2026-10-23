import { z } from "zod";
import {
  type McpContent,
  type McpToolOutcome,
  mcpContentSchema,
} from "../shared/mcp";
import { boundedText } from "./bounds";

const resultSchema = z.object({
  content: z.array(mcpContentSchema).max(256),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
});
const richLimit = 48 * 1024;

function redactText(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets)
    if (secret) text = text.split(secret).join("[REDACTED]");
  return text;
}

function redactRecord(
  value: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactText(key, secrets),
      redact(item, secrets),
    ]),
  );
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(redact(key, secrets)),
        redact(item, secrets),
      ]),
    );
  }
  return value;
}

function redactContent(
  item: McpContent,
  secrets: readonly string[],
): McpContent {
  const annotations =
    item.annotations === undefined
      ? {}
      : { annotations: redactRecord(item.annotations, secrets) };
  switch (item.type) {
    case "text":
      return { ...item, ...annotations, text: redactText(item.text, secrets) };
    case "image":
    case "audio":
      return {
        ...item,
        ...annotations,
        mimeType: redactText(item.mimeType, secrets),
      };
    case "resource_link":
      return {
        ...item,
        ...annotations,
        uri: redactText(item.uri, secrets),
        name: redactText(item.name, secrets),
        ...(item.title === undefined
          ? {}
          : { title: redactText(item.title, secrets) }),
        ...(item.description === undefined
          ? {}
          : { description: redactText(item.description, secrets) }),
        ...(item.mimeType === undefined
          ? {}
          : { mimeType: redactText(item.mimeType, secrets) }),
      };
    case "resource":
      return {
        ...item,
        ...annotations,
        resource: {
          ...item.resource,
          uri: redactText(item.resource.uri, secrets),
          ...(item.resource.mimeType === undefined
            ? {}
            : { mimeType: redactText(item.resource.mimeType, secrets) }),
          ...(item.resource.annotations === undefined
            ? {}
            : {
                annotations: redactRecord(item.resource.annotations, secrets),
              }),
          ...("text" in item.resource
            ? { text: redactText(item.resource.text, secrets) }
            : {}),
        },
      };
  }
}

function projection(item: McpContent): string {
  switch (item.type) {
    case "text":
      return item.text;
    case "image":
    case "audio":
      return `[MCP ${item.type}: ${item.mimeType}]`;
    case "resource_link":
      return `[MCP resource: ${item.name}] ${item.uri}${item.description ? `\n${item.description}` : ""}`;
    case "resource":
      return "text" in item.resource
        ? `${item.resource.uri}\n${item.resource.text}`
        : `[MCP resource: ${item.resource.uri}]`;
  }
}

export function toolOutcome(
  raw: unknown,
  secrets: readonly string[],
): McpToolOutcome {
  const parsed = resultSchema.parse(raw);
  const binarySafe = parsed.content.filter((item) => {
    const data =
      item.type === "image" || item.type === "audio"
        ? item.data
        : item.type === "resource" && "blob" in item.resource
          ? item.resource.blob
          : undefined;
    return (
      data === undefined ||
      !secrets.some(
        (secret) =>
          secret &&
          (data.includes(secret) ||
            Buffer.from(data, "base64").includes(Buffer.from(secret))),
      )
    );
  });
  const clean = {
    content: binarySafe.map((item) => redactContent(item, secrets)),
    isError: parsed.isError,
    structuredContent:
      parsed.structuredContent === undefined
        ? undefined
        : redactRecord(parsed.structuredContent, secrets),
  };
  const rich =
    clean.structuredContent !== undefined ||
    clean.content.some(
      (item) => item.type !== "text" || item.annotations !== undefined,
    ) ||
    binarySafe.length !== parsed.content.length;
  const text = clean.content.map(projection).join("\n");
  if (!rich) {
    const bounded = boundedText(text);
    return { ...bounded, isError: clean.isError === true || bounded.truncated };
  }
  let truncated = binarySafe.length !== parsed.content.length;
  let structuredContent = clean.structuredContent;
  if (
    structuredContent &&
    Buffer.byteLength(JSON.stringify(structuredContent)) > richLimit / 2
  ) {
    structuredContent = undefined;
    truncated = true;
  }
  const content: McpContent[] = [];
  let used = Buffer.byteLength(JSON.stringify(structuredContent ?? {}));
  for (const item of clean.content) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (used + size > richLimit / 2) {
      truncated = true;
      continue;
    }
    content.push(item);
    used += size;
  }
  const projected = `${text}${structuredContent ? `\n${JSON.stringify(structuredContent)}` : ""}${truncated ? "\n[MCP content omitted: size limit or private data]" : ""}`;
  // JSON escaping may expand text by up to six bytes per UTF-8 byte.
  const bounded = boundedText(
    projected,
    Math.floor((richLimit - used - 1024) / 6),
  );
  truncated ||= bounded.truncated;
  return {
    text: bounded.text,
    isError: clean.isError === true || truncated,
    truncated,
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}
