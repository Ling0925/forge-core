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
  mentionsGithubLogin,
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
        const ingest = async (delivery: unknown, explicit?: true) => {
          const value = normalizeGithubDelivery(
            deliverySchema.parse(delivery),
            options.login,
          );
          await options.ingest(
            explicit
              ? value.triggers.map((trigger) => ({ ...trigger, explicit }))
              : value.triggers,
            value.threads,
          );
        };
        const mentions = new Map<
          string,
          z.infer<typeof githubIssueEventSchema>[]
        >();
        const mentionKey = (number: number, time: string) =>
          `${number}:${Date.parse(time)}`;
        const ingestEvent = (event: z.infer<typeof githubIssueEventSchema>) => {
          const issue = event.issue;
          return ingest(
            {
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
            },
            event.event === "mentioned" ? true : undefined,
          );
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
            if (event.event === "mentioned") {
              // GitHub's mentioned actor is the recipient, not the comment author.
              if (
                event.actor.login.toLowerCase() === options.login.toLowerCase()
              ) {
                const key = mentionKey(event.issue.number, event.created_at);
                const matches = mentions.get(key) ?? [];
                matches.push(event);
                mentions.set(key, matches);
              }
            } else await ingestEvent(event);
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
            const matchedMention =
              mentionsGithubLogin(comment.body ?? "", options.login) &&
              mentions.delete(mentionKey(issue.number, comment.created_at));
            await ingest({
              id: `gh:comment:${comment.id}`,
              event: "issue_comment",
              receivedAt: new Date(comment.updated_at).toISOString(),
              processedAt: null,
              payload: {
                action:
                  matchedMention || comment.created_at === comment.updated_at
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
        for (const events of mentions.values())
          for (const event of events) await ingestEvent(event);
        await options.store.setCursor(key, until);
      }
    },
  };
}
