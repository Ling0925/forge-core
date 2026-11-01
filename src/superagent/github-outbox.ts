import { spawn } from "node:child_process";
import { ForgeError, type WorkItemStore } from "../shared";
import type { OutboxExecutor } from "./engine";
import { githubRequest, githubToken } from "./github-api";

function threadTarget(thread: string) {
  const match = /^gh:([^/]+\/[^#]+)#(\d+)$/.exec(thread);
  if (!match)
    throw new ForgeError(
      "invalid_input",
      "Expected a GitHub thread: gh:owner/repo#number.",
    );
  return { repo: match[1], number: match[2] };
}

function git(worktree: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", worktree, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const failed = () =>
      reject(new ForgeError("tool", "GitHub git operation failed."));
    child.once("error", failed);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8").trim())
        : failed(),
    );
  });
}

export function createGithubOutboxExecutor(
  workItems: WorkItemStore,
): OutboxExecutor {
  return {
    async execute(item) {
      const token = await githubToken();
      if (item.kind === "comment" || item.kind === "label") {
        const { repo, number } = threadTarget(item.target.thread);
        const suffix = item.kind === "comment" ? "comments" : "labels";
        const body =
          item.kind === "comment" ? { body: item.body.text } : item.body;
        await githubRequest(
          `/repos/${repo}/issues/${number}/${suffix}`,
          token,
          body,
        );
        return;
      }
      const work = await workItems.get(item.workId);
      if (!work) throw new ForgeError("not_found", "Work item was not found.");
      if (!work.worktree)
        throw new ForgeError("invalid_input", "Work item has no worktree.");
      const origin = await git(work.worktree, [
        "remote",
        "get-url",
        "--push",
        "origin",
      ]);
      const repo = origin
        .replace(/^(?:https?:\/\/|ssh:\/\/)?(?:[^/@]+@)?github\.com[:/]/, "")
        .replace(/\.git$/, "");
      if (item.kind === "pull_request") {
        await githubRequest(`/repos/${repo}/pulls`, token, item.body);
        return;
      }
      const authorization = Buffer.from(`x-access-token:${token}`).toString(
        "base64",
      );
      await git(work.worktree, [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${authorization}`,
        "-c",
        `remote.origin.pushurl=https://github.com/${repo}.git`,
        "push",
        "origin",
        `HEAD:refs/heads/${item.body.branch}`,
      ]);
    },
  };
}
