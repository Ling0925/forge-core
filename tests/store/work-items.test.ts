import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createCompositeWorkItemStore,
  openSuperAgentStore,
} from "../../src/store";

let directory: string;
let local: Awaited<ReturnType<typeof openSuperAgentStore>>;
let board: Awaited<ReturnType<typeof openSuperAgentStore>>;
let backend: "local" | "board";
let store: ReturnType<typeof createCompositeWorkItemStore>;
const input = {
  title: "Work",
  brief: "Investigate",
  threadIds: ["thread"],
  profileId: "worker",
  routerSessionId: "router",
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-composite-"));
  local = await openSuperAgentStore(join(directory, "local"));
  board = await openSuperAgentStore(join(directory, "board"));
  backend = "local";
  store = createCompositeWorkItemStore({
    local: local.workItems,
    board: board.workItems,
    backend: async () => backend,
  });
});
afterEach(async () => {
  await local.close();
  await board.close();
  await rm(directory, { recursive: true, force: true });
});

it("creates on the selected backend and dispatches existing work to its owner after switches", async () => {
  const localWork = await store.create(input);
  backend = "board";
  const boardWork = await store.create(input);
  expect(await local.workItems.get(boardWork.id)).toBeUndefined();
  expect(await board.workItems.get(localWork.id)).toBeUndefined();
  for (const [work, owner, selected] of [
    [localWork, local.workItems, "board"],
    [boardWork, board.workItems, "local"],
  ] as const) {
    backend = selected;
    expect(await store.get(work.id)).toEqual(work);
    expect(await store.claim(work.id, input.routerSessionId)).toMatchObject({
      status: "running",
    });
    expect(await store.claim(work.id, "another")).toBeUndefined();
    await store.update(work.id, { progress: "Working" });
    await store.linkThread(work.id, "extra");
    await store.unlinkThread(work.id, "thread");
    const linked = await store.linkWorker(
      work.id,
      "worker-session",
      "/worktree",
    );
    expect(linked).toMatchObject({
      progress: "Working",
      threadIds: ["extra"],
      workerSessionId: "worker-session",
      worktree: "/worktree",
    });
    expect(await owner.get(work.id)).toEqual(linked);
  }
  expect(await store.get("missing")).toBeUndefined();
  expect(await store.claim("missing", "router")).toBeUndefined();
  await expect(
    store.update("missing", { progress: "Missing" }),
  ).rejects.toMatchObject({ code: "not_found" });
});

it("prefers local ownership without accessing board for matching ids", async () => {
  const work = await store.create(input);
  const get = vi.spyOn(board.workItems, "get");
  const claim = vi.spyOn(board.workItems, "claim");
  expect(await store.get(work.id)).toEqual(work);
  await store.claim(work.id, "router");
  expect(await store.claim(work.id, "router")).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled();
});

it("merges filtered lists in createdAt then binary id order", async () => {
  const base = await store.create(input);
  const early = "2026-10-01T00:00:00.000Z";
  const later = "2026-11-01T00:00:00.000Z";
  const localItems = [
    { ...base, id: "Z", createdAt: later },
    { ...base, id: "first", createdAt: early },
  ];
  const boardItems = [
    { ...base, id: "a", createdAt: later },
    { ...base, id: "A", createdAt: later },
  ];
  const localList = vi
    .spyOn(local.workItems, "list")
    .mockResolvedValue(localItems);
  const boardList = vi
    .spyOn(board.workItems, "list")
    .mockResolvedValue(boardItems);
  const query = { status: ["running", "queued"], threadId: "thread" } as const;
  expect((await store.list(query)).map((item) => item.id)).toEqual([
    "first",
    "A",
    "Z",
    "a",
  ]);
  expect(localList).toHaveBeenCalledWith(query);
  expect(boardList).toHaveBeenCalledWith(query);
  expect(localItems.map((item) => item.id)).toEqual(["Z", "first"]);
  expect(boardItems.map((item) => item.id)).toEqual(["a", "A"]);
});
