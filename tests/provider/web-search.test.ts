import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createModelProvider } from "../../src/provider/openai";
import { openSessionStore } from "../../src/store/sessions";
import { openSettingsStore } from "../../src/store/settings";
import type { Message, ProviderConfig } from "../../src/shared/schemas";
import type { WebSearchProgress } from "../../src/shared/web-search";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    const done = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await done;
  }
});
const wire = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const citation = { type: "url_citation", url: "https://example.com/news", title: "News", start_index: 0, end_index: 4 };
const search = {
  type: "web_search_call", id: "ws_1", status: "completed",
  action: { type: "search", queries: ["current news"], sources: [{ type: "url", url: citation.url }] },
};
const message = (id = "m_1", text = "News.", annotations: unknown[] = [citation]) => ({
  id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations }],
});
const finish = (output: unknown[]) => wire("response.completed", { response: { id: "r_1", status: "completed", output } });
function messageStream(index: number, value: ReturnType<typeof message>) {
  const part = value.content[0]!;
  return wire("response.output_item.added", { output_index: index, item: { id: value.id, type: "message", role: "assistant", status: "in_progress", content: [] } })
    + wire("response.output_text.delta", { item_id: value.id, output_index: index, content_index: 0, delta: part.text })
    + part.annotations.map((annotation, annotation_index) => wire("response.output_text.annotation.added", { item_id: value.id, output_index: index, content_index: 0, annotation_index, annotation })).join("")
    + wire("response.output_text.done", { item_id: value.id, output_index: index, content_index: 0, text: part.text })
    + wire("response.output_item.done", { output_index: index, item: value });
}
function searchStream(value: object = search, index = 0, id = "ws_1") {
  return wire("response.output_item.added", { output_index: index, item: { type: "web_search_call", id, status: "in_progress" } })
    + wire("response.web_search_call.in_progress", { output_index: index, item_id: id })
    + wire("response.web_search_call.searching", { output_index: index, item_id: id })
    + wire("response.web_search_call.completed", { output_index: index, item_id: id })
    + wire("response.output_item.done", { output_index: index, item: value });
}
function answer() { const m = message(); return searchStream() + messageStream(1, m) + finish([search, m]); }
async function fixture(data: string, status = 200, apiMode: ProviderConfig["apiMode"] = "responses") {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    bodies.push(JSON.parse(body));
    response.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
    response.end(data);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const config = { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "", requestTimeoutMs: 2000, apiMode };
  return { bodies, config, provider: createModelProvider(config) };
}
const options = () => ({ model: "model", signal: new AbortController().signal, onText: () => {}, webSearch: "live" as const });
const prompt: Message = { role: "user", content: "Search the news" };

it.each(["live", "cached"] as const)("declares native %s search, preserves annotations/records and emits distinct progress", async (webSearch) => {
  const f = await fixture(answer());
  const progress: WebSearchProgress[] = [];
  const text: string[] = [];
  const onToolCall = vi.fn();
  const result = await f.provider.complete([prompt], [], { ...options(), webSearch, onWebSearch: (p) => progress.push(p), onText: (t) => text.push(t), onToolCall });
  expect(f.bodies[0]).toMatchObject({ tools: [{ type: "web_search", external_web_access: webSearch === "live" }], store: false, include: ["reasoning.encrypted_content", "web_search_call.action.sources"] });
  expect(result.message.content).toBe("News.");
  expect(text.join("")).toBe("News.");
  expect(result.message.citations).toEqual([{ url: citation.url, title: "News", startIndex: 0, endIndex: 4 }]);
  expect(result.message.webSearches).toEqual([{ id: "ws_1", action: "search", status: "completed", queries: ["current news"], sources: [citation.url] }]);
  expect(result.message.providerState?.output).toEqual([search, message()]);
  expect(result.message.tool_calls).toBeUndefined();
  expect(onToolCall).not.toHaveBeenCalled();
  expect(progress.map((p) => p.status)).toEqual(["in_progress", "searching", "completed"]);
});

