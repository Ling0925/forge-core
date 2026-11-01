import { afterEach, expect, it, vi } from "vitest";
import {
  createGithubSource,
  normalizeGithubDelivery,
} from "../../src/superagent";
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
    actor: { login: "forge-bot" },
    created_at: "2026-10-31T11:59:59Z",
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

it("fetches each comment parent once across pages and refreshes it on the next pass", async () => {
  const f = await fixture();
  vi.spyOn(api, "githubToken").mockResolvedValue("fixture-private-token");
  const issueUrl = "https://api.github.com/repos/owner/repo/issues/1";
  const otherUrl = "https://api.github.com/repos/owner/repo/issues/2";
  const parents = new Map([
    [issueUrl, issue],
    [otherUrl, { ...issue, id: 102, number: 2, title: "Another issue" }],
  ]);
  const comments = [
    { ...comment, issue_url: issueUrl },
    { ...comment, id: 202, issue_url: issueUrl },
    { ...comment, id: 203, issue_url: issueUrl },
    { ...comment, id: 204, issue_url: otherUrl },
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input));
    if (parents.has(url.href))
      return new Response(JSON.stringify(parents.get(url.href)));
    if (url.pathname.endsWith("/events")) return new Response("[]");
    if (url.searchParams.has("page"))
      return new Response(JSON.stringify(comments.slice(2)));
    return new Response(JSON.stringify(comments.slice(0, 2)), {
      headers: {
        link: '<https://api.github.com/repos/owner/repo/issues/comments?page=2>; rel="next"',
      },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const ingest = vi.fn(async () => {});
  const source = createGithubSource({
    login: "forge-bot",
    repos: ["owner/repo"],
    store: f.store,
    ingest,
  });
  try {
    await f.store.setCursor("github:owner/repo:since", timestamp);
    for (const title of [issue.title, "Updated issue title"]) {
      parents.set(issueUrl, { ...issue, title });
      fetch.mockClear();
      ingest.mockClear();
      await source.catchUp();
      expect(fetch).toHaveBeenCalledTimes(5);
      for (const url of parents.keys())
        expect(
          fetch.mock.calls.filter(([input]) => input === url),
        ).toHaveLength(1);
      expect(ingest.mock.calls).toEqual(
        comments.map((comment) => {
          const normalized = normalizeGithubDelivery(
            delivery({
              id: `gh:comment:${comment.id}`,
              receivedAt: new Date(comment.updated_at).toISOString(),
              payload: {
                ...payload,
                sender: comment.user,
                issue: parents.get(comment.issue_url)!,
                comment,
              },
            }),
            "forge-bot",
          );
          return [normalized.triggers, normalized.threads];
        }),
      );
    }
  } finally {
    await f.close();
  }
});

it("collapses a mention and its comment into the explicit comment ID across catch-up and webhooks", async () => {
  const f = await fixture();
  vi.spyOn(api, "githubToken").mockResolvedValue("fixture-private-token");
  const mentioned = {
    id: 403,
    event: "mentioned",
    actor: { login: "FORGE-BOT" },
    created_at: timestamp,
    issue,
  };
  const authored = { ...comment, user: { login: "comment-author" } };
  const pages = [
    [mentioned],
    [
      {
        ...authored,
        issue_url: "https://api.github.com/repos/owner/repo/issues/1",
      },
    ],
    issue,
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(pages.shift()))),
  );
  const ingest = vi.fn(f.engine.ingest);
  const source = createGithubSource({
    login: "forge-bot",
    repos: ["owner/repo"],
    store: f.store,
    ingest,
  });
  try {
    await f.store.setCursor("github:owner/repo:since", timestamp);
    await source.catchUp();
    expect(ingest).toHaveBeenCalledOnce();
    expect(await f.store.listTriggers()).toEqual([
      expect.objectContaining({
        id: "gh:comment:201",
        kind: "issue_comment.created",
        actor: "comment-author",
        explicit: true,
        threadId: "gh:owner/repo#1",
      }),
    ]);
    const webhook = delivery({
      payload: { ...payload, sender: authored.user, comment: authored },
    });
    await f.store.recordDelivery(webhook);
    await source.processDelivery(webhook);
    expect(await f.store.listTriggers()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each([
  "no comment",
  "different issue",
  "different timestamp",
  "different recipient",
])("keeps an unmatched mentioned event explicit (%s)", async (mismatch) => {
  const f = await fixture();
  vi.spyOn(api, "githubToken").mockResolvedValue("fixture-private-token");
  const bodyIssue = { ...issue, body: "@forge-bot help with the issue body" };
  const parent =
    mismatch === "different issue"
      ? { ...issue, id: 102, number: 2 }
      : bodyIssue;
  const candidate = {
    ...comment,
    body:
      mismatch === "different recipient" ? "@somebody-else help" : comment.body,
    created_at:
      mismatch === "different timestamp" ? "2026-10-31T12:00:01Z" : timestamp,
    updated_at:
      mismatch === "different timestamp" ? "2026-10-31T12:00:01Z" : timestamp,
    issue_url: `https://api.github.com/repos/owner/repo/issues/${parent.number}`,
  };
  const pages = [
    [
      {
        id: 403,
        event: "mentioned",
        actor: { login: "forge-bot" },
        created_at: timestamp,
        issue: bodyIssue,
      },
    ],
    mismatch === "no comment" ? [] : [candidate],
    parent,
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(pages.shift()))),
  );
  const source = createGithubSource({
    login: "forge-bot",
    repos: ["owner/repo"],
    store: f.store,
    ingest: f.engine.ingest,
  });
  try {
    await f.store.setCursor("github:owner/repo:since", timestamp);
    await source.catchUp();
    const triggers = await f.store.listTriggers();
    expect(triggers).toHaveLength(mismatch === "no comment" ? 1 : 2);
    expect(triggers).toContainEqual(
      expect.objectContaining({
        kind: "issues.mentioned",
        explicit: true,
        threadId: "gh:owner/repo#1",
      }),
    );
  } finally {
    await f.close();
  }
});
