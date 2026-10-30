import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { testScratch } from "../fixtures/scratch";
import { afterEach, expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { Message, ProviderConfig } from "../../src/shared/schemas";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const done = () => ({ message: { role: "assistant" as const, content: "done" } });
const call = (name: string, args = {}) => ({ message: { role: "assistant" as const, content: null,
  tool_calls: [{ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] } });
const last = (messages: readonly Message[]) => JSON.parse(JSON.parse(messages.findLast(message => message.role === "tool")!.content!).content);

async function fixture(spawn: Record<string, unknown>, catalogs: Record<string, string[]> = { a: ["parent"], b: ["cn:deepseek-v4.1-flash"] }, discovery = false) {
  const base = testScratch("cross-provider-fixes", "routing");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "harness-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let parentId = "";
  let turns = 0;
  const seen: { source: string | undefined; model: string; mode: ProviderConfig["apiMode"]; sessionId: string | undefined }[] = [];
  let discovered: any;
  let admission: any;
  const service = await createHarness({ stateDir: join(directory, "state"),
    toolFactory: () => ({ definitions: [], execute: async () => ({ content: "ok", isError: false }), dispose: async () => {} }),
    providerFactory: config => ({ ...(config.apiMode ? { apiMode: config.apiMode } : {}), listModels: async () => catalogs[config.sourceId ?? ""] ?? [],
      complete: async (messages, _definitions, options) => {
        seen.push({ source: config.sourceId, model: options.model, mode: config.apiMode, sessionId: options.sessionId });
        if (options.sessionId !== parentId) return done();
        turns++;
        if (discovery && turns === 1) return call("list_models", { limit: 100 });
        if (discovery && turns === 2) discovered = last(messages);
        if (turns === (discovery ? 2 : 1)) return call("spawn_agent", { task: "inspect offline", ...spawn });
        if (turns === (discovery ? 3 : 2)) {
          admission = last(messages);
          if (admission.childSessionId) return call("wait_agents", { ids: [admission.childSessionId] });
        }
        return done();
      },
    }),
  });
  cleanups.push(() => service.dispose());
  for (const [id, model, mode] of [["a", "parent", "chat-completions"], ["b", "other-default", "anthropic"]] as const)
    await service.updateSettings({ source: { type: "save", source: { id, label: id, model, apiMode: mode, baseUrl: `https://${id}.invalid/v1` }, apiKey: `fixture-${id}` } });
  const parent = await service.createSession({ workspace: directory, title: "Explicit fixture title", model: "parent", providerSourceId: "a" });
  parentId = parent.id;
  const activeBefore = (await service.getSettings()).activeSourceId;
  const run = async () => service.run({ sessionId: parent.id, prompt: "delegate", permission: "readonly" }, () => {}, async () => false, AbortSignal.timeout(8000));
  return { service, parent, seen, run, activeBefore, discovery: () => discovered, admission: () => admission };
}

it("routes a non-default opaque child ID to another protocol and persists it without mutating the parent", async () => {
  const f = await fixture({ model: "cn:deepseek-v4.1-flash" }, undefined, true);
  const result = await f.run();
  expect(result.status).toBe("completed");
  expect(result.providerSourceId).toBe("a");
  expect(f.discovery().models).toContainEqual({ id: "cn:deepseek-v4.1-flash", providerSourceId: "b" });
  expect(f.admission()).toMatchObject({ model: "cn:deepseek-v4.1-flash", providerSourceId: "b" });
  const child = (await f.service.listSessions()).find(session => session.parentSessionId === f.parent.id)!;
  expect(child).toMatchObject({ model: "cn:deepseek-v4.1-flash", providerSourceId: "b", status: "completed" });
  expect(f.seen.filter(request => request.sessionId === child.id)).toEqual([
    { source: "b", model: "cn:deepseek-v4.1-flash", mode: "anthropic", sessionId: child.id },
  ]);
  expect(f.seen.filter(request => request.sessionId === f.parent.id).every(request => request.source === "a" && request.model === "parent")).toBe(true);
  expect((await f.service.getSettings()).activeSourceId).toBe(f.activeBefore);
  const resumed = await f.service.run({ sessionId: child.id, prompt: "continue", permission: "readonly" }, () => {}, async () => false, AbortSignal.timeout(8000));
  expect(resumed.status).toBe("completed");
  expect(f.seen.at(-1)).toMatchObject({ source: "b", model: "cn:deepseek-v4.1-flash" });
}, 15000);

it.each([
  [{}, "a", "parent"],
  [{ model: "shared", providerSourceId: "b" }, "b", "shared"],
  [{ model: "unlisted", providerSourceId: "b" }, "b", "unlisted"],
] as const)("keeps inherited and explicitly source-qualified selections exact %#", async (spawn, source, model) => {
  const f = await fixture(spawn, { a: ["parent", "shared"], b: ["shared"] });
  expect((await f.run()).status).toBe("completed");
  const child = (await f.service.listSessions()).find(session => session.parentSessionId === f.parent.id)!;
  expect(child).toMatchObject({ model, providerSourceId: source, status: "completed" });
  expect(f.seen.some(request => request.sessionId === child.id && request.source === source && request.model === model)).toBe(true);
}, 15000);

it.each([
  [{ model: "shared" }, "multiple configured sources"],
  [{ model: "not-listed" }, "not found"],
  [{ model: "shared", providerSourceId: "missing" }, "Unknown providerSourceId"],
] as const)("fails admission without child effects or parent-provider fallback %#", async (spawn, error) => {
  const f = await fixture(spawn, { a: ["parent", "shared"], b: ["shared"] });
  await f.run();
  expect(f.admission()).toMatchObject({ code: "invalid_input", message: expect.stringContaining(error) });
  expect((await f.service.listSessions()).filter(session => session.parentSessionId === f.parent.id)).toHaveLength(0);
  expect(f.seen.every(request => request.sessionId === f.parent.id)).toBe(true);
}, 15000);