it("replays provider-owned search and citations exactly after persistence and a new adapter instance", async () => {
  const f = await fixture(answer());
  const root = await mkdtemp(join(tmpdir(), "forge-native-search-"));
  try {
    const result = await f.provider.complete([prompt], [], options());
    const store = await openSessionStore(root);
    const session = await store.create({ workspace: root, model: "model", title: "Search" });
    await store.save({ ...session, messages: [prompt, result.message] });
    const saved = await store.get(session.id);
    expect(saved.messages[1]).toEqual(result.message);
    const next = createModelProvider(f.config);
    await next.complete([...saved.messages, { role: "user", content: "Follow up" }], [], options());
    expect(f.bodies[1]?.input).toEqual([prompt, search, message(), { role: "user", content: "Follow up" }]);
    // Switching model never replays provider-specific items on the wrong model.
    await next.complete([...saved.messages, { role: "user", content: "Follow up" }], [], { ...options(), model: "other" });
    expect(f.bodies[2]?.input).toEqual([prompt, { role: "assistant", content: "News." }, { role: "user", content: "Follow up" }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("persists search mode without enabling it for auxiliary provider requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-search-settings-"));
  try {
    const store = await openSettingsStore(root);
    expect((await store.getPublic()).webSearch).toBeUndefined();
    await store.update({ settings: { webSearch: "cached", apiMode: "responses", baseUrl: "https://example.com/v1", model: "model" } });
    const reopened = await openSettingsStore(root);
    expect((await reopened.getPublic()).webSearch).toBe("cached");
    expect(await reopened.getProviderConfig()).not.toHaveProperty("webSearch");
    await reopened.update({ settings: { webSearch: "disabled" } });
    expect((await store.getPublic()).webSearch).toBe("disabled");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("accepts citations from final output only and empty-terminal compatibility with search items", async () => {
  const withoutAnnotationEvent = answer().split("\n\n").filter((event) => !event.startsWith("event: response.output_text.annotation.added")).join("\n\n");
  const m = message();
  for (const data of [withoutAnnotationEvent, searchStream() + messageStream(1, m) + finish([])]) {
    const f = await fixture(data);
    const result = await f.provider.complete([prompt], [], options());
    expect(result.message.citations).toHaveLength(1);
    expect(result.message.webSearches).toHaveLength(1);
  }
});

it("keeps failed hosted operations marked failed, never converts them to local calls", async () => {
  const failed = { ...search, status: "failed" };
  const m = message("m_1", "Search failed", []);
  const data = wire("response.output_item.added", { output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } })
    + wire("response.output_item.done", { output_index: 0, item: failed }) + messageStream(1, m) + finish([failed, m]);
  const f = await fixture(data);
  const result = await f.provider.complete([prompt], [], options());
  expect(result.message.webSearches?.[0]?.status).toBe("failed");
  expect(result.message.tool_calls).toBeUndefined();
});

it("omits native search for auxiliary/default calls and explicit disabled mode", async () => {
  const m = message("m_1", "Plain", []);
  const f = await fixture(messageStream(0, m) + finish([m]));
  const { webSearch: _, ...plain } = options();
  await f.provider.complete([prompt], [], plain);
  await f.provider.complete([prompt], [], { ...plain, webSearch: "disabled" });
  for (const body of f.bodies) expect(body).toMatchObject({ tools: [], include: ["reasoning.encrypted_content"] });
});

it.each(["chat-completions", "anthropic"] as const)("rejects native search on %s before any request", async (mode) => {
  const f = await fixture(answer(), 200, mode);
  await expect(Promise.resolve().then(() => f.provider.complete([prompt], [], options()))).rejects.toThrow(/requires a Responses endpoint/);
  expect(f.bodies).toHaveLength(0);
});

it("reports rejected search capability without retry, tool removal or local fallback", async () => {
  const f = await fixture(JSON.stringify({ error: { message: "secret upstream unsupported web_search" } }), 400);
  await expect(f.provider.complete([prompt], [], options())).rejects.toThrow(/native web_search was rejected/);
  expect(f.bodies).toHaveLength(1);
  expect(f.bodies[0]?.tools).toEqual([{ type: "web_search", external_web_access: true }]);
});

it("rejects unrequested hosted search and isolates observer failures", async () => {
  const f = await fixture(answer());
  await expect(f.provider.complete([prompt], [], { ...options(), webSearch: "disabled" })).rejects.toMatchObject({ classification: "protocol" });
  await expect(f.provider.complete([prompt], [], { ...options(), onWebSearch: () => { throw Error("private observer"); } })).rejects.toMatchObject({ classification: "observer" });
});

it.each(["javascript:alert(1)", "data:text/html,hi", "https://user:password@example.com/", "https://example.com/\u001b"])("rejects unsafe citation URL %s", async (url) => {
  const m = message("m_1", "News.", [{ ...citation, url }]);
  const f = await fixture(searchStream() + messageStream(1, m) + finish([search, m]));
  await expect(f.provider.complete([prompt], [], options())).rejects.toMatchObject({ classification: "protocol" });
});

it("rejects mismatched annotation events, invalid ranges, and inconsistent search terminal items", async () => {
  const m = message();
  const cases = [
    answer().replace('"annotation_index":0', '"annotation_index":1'),
    answer().replace('"item_id":"ws_1"', '"item_id":"wrong"'),
    searchStream() + messageStream(1, m) + finish([{ ...search, action: { type: "search", query: "changed" } }, m]),
    (() => { const bad = message("m_1", "News.", [{ ...citation, end_index: 99 }]); return searchStream() + messageStream(1, bad) + finish([search, bad]); })(),
    (() => { const bad = message("m_1", "News.", [{ ...citation, start_index: 4, end_index: 1 }]); return searchStream() + messageStream(1, bad) + finish([search, bad]); })(),
  ];
  for (const data of cases) {
    const f = await fixture(data);
    await expect(f.provider.complete([prompt], [], options())).rejects.toMatchObject({ classification: "protocol" });
  }
});

it("records open/find actions and offsets citations across multiple messages, without synthesizing tool outputs", async () => {
  const open = { ...search, action: { type: "open_page", url: citation.url } };
  const find = { ...search, id: "ws_2", action: { type: "find_in_page", url: citation.url, pattern: "news" } };
  const a = message("m_1", "First", []), b = message("m_2");
  const data = searchStream(open) + messageStream(1, a) + searchStream(find, 2, "ws_2") + messageStream(3, b) + finish([open, a, find, b]);
  const f = await fixture(data);
  const result = await f.provider.complete([prompt], [], options());
  expect(result.message.webSearches).toEqual([
    { id: "ws_1", status: "completed", action: "open_page", url: citation.url },
    { id: "ws_2", status: "completed", action: "find_in_page", url: citation.url, pattern: "news" },
  ]);
  expect(result.message.citations?.[0]).toMatchObject({ startIndex: 5, endIndex: 9 });
  expect(result.message.content).toBe("FirstNews.");
  expect(result.message.tool_calls).toBeUndefined();
});
