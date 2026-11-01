import { z } from "zod";
import {
  type Delivery,
  type Thread,
  type Trigger,
  deliverySchema,
} from "../shared";
import type { SuperAgentStore } from "../store";
import {
  githubCommentSchema,
  githubIssueEventSchema,
  githubIssueSchema,
  normalizeGithubDelivery,
} from "./github";
import { githubNextPage, githubRequest, githubToken } from "./github-api";

export function createGithubSource(options: {
  login: string;
  repos: readonly string[];
  store: SuperAgentStore;
  ingest(
    triggers: readonly Trigger[],
    threads: readonly Thread[],
  ): Promise<void>;
}) {
  const processDelivery = async (delivery: Delivery) => {
    const normalized = normalizeGithubDelivery(delivery, options.login);
    await options.ingest(normalized.triggers, normalized.threads);
    await options.store.markDeliveryProcessed(delivery.id);
    return normalized.reason;
  };
  return {
    processDelivery,
    async recover() {
      for (const delivery of await options.store.unprocessedDeliveries())
        await processDelivery(delivery);
    },
    async catchUp() {
      let token: string | undefined;
      const issues = new Map<string, z.infer<typeof githubIssueSchema>>();
      for (const repo of options.repos) {
        const key = `github:${repo}:since`;
        const until = new Date().toISOString();
        const since = await options.store.getCursor(key);
        if (!since) {
          await options.store.setCursor(key, until);
          continue;
        }
        token ??= await githubToken();
        const ingest = async (delivery: unknown) => {
          const value = normalizeGithubDelivery(
            deliverySchema.parse(delivery),
            options.login,
          );
          await options.ingest(value.triggers, value.threads);
        };
        let path: string | undefined = `/repos/${repo}/issues/events`;
        while (path) {
          const response = await githubRequest(path, token);
          const events = z
            .array(githubIssueEventSchema)
            .parse(await response.json());
          let older = false;
          for (const event of events) {
            if (Date.parse(event.created_at) < Date.parse(since)) {
              older = true;
              break;
            }
            if (
              !["mentioned", "assigned", "review_requested"].includes(
                event.event,
              )
            )
              continue;
            const issue = event.issue;
            await ingest({
              id: `gh:event:${event.id}`,
              event: issue.pull_request ? "pull_request" : "issues",
              receivedAt: new Date(event.created_at).toISOString(),
              processedAt: null,
              payload: {
                action: event.event,
                repository: { full_name: repo },
                sender:
                  event.assigner ??
                  event.review_requester ??
                  (event.event === "mentioned" ? issue.user : event.actor),
                issue: { ...issue, updated_at: event.created_at },
                ...(event.assignee ? { assignee: event.assignee } : {}),
                ...(event.requested_reviewer
                  ? { requested_reviewer: event.requested_reviewer }
                  : {}),
              },
            });
          }
          path = older ? undefined : githubNextPage(response);
        }
        path = `/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}`;
        while (path) {
          const response = await githubRequest(path, token);
          const comments = z
            .array(githubCommentSchema)
            .parse(await response.json());
          for (const comment of comments) {
            let issue = issues.get(comment.issue_url);
            if (!issue) {
              const issuePath = new URL(comment.issue_url).pathname;
              issue = githubIssueSchema.parse(
                await (await githubRequest(issuePath, token)).json(),
              );
              issues.set(comment.issue_url, issue);
            }
            await ingest({
              id: `gh:comment:${comment.id}`,
              event: "issue_comment",
              receivedAt: new Date(comment.updated_at).toISOString(),
              processedAt: null,
              payload: {
                action:
                  comment.created_at === comment.updated_at
                    ? "created"
                    : "edited",
                repository: { full_name: repo },
                sender: comment.user,
                issue,
                comment,
              },
            });
          }
          path = githubNextPage(response);
        }
        await options.store.setCursor(key, until);
      }
    },
  };
}
