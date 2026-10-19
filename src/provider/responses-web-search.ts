import { z } from "zod";
import { webSourceUrlSchema, type WebCitation, type WebSearchRecord } from "../shared/web-search";

export const urlCitation = z.object({
  type: z.literal("url_citation"),
  url: webSourceUrlSchema,
  title: z.string().max(4096),
  start_index: z.number().int().min(0).max(2000000),
  end_index: z.number().int().min(0).max(2000000),
}).passthrough().refine((value) => value.end_index >= value.start_index);

const action = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("search"),
    query: z.string().max(4096).optional(),
    queries: z.array(z.string().max(4096)).max(64).optional(),
    sources: z.array(z.object({ type: z.literal("url"), url: webSourceUrlSchema }).passthrough()).max(128).optional(),
  }).passthrough(),
  z.object({ type: z.literal("open_page"), url: webSourceUrlSchema.nullable().optional() }).passthrough(),
  z.object({ type: z.literal("find_in_page"), url: webSourceUrlSchema, pattern: z.string().max(4096) }).passthrough(),
]);
export const webSearchCall = z.object({
  type: z.literal("web_search_call"),
  id: z.string().min(1).max(256),
  status: z.enum(["completed", "failed", "incomplete"]),
  action,
}).passthrough();

export function searchRecord(item: z.infer<typeof webSearchCall>): WebSearchRecord {
  const a = item.action;
  return {
    id: item.id, status: item.status, action: a.type,
    ...(a.type === "search" ? {
      ...(a.queries ? { queries: a.queries } : a.query === undefined ? {} : { queries: [a.query] }),
      ...(a.sources ? { sources: a.sources.map((source) => source.url) } : {}),
    } : {
      ...(a.url ? { url: a.url } : {}),
      ...(a.type === "find_in_page" ? { pattern: a.pattern } : {}),
    }),
  };
}

export function citationRecord(item: z.infer<typeof urlCitation>, offset: number): WebCitation {
  return { url: item.url, title: item.title, startIndex: offset + item.start_index, endIndex: offset + item.end_index };
}
