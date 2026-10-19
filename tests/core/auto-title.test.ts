import { describe, expect, it, vi } from "vitest";
import { autoTitle, claimAutoTitle, cleanTitle } from "../../src/core/session-title";
import type { ModelProvider, SessionStore } from "../../src/shared/contracts";
import { sessionSnapshotSchema } from "../../src/shared/schemas";
function fixture() {
  let current = sessionSnapshotSchema.parse({
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    title: "New session",
    titleSource: "default",
    workspace: "/tmp",
    model: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "running",
    messages: [{ role: "user", content: "# 修复登录问题" }],
    events: [],
    changes: [],
  });
  const store: SessionStore = {
    create: async () => current,
    get: async () => current,
    list: async () => [],
    save: async (s) => {
      current = sessionSnapshotSchema.parse(s);
    },
    acquire: async () => async () => {},
  };
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: vi.fn(async () => ({
      message: { role: "assistant" as const, content: '"登录修复"' },
    })),
  };
  const run = async () => {
    const claimed = claimAutoTitle(current, ["private-key"]);
    if (claimed === current) return;
    await store.save(claimed);
    const title = await autoTitle({
      snapshot: claimed,
      provider,
      signal: new AbortController().signal,
      secrets: ["private-key"],
    });
    if (title && current.titleSource === "auto" && current.title === claimed.title)
      await store.save({ ...current, title });
  };
  return { store, provider, run, get: () => current };
}
describe("automatic title metadata", () => {
  it("names once without changing messages, events or state", async () => {
    const f = fixture();
    const before = f.get();
    await f.run();
    await f.run();
    expect(f.get()).toMatchObject({
      title: "登录修复",
      titleSource: "auto",
      autoTitleAttempted: true,
      messages: before.messages,
      events: before.events,
      status: before.status,
    });
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
    expect(f.provider.complete).toHaveBeenCalledWith(
      expect.any(Array),
      [],
      expect.objectContaining({ model: "test" }),
    );
  });
  it("persists the first-message fallback before an unresolved title request", async () => {
    const f = fixture();
    let resolve!: (value: Awaited<ReturnType<ModelProvider["complete"]>>) => void;
    f.provider.complete = vi.fn(() => new Promise(done => { resolve = done; }));
    const work = f.run();
    await vi.waitFor(() => expect(f.provider.complete).toHaveBeenCalledTimes(1));
    expect(f.get()).toMatchObject({ title: "修复登录问题", status: "running", autoTitleAttempted: true });
    expect(f.get().messages).toHaveLength(1);
    resolve({ message: { role: "assistant", content: "登录修复" } });
    await work;
    expect(f.get().title).toBe("登录修复");
  });
  it.each(["user", undefined] as const)(
    "does not change user or legacy titleSource %s",
    async (titleSource) => {
      const f = fixture();
      await f.store.save({ ...f.get(), titleSource });
      await f.run();
      expect(f.provider.complete).not.toHaveBeenCalled();
    },
  );
  it("does not overwrite a concurrent rename", async () => {
    const f = fixture();
    f.provider.complete = async () => {
      await f.store.save({
        ...f.get(),
        title: "My title",
        titleSource: "user",
      });
      return { message: { role: "assistant", content: "generated" } };
    };
    await f.run();
    expect(f.get().title).toBe("My title");
  });
  it("keeps a persisted fallback after failure or restart", async () => {
    const f = fixture();
    f.provider.complete = vi.fn(async () => {
      throw Error("private provider details");
    });
    await f.run();
    await f.run();
    expect(f.get().title).toBe("修复登录问题");
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
  });
  it("bounds a provider ignoring cancellation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.provider.complete = () => new Promise(() => {});
      const done = f.run();
      await vi.advanceTimersByTimeAsync(2100);
      await done;
      expect(f.get().title).toBe("修复登录问题");
    } finally {
      vi.useRealTimers();
    }
  });
  it("sanitizes known secrets, URL, control text and length", () => {
    const title = cleanTitle(
      '# "password=abc https://private/path private-key\n\u001b title"',
      ["private-key"],
    );
    expect(title).not.toMatch(/abc|private|\u001b/);
    expect(Array.from(cleanTitle("字".repeat(100))).length).toBe(60);
  });
});
