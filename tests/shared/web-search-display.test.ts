import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { webSearchDetails } from "../../src/shared/web-search-display";
import { historyLines } from "../../src/cli/render/history";
import { createEventRenderer } from "../../src/cli/render/events";
import { reduceTimeline } from "../../src/renderer/state/timeline";
import { initialWorkbenchState, workbenchReducer } from "../../src/renderer/state/workbench-reducer";
import { shouldRefreshTranscript } from "../../src/renderer/state/refresh-events";
import { Markdown } from "../../src/renderer/components/workbench/Markdown";
import { StoredTranscript } from "../../src/renderer/components/workbench/Transcript";
import { runIdSchema } from "../../src/shared/ipc";
import { agentEventSchema, sessionSnapshotSchema, type AgentEvent } from "../../src/shared/schemas";

const citation = { url: "https://example.com/source", title: "Source", startIndex: 0, endIndex: 4 };
const message = { role: "assistant", content: "News", citations: [citation], webSearches: [{ id: "ws", status: "completed", action: "search", queries: ["news"], sources: [citation.url, "https://example.org/other"] }] } as const;
const session = sessionSnapshotSchema.parse({ version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "Test", workspace: "/workspace", model: "model", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "completed", messages: [message], events: [], changes: [] });
const text = (lines: readonly (readonly { text: string }[])[]) => lines.map((line) => line.map((span) => span.text).join("")).join("\n");
const resultEvent = agentEventSchema.parse({ type: "web_search_result", sessionId: session.id, timestamp: session.updatedAt, citations: message.citations, webSearches: message.webSearches });

it("renders persisted and live CLI sources without rewriting message text", () => {
  const before = JSON.stringify(session);
  expect(text(historyLines(session, 120))).toContain(citation.url);
  const renderer = createEventRenderer({ width: () => 120 });
  renderer.push({ type: "text_delta", sessionId: session.id, timestamp: session.updatedAt, text: "News" });
  const rendered = text(renderer.push(resultEvent).append);
  expect(rendered).toContain(citation.url);
  expect(rendered).toContain("引用来源");
  expect(rendered).toContain("未必被引用");
  expect(rendered.match(/News/g)).toHaveLength(1);
  expect(JSON.stringify(session)).toBe(before);
});

it("keeps renderer prose separate and makes safe source links clickable", () => {
  const item = reduceTimeline(session)[0];
  expect(item).toMatchObject({ kind: "message", content: "News" });
  if (item?.kind !== "message") throw Error("message");
  const markup = renderToStaticMarkup(createElement(Markdown, { source: item.webSearchDetails ?? "" }));
  expect(markup).toContain(`href="${citation.url}"`);
  expect(markup).toContain("检索来源");
  const stored = renderToStaticMarkup(createElement(StoredTranscript, { snapshot: session }));
  expect(stored).toContain(`href="${citation.url}"`);
  expect(stored).toContain("引用来源");
  expect(shouldRefreshTranscript("web_search_result")).toBe(true);
  expect(shouldRefreshTranscript("web_search")).toBe(false);
});

it("escapes malicious labels, suppresses unsafe URLs and bounds/deduplicates display", () => {
  const value = webSearchDetails({ citations: [
    { ...citation, title: "![evil](javascript:alert(1))<script>\u001b[31m &" },
    citation,
    { ...citation, url: "javascript:alert(1)" },
    { ...citation, url: "data:text/html,evil" },
    { ...citation, url: "https://user:password@example.com/" },
  ] });
  const markup = renderToStaticMarkup(createElement(Markdown, { source: value }));
  expect(markup).not.toContain("<script>");
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain('href="javascript:');
  expect(markup).not.toContain('href="data:');
  expect(markup).not.toContain("password");
  expect(value).not.toContain("\u001b");
  expect(markup.match(/<a /g)).toHaveLength(1);
  const many = webSearchDetails({ citations: Array.from({ length: 256 }, (_, i) => ({ ...citation, url: `https://example.com/${i}`, title: "X".repeat(4096) })) });
  expect(many.length).toBeLessThan(20000);
  expect(renderToStaticMarkup(createElement(Markdown, { source: many })).match(/<a /g)).toHaveLength(32);
});

it("stores progress only in live state and clears it at result/error boundaries", () => {
  const runId = runIdSchema.parse("33333333-3333-4333-8333-333333333333");
  let state = { ...initialWorkbenchState, activeSessionId: session.id, activeSnapshot: session, activeRuns: { [session.id]: { sessionId: session.id, runId, status: "running" as const, streamingText: "" } } };
  const receive = (event: AgentEvent) => { state = workbenchReducer(state, { type: "RUN_EVENT_RECEIVED", event: { runId, event } }) as typeof state; };
  const progress: AgentEvent = { type: "web_search", sessionId: session.id, timestamp: session.updatedAt, search: { id: "ws", status: "searching" } };
  receive(progress);
  expect(state.activeRuns[session.id]).toMatchObject({ webSearch: progress.search });
  expect(state.activeSnapshot).toBe(session);
  receive(resultEvent);
  expect(state.activeRuns[session.id]).not.toHaveProperty("webSearch", progress.search);
  receive(progress);
  receive({ type: "error", sessionId: session.id, timestamp: session.updatedAt, error: { code: "provider", message: "failed", retryable: false } });
  expect(state.activeRuns[session.id]).not.toHaveProperty("webSearch", progress.search);
});
