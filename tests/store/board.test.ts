import { afterEach, expect, it, vi } from "vitest";
import { ForgeError, toErrorInfo } from "../../src/shared";
import { createBoardClient, createBoardWorkItemStore } from "../../src/store";
import type { BoardTask } from "../../src/store/board-api";

const initial: BoardTask = {
  id: "task",
  projectId: "project",
  title: "Work",
  description: "Brief",
  status: "in_progress",
  progress: "",
  metadata: {
    forge: { profileId: "worker", routerSessionId: "router", worktree: null },
  },
  lease: { holder: "agent", token: "lease-1" },
  version: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const links = [{ kind: "thread", ref: "gh:owner/repo#1" }];
type Request = {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
};
function fixture(mutation: (request: Request) => Response | Promise<Response>) {
  let task = structuredClone(initial);
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const request = {
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      };
      requests.push(request);
      if (request.method !== "GET") return mutation(request);
      if (url.pathname === "/v1/approvals")
        return Response.json({ items: [], nextCursor: null });
      return Response.json({ ...task, links });
    }),
  );
  const client = createBoardClient({
    url: "http://board.invalid",
    settings: { getBoardToken: async () => "private-token" },
  });
  const store = createBoardWorkItemStore({
    client,
    projectId: "project",
    accountable: "human",
  });
  return {
    client,
    store,
    requests,
    get task() {
      return task;
    },
    set task(value: BoardTask) {
      task = value;
    },
  };
}
const conflict = (status: number, code: string, task: BoardTask) =>
  Response.json(
    {
      error: {
        code,
        message: "Board conflict message",
        details: { currentTask: task },
      },
    },
    { status },
  );
afterEach(() => vi.unstubAllGlobals());

