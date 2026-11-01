import { spawn } from "node:child_process";
import { ForgeError } from "../shared";

export function githubToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["auth", "token"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const failed = () =>
      reject(
        new ForgeError(
          "invalid_input",
          "GitHub authentication failed; run gh auth login on this host.",
        ),
      );
    child.once("error", failed);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8").trim())
        : failed(),
    );
  });
}

export async function githubRequest(
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ForgeError("provider", "GitHub request failed.");
  }
  if (!response.ok)
    throw new ForgeError(
      "provider",
      `GitHub request failed (HTTP ${response.status}).`,
    );
  return response;
}

export function githubNextPage(response: Response): string | undefined {
  const next = response.headers
    .get("link")
    ?.split(",")
    .find((link) => /rel="next"/.test(link));
  const url = next?.match(/<([^>]+)>/)?.[1];
  if (!url) return undefined;
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}
