import { expect, it } from "vitest";
import {
  webSearchDetails,
  webSearchStatus,
} from "../../src/shared/web-search-display";

const citation = {
  url: "https://example.com/source",
  title: "Source",
  startIndex: 0,
  endIndex: 4,
};

it("projects citations and search records without mutating the persisted payload", () => {
  const message = {
    citations: [citation],
    webSearches: [
      {
        id: "ws",
        status: "completed" as const,
        action: "search" as const,
        queries: ["news"],
        sources: [citation.url, "https://example.org/other"],
      },
    ],
  };
  const before = JSON.stringify(message);
  const details = webSearchDetails(message);
  expect(details).toContain(citation.url);
  expect(details).toContain("### 引用来源");
  expect(details).toContain("### 检索来源（未必被引用）");
  expect(details).toContain("https://example.org/other");
  expect(JSON.stringify(message)).toBe(before);
  expect(webSearchStatus({ id: "ws", status: "searching" })).toContain(
    "搜索中",
  );
});

it("escapes malicious labels, suppresses unsafe URLs and bounds/deduplicates display", () => {
  const value = webSearchDetails({
    citations: [
      {
        ...citation,
        title: "![evil](javascript:alert(1))<script>\u001b[31m &",
      },
      citation,
      { ...citation, url: "javascript:alert(1)" },
      { ...citation, url: "data:text/html,evil" },
      { ...citation, url: "https://user:password@example.com/" },
    ],
  });
  expect(value).not.toContain("<script>");
  expect(value).not.toContain("](<javascript:");
  expect(value).not.toContain("](<data:");
  expect(value).not.toContain("user:password");
  expect(value).not.toContain("\u001b");
  expect(value.match(/\]\(</g)).toHaveLength(1);
  const many = webSearchDetails({
    citations: Array.from({ length: 256 }, (_, index) => ({
      ...citation,
      url: `https://example.com/${index}`,
      title: "X".repeat(4096),
    })),
  });
  expect(many.length).toBeLessThan(20000);
  expect(many.match(/\]\(</g)).toHaveLength(32);
});