it("uses a direct transition when the board accepts it", async () => {
  const f = fixture((request) => {
    f.task = { ...f.task, status: "done", version: f.task.version + 1 };
    expect(request.body).toEqual({ to: "done", progress: "Complete" });
    return Response.json({ task: f.task, approval: null });
  });
  f.task = { ...initial, status: "blocked", lease: null };
  expect(
    await f.store.update("task", { status: "done", progress: "Complete" }),
  ).toMatchObject({ status: "done" });
  expect(
    f.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
});

it("falls back through in_progress only after rejection and rebases every transition", async () => {
  const mutations: Request[] = [];
  const f = fixture((request) => {
    mutations.push(request);
    if ([1, 3, 5].includes(mutations.length)) {
      f.task = {
        ...f.task,
        version: f.task.version + 1,
        lease: { holder: "agent", token: `lease-${f.task.version + 1}` },
      };
      return conflict(
        mutations.length === 3 ? 409 : 412,
        mutations.length === 3 ? "lease_lost" : "version_mismatch",
        f.task,
      );
    }
    if (mutations.length === 2)
      return conflict(409, "invalid_transition", f.task);
    f.task = {
      ...f.task,
      status: request.body.to as BoardTask["status"],
      progress: String(request.body.progress ?? ""),
      version: f.task.version + 1,
    };
    return Response.json({ task: f.task, approval: null });
  });
  f.task = { ...initial, status: "blocked" };
  expect(
    await f.store.update("task", { status: "done", progress: "Complete" }),
  ).toMatchObject({ status: "done", progress: "Complete" });
  expect(mutations.map((request) => request.body)).toEqual([
    { to: "done", progress: "Complete", leaseToken: "lease-1" },
    { to: "done", progress: "Complete", leaseToken: "lease-2" },
    { to: "in_progress", leaseToken: "lease-1" },
    { to: "in_progress", leaseToken: "lease-3" },
    { to: "done", progress: "Complete", leaseToken: "lease-3" },
    { to: "done", progress: "Complete", leaseToken: "lease-5" },
  ]);
  expect(mutations.map((request) => request.headers.get("If-Match"))).toEqual([
    '"1"',
    '"2"',
    '"1"',
    '"3"',
    '"4"',
    '"5"',
  ]);
});

it.each([
  ["blocked", 403, "forbidden"],
  ["blocked", 503, "unavailable"],
  ["in_progress", 409, "invalid_transition"],
] as const)(
  "does not fall back from %s on %s %s",
  async (status, httpStatus, code) => {
    const f = fixture(() => conflict(httpStatus, code, f.task));
    f.task = { ...initial, status };
    await expect(
      f.store.update("task", { status: "done" }),
    ).rejects.toMatchObject({
      boardCode: code,
    });
    expect(
      f.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  },
);

it.each(["blocked", "in_progress"] as const)(
  "stops when the board rejects the fallback transition from %s",
  async (rejectedStatus) => {
    const mutations: Request[] = [];
    const f = fixture((request) => {
      mutations.push(request);
      if (
        request.body.to === "in_progress" &&
        rejectedStatus === "in_progress"
      ) {
        f.task = {
          ...f.task,
          status: "in_progress",
          version: f.task.version + 1,
        };
        return Response.json({ task: f.task, approval: null });
      }
      return conflict(409, "invalid_transition", f.task);
    });
    f.task = { ...initial, status: "blocked" };
    await expect(
      f.store.update("task", { status: "done" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      boardCode: "invalid_transition",
    });
    expect(mutations.map((request) => request.body.to)).toEqual(
      rejectedStatus === "blocked"
        ? ["done", "in_progress"]
        : ["done", "in_progress", "done"],
    );
  },
);

it.each(["done", "in_progress"] as const)(
  "stops transitioning when approval is required for %s",
  async (to) => {
    const mutations: Request[] = [];
    const f = fixture((request) => {
      mutations.push(request);
      if (request.body.to !== to)
        return conflict(409, "invalid_transition", f.task);
      return Response.json({
        task: f.task,
        approval: { id: "approval", taskId: "task", action: "transition", to },
      });
    });
    f.task = { ...initial, status: "blocked" };
    expect(await f.store.update("task", { status: "done" })).toMatchObject({
      status: "blocked",
    });
    expect(mutations.map((request) => request.body.to)).toEqual(
      to === "done" ? ["done"] : ["done", "in_progress"],
    );
  },
);

it.each([
  [404, "not_found", "not_found"],
  [409, "claim_conflict", "busy"],
  [412, "version_mismatch", "busy"],
  [409, "lease_lost", "busy"],
  [409, "conflict", "busy"],
  [422, "validation_error", "invalid_input"],
  [403, "forbidden", "invalid_input"],
  [409, "invalid_transition", "invalid_input"],
  [401, "unauthorized", "invalid_input"],
  [400, "bad_request", "invalid_input"],
  [500, "internal", "storage"],
  [503, "unavailable", "storage"],
] as const)("classifies HTTP %s %s as %s", async (status, boardCode, code) => {
  const f = fixture(() => conflict(status, boardCode, initial));
  const error = await f.client
    .json("/v1/tasks/task/transition", { method: "POST" })
    .catch((error) => error);
  expect(error).toMatchObject({ status, boardCode });
  expect(toErrorInfo(error)).toEqual({
    code,
    message: "Board conflict message",
    retryable: false,
  });
  expect(f.requests).toHaveLength(1);
});

it.each([
  [412, "version_mismatch"],
  [409, "lease_lost"],
] as const)(
  "rebases %s from currentTask with fresh versions and leases while preserving the intended transition",
  async (status, code) => {
    const mutations: Request[] = [];
    const f = fixture((request) => {
      mutations.push(request);
      if (mutations.length < 3) {
        f.task = {
          ...f.task,
          version: f.task.version + 1,
          lease: { holder: "agent", token: `lease-${f.task.version + 1}` },
        };
        return conflict(status, code, f.task);
      }
      f.task = {
        ...f.task,
        status: "done",
        progress: String(request.body.progress),
        lease: null,
        version: f.task.version + 1,
      };
      return Response.json({ task: f.task, approval: null });
    });
    expect(
      await f.store.update("task", { status: "done", progress: "Complete" }),
    ).toMatchObject({ status: "done", progress: "Complete" });
    expect(mutations.map((request) => request.headers.get("If-Match"))).toEqual(
      ['"1"', '"2"', '"3"'],
    );
    expect(mutations.map((request) => request.body)).toEqual([
      { to: "done", progress: "Complete", leaseToken: "lease-1" },
      { to: "done", progress: "Complete", leaseToken: "lease-2" },
      { to: "done", progress: "Complete", leaseToken: "lease-3" },
    ]);
    expect(
      new Set(
        mutations.map((request) => request.headers.get("Idempotency-Key")),
      ).size,
    ).toBe(3);
    expect(
      f.requests.filter(
        (request) =>
          request.method === "GET" && request.url.pathname === "/v1/tasks/task",
      ),
    ).toHaveLength(2);
  },
);

it("recomputes namespaced metadata from the conflict's current task", async () => {
  const f = fixture((request) => {
    if (request.url.pathname.endsWith("/links"))
      return Response.json({ task: f.task });
    if (f.task.version === 1) {
      f.task = {
        ...f.task,
        version: 2,
        metadata: {
          human: "preserve",
          forge: {
            profileId: "worker",
            routerSessionId: "router",
            worktree: null,
            context: "new",
          },
        },
      };
      return conflict(412, "version_mismatch", f.task);
    }
    f.task = {
      ...f.task,
      metadata: request.body.metadata as BoardTask["metadata"],
    };
    return Response.json(f.task);
  });
  await f.store.linkWorker("task", "session", "/worktree");
  expect(f.task.metadata).toEqual({
    human: "preserve",
    forge: {
      profileId: "worker",
      routerSessionId: "router",
      worktree: "/worktree",
      context: "new",
    },
  });
});

it.each([
  [412, "version_mismatch"],
  [409, "lease_lost"],
] as const)(
  "surfaces %s unchanged when a human changed the status",
  async (status, code) => {
    const f = fixture(() =>
      conflict(status, code, {
        ...initial,
        status: "canceled",
        lease: null,
        version: 2,
      }),
    );
    await expect(
      f.store.update("task", { status: "done", progress: "Finished" }),
    ).rejects.toMatchObject({ message: "Board conflict message" });
    expect(
      f.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  },
);

it.each([null, { holder: "another-agent", token: "another-lease" }])(
  "does not rebase after losing ownership to %j",
  async (lease) => {
    const f = fixture(() =>
      conflict(409, "lease_lost", { ...initial, lease, version: 2 }),
    );
    await expect(
      f.store.update("task", { progress: "Working" }),
    ).rejects.toBeInstanceOf(ForgeError);
    expect(
      f.requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(1);
  },
);

it("surfaces a conflict that supplies no changed version or lease", async () => {
  const f = fixture(() => conflict(412, "version_mismatch", initial));
  await expect(
    f.store.update("task", { progress: "Working" }),
  ).rejects.toMatchObject({ message: "Board conflict message" });
  expect(
    f.requests.filter((request) => request.method === "PATCH"),
  ).toHaveLength(1);
});

it("replays an uncertain committed mutation once with an identical key, headers and body", async () => {
  const mutations: Request[] = [];
  const f = fixture((request) => {
    mutations.push(request);
    if (mutations.length === 1) {
      f.task = {
        ...f.task,
        progress: String(request.body.progress),
        version: 2,
      };
      throw new TypeError("connection lost after commit");
    }
    return Response.json(f.task);
  });
  expect(await f.store.update("task", { progress: "Committed" })).toMatchObject(
    { progress: "Committed" },
  );
  expect(mutations).toHaveLength(2);
  expect(mutations[0]!.headers.get("Idempotency-Key")).toEqual(
    expect.any(String),
  );
  expect(mutations[1]).toEqual(mutations[0]);
  expect(f.task.version).toBe(2);
});

it("surfaces a second transport failure and does not replay HTTP failures", async () => {
  const failure = new TypeError("offline");
  const f = fixture(() => {
    throw failure;
  });
  await expect(
    f.store.update("task", { progress: "Working" }),
  ).rejects.toMatchObject({
    code: "storage",
    message: failure.message,
    retryable: true,
  });
  expect(
    f.requests.filter((request) => request.method === "PATCH"),
  ).toHaveLength(2);
  const http = fixture(() =>
    Response.json(
      {
        error: {
          code: "unavailable",
          message: "Board unavailable",
          details: null,
        },
      },
      { status: 503 },
    ),
  );
  await expect(
    http.store.update("task", { progress: "Working" }),
  ).rejects.toMatchObject({
    code: "storage",
    message: "Board unavailable",
    retryable: false,
  });
  expect(
    http.requests.filter((request) => request.method === "PATCH"),
  ).toHaveLength(1);
});

it("classifies a read transport failure without replaying it", async () => {
  const f = fixture(() => Response.json({}));
  const fetch = vi
    .mocked(globalThis.fetch)
    .mockRejectedValue(new TypeError("offline"));
  await expect(f.store.get("task")).rejects.toMatchObject({
    code: "storage",
    message: "offline",
    retryable: true,
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("follows task and approval cursors, joining one project approvals query across all tasks", async () => {
  const requests: URL[] = [];
  const tasks = [
    { ...initial, links },
    { ...initial, id: "second", status: "todo", lease: null, links },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const next = url.searchParams.get("cursor");
      if (url.pathname === "/v1/tasks")
        return Response.json({
          items: [tasks[next ? 1 : 0]],
          nextCursor: next ? null : "tasks-next",
        });
      return Response.json({
        items: [
          {
            id: next ? "approval-2" : "approval-1",
            taskId: next ? "second" : "task",
            action: next ? "claim" : "transition",
            to: next ? "in_progress" : "done",
          },
        ],
        nextCursor: next ? null : "approvals-next",
      });
    }),
  );
  const client = createBoardClient({
    url: "http://board.invalid",
    settings: { getBoardToken: async () => "private-token" },
  });
  const store = createBoardWorkItemStore({
    client,
    projectId: "project",
    accountable: "human",
  });
  expect(
    await store.list({
      status: ["queued", "running"],
      threadId: "gh:owner/repo#1",
    }),
  ).toMatchObject([
    { id: "task", status: "running", pendingStatus: "done" },
    { id: "second", status: "queued", pendingStatus: "running" },
  ]);
  expect(
    requests.map((url) => [url.pathname, Object.fromEntries(url.searchParams)]),
  ).toEqual([
    [
      "/v1/tasks",
      {
        project: "project",
        include: "links",
        status: "todo,in_progress",
        link: "gh:owner/repo#1",
      },
    ],
    [
      "/v1/tasks",
      {
        project: "project",
        include: "links",
        status: "todo,in_progress",
        link: "gh:owner/repo#1",
        cursor: "tasks-next",
      },
    ],
    ["/v1/approvals", { project: "project", state: "pending" }],
    [
      "/v1/approvals",
      { project: "project", state: "pending", cursor: "approvals-next" },
    ],
  ]);
});
