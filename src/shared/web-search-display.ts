import { webSourceUrlSchema, type WebCitation, type WebSearchRecord, type WebSearchProgress } from "./web-search";

const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 256);
const label = (value: string) => plain(value).replace(/[\\`*_{}\[\]()<>!#|&~]/g, (char) => `&#${char.charCodeAt(0)};`);
const link = (value: string): string | undefined => {
  if (!webSourceUrlSchema.safeParse(value).success) return undefined;
  return new URL(value).href.replace(/[()<>"'\\`]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
};

export function webSearchStatus(search: WebSearchProgress): string {
  const status = { in_progress: "开始", searching: "搜索中", completed: "完成", failed: "失败", incomplete: "未完成" }[search.status];
  return `原生网页搜索 · ${status}`;
}

/** Display projection only. Never rewrite assistant content or providerState. */
export function webSearchDetails(value: {
  readonly citations?: readonly WebCitation[];
  readonly webSearches?: readonly WebSearchRecord[];
}): string {
  const lines: string[] = [];
  const searches = (value.webSearches ?? []).slice(0, 16);
  if (searches.length) {
    lines.push("### 原生网页搜索");
    for (const search of searches) {
      const target = search.action === "search" ? search.queries?.slice(0, 3).join("; ") : search.url;
      lines.push(`- ${label(search.action)} · ${label(search.status)}${target ? ` · ${label(target)}` : ""}`);
    }
    if ((value.webSearches?.length ?? 0) > searches.length) lines.push("- 更多搜索记录保留在会话中。");
  }
  const cited = new Set<string>();
  const sources: string[] = [];
  for (const citation of (value.citations ?? []).slice(0, 256)) {
    const url = link(citation.url);
    if (!url || cited.has(url) || sources.length >= 32) continue;
    cited.add(url);
    sources.push(`${sources.length + 1}. [${label(citation.title) || "来源"}](<${url}>)`);
  }
  if (sources.length) lines.push("### 引用来源", ...sources);
  const consulted: string[] = [];
  for (const search of (value.webSearches ?? []).slice(0, 128)) {
    for (const value of [...(search.sources ?? []).slice(0, 128), ...(search.url ? [search.url] : [])]) {
      const url = link(value);
      if (!url || cited.has(url) || consulted.length >= 32) continue;
      cited.add(url);
      consulted.push(`- [${label(new URL(url).hostname)}](<${url}>)`);
    }
  }
  if (consulted.length) lines.push("### 检索来源（未必被引用）", ...consulted);
  if ((value.citations?.length ?? 0) > 32) lines.push("完整引用记录保留在会话中；此处最多显示 32 个不同来源。");
  return lines.length ? `\n\n${lines.join("\n")}\n` : "";
}
