import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { ForgeError } from "../../src/shared/errors";
import type { ModelProvider } from "../../src/shared/contracts";
import type { AgentEvent, ProviderResponse } from "../../src/shared/schemas";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const reply = (content: string): ProviderResponse => ({ message: { role: "assistant", content } });
const fixture = async (complete: ModelProvider["complete"]) => {
  const root = await mkdtemp(join(tmpdir(), "forge-title-timing-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const service = await createHarness({
    stateDir: join(root, "state"),
    providerFactory: () => ({ listModels: async () => [], complete }),
    toolFactory: () => ({ definitions: [], execute: async () => ({ content: "unused" }), dispose: async () => {} }),
  });
  cleanups.push(() => service.dispose());
  await service.updateSettings({ apiKey: "fixture-only-key", settings: { baseUrl: "https://provider.example/v1", model: "fixture-model" } });
  return { service, session: await service.createSession({ workspace }) };
};

describe("first-message session titles", () => {
  it("shows the fallback and generated title while the first assistant response is still pending", async () => {
    const main = deferred<ProviderResponse>();
    const naming = deferred<ProviderResponse>();
    const complete = vi.fn<ModelProvider["complete"]>((messages) =>
      messages[0]?.content?.startsWith("Generate only") ? naming.promise : main.promise);
    const { service, session } = await fixture(complete);
    const events: AgentEvent[] = [];
    const running = service.run({ sessionId: session.id, prompt: "修复登录问题\n具体说明" }, event => events.push(event), async () => false, new AbortController().signal);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(events.find(event => event.type === "run_started")).toMatchObject({ title: "修复登录问题" });
    expect(await service.getSession(session.id)).toMatchObject({ title: "修复登录问题", titleSource: "auto", autoTitleAttempted: true, status: "running" });
    expect((await service.listSessions()).find(item => item.id === session.id)?.title).toBe("修复登录问题");
    naming.resolve(reply("登录修复"));
    await vi.waitFor(() => expect(events.some(event => event.type === "title_changed")).toBe(true));
    const live = await service.getSession(session.id);
    expect(live).toMatchObject({ title: "登录修复", status: "running" });
    expect(live.messages.filter(message => message.role === "assistant")).toHaveLength(0);
    main.resolve(reply("done"));
    expect(await running).toMatchObject({ title: "登录修复", status: "completed" });
    expect((await service.getSession(session.id)).messages.at(-1)?.content).toBe("done");
  });

  it.each(["failed", "cancelled"] as const)("keeps the first message if naming fails and the run is %s", async status => {
    let titleCalls = 0;
    const mainStarted = deferred<void>();
    const complete: ModelProvider["complete"] = async messages => {
      if (messages[0]?.content?.startsWith("Generate only")) {
        titleCalls++;
        throw new Error("private provider failure");
      }
      mainStarted.resolve();
      if (status === "cancelled") return new Promise(() => {});
      throw new ForgeError("provider", "Non-retryable fixture failure.");
    };
    const { service, session } = await fixture(complete);
    const controller = new AbortController();
    const running = service.run({ sessionId: session.id, prompt: "修复登录问题" }, () => {}, async () => false, controller.signal);
    await mainStarted.promise;
    if (status === "cancelled") controller.abort();
    expect(await running).toMatchObject({ title: "修复登录问题", status });
    expect(await service.getSession(session.id)).toMatchObject({ title: "修复登录问题", autoTitleAttempted: true });
    expect(titleCalls).toBe(1);
  });

  it("does not generate over an explicit user title", async () => {
    const complete = vi.fn<ModelProvider["complete"]>(async () => reply("done"));
    const { service, session } = await fixture(complete);
    await service.renameSession(session.id, "手动标题");
    const result = await service.run({ sessionId: session.id, prompt: "修复登录问题" }, () => {}, async () => false, new AbortController().signal);
    expect(result).toMatchObject({ title: "手动标题", titleSource: "user" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("handles a title arriving after the run without replacing a manual rename (rename=%s)", async rename => {
    const naming = deferred<ProviderResponse>();
    const complete: ModelProvider["complete"] = async messages =>
      messages[0]?.content?.startsWith("Generate only") ? naming.promise : reply("done");
    const { service, session } = await fixture(complete);
    const run = await service.run({ sessionId: session.id, prompt: "修复登录问题" }, () => {}, async () => false, new AbortController().signal);
    expect(run.title).toBe("修复登录问题");
    if (rename) await service.renameSession(session.id, "手动标题");
    naming.resolve(reply("登录修复"));
    await vi.waitFor(async () => expect((await service.getSession(session.id)).title).toBe(rename ? "手动标题" : "登录修复"));
    await service.dispose();
    // Reopen with the isolated fixture home to verify the saved metadata and turn.
    const { openSessionStore } = await import("../../src/store/sessions");
    const store = await openSessionStore(join(session.workspace, "..", "state"));
    const saved = await store.get(session.id);
    expect(saved.title).toBe(rename ? "手动标题" : "登录修复");
    expect(saved.messages.at(-1)?.content).toBe("done");
  });
});
