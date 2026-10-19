import { z } from "zod";

export const webSearchModeSchema = z.enum(["disabled", "cached", "live"]);
export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

// These are display links, never permission grants or automatic fetch targets.
export const webSourceUrlSchema = z.string().max(4096).url().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value);
  } catch { return false; }
}, "Expected an HTTP(S) source URL without credentials or control characters");

export const webCitationSchema = z.object({
  url: webSourceUrlSchema,
  title: z.string().max(4096),
  startIndex: z.number().int().min(0).max(2000000),
  endIndex: z.number().int().min(0).max(2000000),
}).strict().refine((value) => value.endIndex >= value.startIndex).readonly();
export type WebCitation = z.infer<typeof webCitationSchema>;

export const webSearchProgressSchema = z.object({
  id: z.string().min(1).max(256),
  status: z.enum(["in_progress", "searching", "completed", "failed", "incomplete"]),
}).strict().readonly();
export type WebSearchProgress = z.infer<typeof webSearchProgressSchema>;

// Provider-owned operations are not local function calls and have no tool output
// to fabricate. Persist this bounded projection alongside opaque providerState.
export const webSearchRecordSchema = z.object({
  id: z.string().min(1).max(256),
  status: z.enum(["completed", "failed", "incomplete"]),
  action: z.enum(["search", "open_page", "find_in_page"]),
  queries: z.array(z.string().max(4096)).max(64).readonly().optional(),
  url: webSourceUrlSchema.optional(),
  pattern: z.string().max(4096).optional(),
  sources: z.array(webSourceUrlSchema).max(128).readonly().optional(),
}).strict().readonly();
export type WebSearchRecord = z.infer<typeof webSearchRecordSchema>;
