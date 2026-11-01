import { describe, expect, it } from "vitest";
import {
  mentionsGithubLogin,
  normalizeGithubDelivery,
} from "../../src/superagent";
import { delivery, issue, payload, timestamp } from "./github-fixture";

describe("GitHub normalization", () => {
  it.each([
    ["@forge-bot", true],
    ["hello @FoRgE-BoT!", true],
    ["(@forge-bot)\n", true],
    ["@forge-bot-other", false],
    ["@forge-bots", false],
    ["@forge-bot_2", false],
    ["mail@forge-bot", false],
    ["@@forge-bot", false],
    ["forge-bot", false],
    ["", false],
  ])("detects login boundaries in %j", (body, explicit) => {
    expect(mentionsGithubLogin(body, "forge-bot")).toBe(explicit);
  });

  it.each([
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
  ])("uses the %s object's body", (event) => {
    for (const explicit of [true, false]) {
      const body = explicit ? "@FORGE-BOT help" : "@someone-else help";
      const object = { ...issue, body };
      const value = {
        action:
          event === "pull_request_review"
            ? "submitted"
            : event.endsWith("comment")
              ? "created"
              : "opened",
        repository: payload.repository,
        sender: payload.sender,
        ...(event.startsWith("pull_request")
          ? {
              pull_request: {
                ...object,
                body: event === "pull_request" ? body : "@forge-bot stale body",
              },
            }
          : {
              issue: {
                ...object,
                body: event === "issues" ? body : "@forge-bot stale body",
              },
            }),
        ...(event.endsWith("comment")
          ? { comment: { ...payload.comment, body } }
          : {}),
        ...(event === "pull_request_review"
          ? {
              review: {
                id: 300,
                body,
                user: payload.sender,
                submitted_at: timestamp,
              },
            }
          : {}),
      };
      const result = normalizeGithubDelivery(
        delivery({ event, payload: value }),
        "forge-bot",
      );
      expect(result.reason).toBeNull();
      expect(result.triggers[0]).toMatchObject({
        explicit,
        threadId: "gh:owner/repo#1",
        summary: body,
      });
      expect(result.threads[0]).toMatchObject({
        id: "gh:owner/repo#1",
        title: issue.title,
      });
    }
  });

  it.each([
    ["assigned", "assignee", "FORGE-BOT", true],
    ["assigned", "assignee", "other", false],
    ["unassigned", "assignee", "forge-bot", false],
    ["opened", "assignee", "forge-bot", false],
    ["review_requested", "requested_reviewer", "FORGE-BOT", true],
    ["review_requested", "requested_reviewer", "other", false],
    ["review_request_removed", "requested_reviewer", "forge-bot", false],
    ["review_requested", "requested_team", "forge-bot", false],
  ])(
    "authorizes %s/%s/%s only when explicit",
    (action, field, login, explicit) => {
      const value = {
        action,
        repository: payload.repository,
        sender: payload.sender,
        pull_request: issue,
        [field]: { login },
      };
      expect(
        normalizeGithubDelivery(
          delivery({ event: "pull_request", payload: value }),
          "forge-bot",
        ).triggers[0]?.explicit,
      ).toBe(explicit);
    },
  );

  it("uses object IDs across deliveries and preserves separate comment edits", () => {
    const first = normalizeGithubDelivery(delivery(), "forge-bot");
    const repeat = normalizeGithubDelivery(
      delivery({ id: "another-delivery" }),
      "forge-bot",
    );
    expect(first.triggers[0]?.id).toBe("gh:comment:201");
    expect(repeat.triggers[0]?.id).toBe(first.triggers[0]?.id);
    const edit = normalizeGithubDelivery(
      delivery({ payload: { ...payload, action: "edited" } }),
      "forge-bot",
    );
    expect(edit.triggers[0]?.id).not.toBe(first.triggers[0]?.id);
  });

  it("derives other action IDs from the delivery and explains unsupported events", () => {
    const closed = delivery({
      event: "issues",
      payload: {
        action: "closed",
        repository: payload.repository,
        sender: payload.sender,
        issue,
      },
    });
    expect(normalizeGithubDelivery(closed, "forge-bot").triggers[0]?.id).toBe(
      "gh:delivery:delivery-1",
    );
    expect(
      normalizeGithubDelivery(delivery({ event: "push" }), "forge-bot"),
    ).toEqual({
      triggers: [],
      threads: [],
      reason: "Unsupported GitHub event: push.",
    });
  });
});
