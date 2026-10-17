import { z } from "zod";

/**
 * Shared contract for the Web HTML preview. A preview document is untrusted
 * model- or user-authored HTML: it is served from its own response with a
 * restrictive CSP and is only ever framed with a sandbox attribute, so the
 * preview can never read the workbench, its session cookie or the filesystem.
 */
export const HTML_PREVIEW_MAX_BYTES = 1024 * 1024;

/** Document CSP: inline markup works, every network and top-level capability does not. */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  // Defence in depth for a document opened outside the framing workbench.
  "sandbox allow-scripts",
].join("; ");

const htmlExtensions = [".html", ".htm"] as const;

/** True for a workspace path whose final component is an HTML file. */
export function isHtmlPath(path: string): boolean {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const lower = withoutQuery.toLowerCase();
  return htmlExtensions.some((extension) => lower.endsWith(extension));
}

/** True for a fenced code block whose language tag is HTML. */
export function isHtmlLanguage(language: string): boolean {
  return /^(?:html|htm|xhtml)$/i.test(language.trim());
}

export const htmlPreviewRequestSchema = z
  .object({ html: z.string().max(HTML_PREVIEW_MAX_BYTES) })
  .strict()
  .readonly();
export type HtmlPreviewRequest = z.infer<typeof htmlPreviewRequestSchema>;

export const htmlPreviewResponseSchema = z
  .object({ url: z.string().regex(/^\/preview\/document\?id=[0-9a-f]{48}$/) })
  .strict()
  .readonly();
export type HtmlPreviewResponse = z.infer<typeof htmlPreviewResponseSchema>;
