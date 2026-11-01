import { createHash } from "node:crypto";
import { z } from "zod";
import type { Delivery, Thread, Trigger } from "../shared";

const user = z.object({ login: z.string() });
export const githubIssueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  user,
  created_at: z.string(),
  updated_at: z.string(),
  pull_request: z.object({ url: z.string() }).optional(),
});
const comment = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user,
  created_at: z.string(),
  updated_at: z.string(),
});
export const githubCommentSchema = comment.extend({ issue_url: z.string() });
export const githubIssueEventSchema = z.object({
  id: z.number(),
  event: z.string(),
  actor: user,
  created_at: z.string(),
  issue: githubIssueSchema,
  assignee: user.optional(),
  assigner: user.optional(),
  requested_reviewer: user.optional(),
  review_requester: user.optional(),
});
const payloadSchema = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  sender: user,
  issue: githubIssueSchema.optional(),
  pull_request: githubIssueSchema.optional(),
  comment: comment.optional(),
  review: z
    .object({
      id: z.number(),
      body: z.string().nullable(),
      user,
      submitted_at: z.string().nullable(),
    })
    .optional(),
  assignee: user.optional(),
  requested_reviewer: user.optional(),
});

export function mentionsGithubLogin(body: string, login: string): boolean {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w@-])@${escaped}(?![\\w-])`, "i").test(body);
}

export function normalizeGithubDelivery(
  delivery: Delivery,
  login: string,
): {
  triggers: Trigger[];
  threads: Thread[];
  reason: string | null;
} {
  if (
    ![
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
    ].includes(delivery.event)
  )
    return {
      triggers: [],
      threads: [],
      reason: `Unsupported GitHub event: ${delivery.event}.`,
    };
  const payload = payloadSchema.parse(delivery.payload);
  const issue = payload.issue ?? payload.pull_request;
  if (!issue)
    throw new Error("GitHub payload is missing its issue or pull_request.");
  const threadId = `gh:${payload.repository.full_name.toLowerCase()}#${issue.number}`;
  const object =
    delivery.event === "pull_request_review"
      ? payload.review
      : delivery.event.endsWith("comment")
        ? payload.comment
        : issue;
  if (!object)
    throw new Error(`GitHub payload is missing the ${delivery.event} object.`);
  const body = object.body ?? "";
  const sameLogin = (value: string | undefined) =>
    value?.toLowerCase() === login.toLowerCase();
  const explicit =
    mentionsGithubLogin(body, login) ||
    (payload.action === "assigned" && sameLogin(payload.assignee?.login)) ||
    (payload.action === "review_requested" &&
      sameLogin(payload.requested_reviewer?.login));
  let id: string;
  if (payload.comment) {
    const kind =
      delivery.event === "issue_comment" ? "comment" : "review-comment";
    id = `gh:${kind}:${payload.comment.id}`;
    if (payload.action !== "created")
      id += `:${payload.action}:${payload.comment.updated_at}`;
  } else if (payload.review) {
    id = `gh:review:${payload.review.id}:${payload.action}`;
    if (payload.action === "edited")
      id += `:${createHash("sha256").update(body).digest("hex")}`;
  } else if (["opened", "edited", "mentioned"].includes(payload.action)) {
    id = `${threadId}:body:${createHash("sha256").update(body).digest("hex")}`;
  } else if (["assigned", "review_requested"].includes(payload.action)) {
    // Webhooks omit REST issue-event IDs; thread, recipient and event time exist in both paths.
    const recipient =
      payload.assignee?.login ?? payload.requested_reviewer?.login ?? "";
    id = `${threadId}:${payload.action}:${recipient.toLowerCase()}:${new Date(issue.updated_at).toISOString()}`;
  } else {
    id = `gh:delivery:${delivery.id}`;
  }
  const thread: Thread = {
    id: threadId,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    lastTriggerAt: delivery.receivedAt,
  };
  return {
    threads: [thread],
    reason: null,
    triggers: [
      {
        id,
        source: "github",
        kind: `${delivery.event}.${payload.action}`,
        actor: payload.sender.login,
        explicit,
        threadId,
        summary: body || `${payload.action}: ${issue.title}`,
        payload: delivery.payload,
        receivedAt: delivery.receivedAt,
        disposition: null,
        reason: null,
      },
    ],
  };
}
