import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { superAgentSendSchema } from "../../src/shared";
import { openSuperAgentStore } from "../../src/store";
import { createGithubOutboxExecutor } from "../../src/superagent";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("executes each approved write with private credentials and sanitizes failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-outbox-"));
  const store = await openSuperAgentStore(directory);
  const token = "fixture-token-never-public";
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "http.proxy");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "http://fixture-proxy.invalid");
  let failGit = false;
  mocks.spawn.mockImplementation((command: string, args: string[]) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    queueMicrotask(() => {
      stdout.end(
        command === "gh"
          ? `${token}\n`
          : args.includes("get-url")
            ? "git@github.com:owner/repo.git\n"
            : "",
      );
      child.emit("close", failGit && command === "git" ? 1 : 0);
    });
    return Object.assign(child, { stdout });
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  try {
    let work = await store.workItems.create({
      title: "fixture",
      brief: "fixture",
      threadIds: ["gh:owner/repo#1"],
      profileId: "worker",
      routerSessionId: "router-session",
    });
    work = await store.workItems.linkWorker(
      work.id,
      "worker-session",
      "/fixture/worktree",
    );
    const executor = createGithubOutboxExecutor(store.workItems);
    for (const input of [
      {
        kind: "comment",
        target: { thread: "gh:owner/repo#1" },
        body: { text: "Ready" },
      },
      {
        kind: "label",
        target: { thread: "gh:owner/repo#1" },
        body: { labels: ["ready"] },
      },
      {
        kind: "pull_request",
        target: {},
        body: {
          title: "Fix",
          body: "Description",
          head: "worker",
          base: "main",
        },
      },
      { kind: "push", target: {}, body: { branch: "worker" } },
    ] as const) {
      const item = await store.createOutboxItem({
        ...superAgentSendSchema.parse(input),
        workId: work.id,
      });
      const approved = await store.decideOutbox(item.id, true);
      expect(await executor.execute(approved)).toBeUndefined();
    }
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://api.github.com/repos/owner/repo/issues/1/comments",
      "https://api.github.com/repos/owner/repo/issues/1/labels",
      "https://api.github.com/repos/owner/repo/pulls",
    ]);
    const requests = fetch.mock.calls;
    expect(requests.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { body: "Ready" },
      { labels: ["ready"] },
      { title: "Fix", body: "Description", head: "worker", base: "main" },
    ]);
    expect(
      requests.every(
        ([, init]) =>
          new Headers(init?.headers).get("Authorization") === `Bearer ${token}`,
      ),
    ).toBe(true);
    const push = mocks.spawn.mock.calls.find(([, args]) =>
      args.includes("push"),
    )!;
    expect(push[1]).toEqual([
      "-C",
      work.worktree,
      "push",
      "origin",
      "HEAD:refs/heads/worker",
    ]);
    const authorization = Buffer.from(`x-access-token:${token}`).toString(
      "base64",
    );
    expect(push[2].env).toEqual({
      ...process.env,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${authorization}`,
      GIT_CONFIG_KEY_2: "remote.origin.pushurl",
      GIT_CONFIG_VALUE_2: "https://github.com/owner/repo.git",
    });
    expect(push[2].env).not.toBe(process.env);
    expect(process.env.GIT_CONFIG_COUNT).toBe("1");
    expect(process.env.GIT_CONFIG_VALUE_1).not.toBe(
      `AUTHORIZATION: basic ${authorization}`,
    );
    for (const [, args, options] of mocks.spawn.mock.calls) {
      expect(args.join(" ")).not.toContain(token);
      expect(args.join(" ")).not.toContain(authorization);
      if (!args.includes("push")) expect(options.env).toBeUndefined();
    }
    expect(
      mocks.spawn.mock.calls.some(([, args]) => args.includes("config")),
    ).toBe(false);
    expect(
      mocks.spawn.mock.calls.filter(([command]) => command === "gh"),
    ).toHaveLength(4);
    expect(
      mocks.spawn.mock.calls
        .filter(([command]) => command === "gh")
        .every(([, args]) => args.join(" ") === "auth token"),
    ).toBe(true);
    expect(JSON.stringify(await store.listOutbox())).not.toContain(token);
    const items = await store.listOutbox();
    fetch.mockRejectedValueOnce(new Error(`failure ${token}`));
    await expect(
      executor.execute(items.find((item) => item.kind === "comment")!),
    ).rejects.toThrow("GitHub request failed.");
    fetch.mockResolvedValueOnce(new Response(token, { status: 403 }));
    await expect(
      executor.execute(items.find((item) => item.kind === "comment")!),
    ).rejects.toMatchObject({
      code: "provider",
      message: "GitHub request failed (HTTP 403).",
    });
    failGit = true;
    await expect(
      executor.execute(items.find((item) => item.kind === "push")!),
    ).rejects.toMatchObject({
      code: "tool",
      message: "GitHub git operation failed.",
    });
    failGit = false;
    mocks.spawn.mockImplementationOnce(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
      });
      queueMicrotask(() => child.emit("error", new Error(token)));
      return child;
    });
    await expect(executor.execute(items[0]!)).rejects.toMatchObject({
      code: "invalid_input",
      message: "GitHub authentication failed; run gh auth login on this host.",
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
