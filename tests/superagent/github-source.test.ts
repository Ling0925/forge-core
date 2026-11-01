import { afterEach, expect, it, vi } from "vitest";
import { createGithubSource } from "../../src/superagent";
import * as api from "../../src/superagent/github-api";
import { fixture } from "./fixture";
import { comment, delivery, issue, payload, timestamp } from "./github-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("initializes a missing cursor without obtaining a credential or fetching history", async () => {
  const f = await fixture();
  const token = vi.spyOn(api, "githubToken");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  try {
    const source = createGithubSource({
      login: "forge-bot",
      repos: ["owner/repo"],
      store: f.store,
      ingest: f.engine.ingest,
    });
    await source.catchUp();
    expect(await f.store.getCursor("github:owner/repo:since")).toBeDefined();
    expect(token).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("pages catch-up, stops before older events, and deduplicates later webhooks", async () => {
  const f = await fixture();
  vi.spyOn(api, "githubToken").mockResolvedValue("fixture-private-token");
  const event = {
    id: 401,
    event: "assigned",
    actor: payload.sender,
    assignee: { login: "forge-bot" },
    created_at: timestamp,
    issue,
  };
  const review = {
    ...event,
    id: 402,
    event: "review_requested",
    assignee: undefined,
    requested_reviewer: { login: "forge-bot" },
    issue: {
      ...issue,
      pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/1" },
    },
  };
  const mentioned = {
    ...event,
    id: 403,
    event: "mentioned",
    issue: { ...issue, body: "@forge-bot help" },
  };
  const pages = [
    new Response(JSON.stringify([event, review, mentioned]), {
      headers: {
        link: '<https://api.github.com/repos/owner/repo/issues/events?page=2>; rel="next"',
      },
    }),
    new Response(
      JSON.stringify([
        { ...event, id: 399, created_at: "2026-10-30T00:00:00Z" },
      ]),
      {
        headers: {
          link: '<https://api.github.com/repos/owner/repo/issues/events?page=3>; rel="next"',
        },
      },
    ),
    new Response(
      JSON.stringify([
        {
          ...comment,
          issue_url: "https://api.github.com/repos/owner/repo/issues/1",
        },
      ]),
      {
        headers: {
          link: '<https://api.github.com/repos/owner/repo/issues/comments?page=2>; rel="next"',
        },
      },
    ),
    new Response(JSON.stringify(issue)),
    new Response("[]"),
  ];
  const fetch = vi.fn(async () => pages.shift()!);
  vi.stubGlobal("fetch", fetch);
  try {
    await f.store.setCursor("github:owner/repo:since", "2026-10-31T00:00:00Z");
    const source = createGithubSource({
      login: "forge-bot",
      repos: ["owner/repo"],
      store: f.store,
      ingest: f.engine.ingest,
    });
    await source.catchUp();
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(await f.store.listTriggers()).toHaveLength(4);
    for (const item of [
      delivery(),
      delivery({
        id: "assignment",
        event: "issues",
        payload: {
          action: "assigned",
          sender: payload.sender,
          repository: payload.repository,
          issue,
          assignee: event.assignee,
        },
      }),
      delivery({
        id: "review",
        event: "pull_request",
        payload: {
          action: "review_requested",
          sender: payload.sender,
          repository: payload.repository,
          pull_request: { ...issue, id: 999 },
          requested_reviewer: review.requested_reviewer,
        },
      }),
      delivery({
        id: "mention",
        event: "issues",
        payload: {
          action: "opened",
          sender: payload.sender,
          repository: payload.repository,
          issue: mentioned.issue,
        },
      }),
    ]) {
      await f.store.recordDelivery(item);
      await source.processDelivery(item);
    }
    expect(await f.store.listTriggers()).toHaveLength(4);
    expect(await f.store.unprocessedDeliveries()).toEqual([]);
    expect(
      Date.parse((await f.store.getCursor("github:owner/repo:since"))!),
    ).toBeGreaterThan(Date.parse(timestamp));
    expect(JSON.stringify(await f.store.listTriggers())).not.toContain(
      "fixture-private-token",
    );
  } finally {
    await f.close();
  }
});

it("reprocesses persisted deliveries and leaves the catch-up cursor unchanged on failure", async () => {
  const f = await fixture();
  vi.spyOn(api, "githubToken").mockResolvedValue("fixture-private-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("secret error body", { status: 503 })),
  );
  try {
    const source = createGithubSource({
      login: "forge-bot",
      repos: ["owner/repo"],
      store: f.store,
      ingest: f.engine.ingest,
    });
    await f.store.recordDelivery(delivery());
    await source.recover();
    expect(await f.store.unprocessedDeliveries()).toEqual([]);
    expect(await f.store.listTriggers()).toHaveLength(1);
    await f.store.setCursor("github:owner/repo:since", timestamp);
    await expect(source.catchUp()).rejects.toThrow("HTTP 503");
    expect(await f.store.getCursor("github:owner/repo:since")).toBe(timestamp);
  } finally {
    await f.close();
  }
});
