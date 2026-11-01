import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { boardTaskSchema } from "../../src/store/board-api";

export const taskSchema = boardTaskSchema.extend({
  accountable: z.string(),
  links: z.array(z.object({ kind: z.string(), ref: z.string() })),
});
export async function boardFixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-board-e2e-"));
  const cli = resolve("node_modules/forge-board/dist/cli.js");
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    FORGE_HOME: directory,
  };
  const command = async (...args: string[]): Promise<unknown> =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [cli, ...args, "--data", directory],
          { env },
        )
      ).stdout,
    );
  let server: ChildProcess | undefined;
  const close = async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exit = once(server, "exit");
      server.kill();
      await exit;
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const human = z
      .object({ principal: z.object({ id: z.string() }), secret: z.string() })
      .parse(await command("init", "--name", "Fixture human"));
    const project = z
      .object({ id: z.string() })
      .parse(
        await command(
          "project",
          "create",
          "--token",
          human.secret,
          "--key",
          "FORGE",
          "--name",
          "Fixture",
          "--settings",
          JSON.stringify({ allowAgentCancel: true }),
        ),
      );
    const agent = z
      .object({ id: z.string() })
      .parse(
        await command(
          "principal",
          "create",
          "--token",
          human.secret,
          "--kind",
          "agent",
          "--name",
          "Forge",
          "--owner",
          human.principal.id,
        ),
      );
    const token = z
      .object({ secret: z.string() })
      .parse(
        await command(
          "token",
          "create",
          "--token",
          human.secret,
          "--principal",
          agent.id,
          "--scopes",
          "tasks:read,tasks:write,tasks:claim",
          "--projects",
          project.id,
        ),
      );
    server = spawn(
      process.execPath,
      [cli, "serve", "--data", directory, "--port", "0"],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const child = server;
    const url = await new Promise<string>((resolve, reject) => {
      let log = "";
      child.on("error", reject);
      child.on("exit", (code) =>
        reject(new Error(`Board exited: ${code}\n${log}`)),
      );
      child.stderr!.on("data", (chunk: Buffer) => {
        log += chunk.toString();
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        log += chunk.toString();
        const match = /forge-board listening on (http:\/\/[^\s]+)/.exec(log);
        if (match) resolve(match[1]!);
      });
    });
    const request = async (
      path: string,
      init: RequestInit = {},
    ): Promise<unknown> => {
      const response = await fetch(new URL(path, url), {
        ...init,
        headers: {
          Authorization: `Bearer ${human.secret}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(body));
      return body;
    };
    return {
      directory,
      url,
      projectId: project.id,
      accountable: human.principal.id,
      token: token.secret,
      config: {
        url,
        projectId: project.id,
        accountable: human.principal.id,
        token: token.secret,
        reconnectDelay: 10,
      },
      request,
      task: async (id: string) =>
        taskSchema.parse(await request(`/v1/tasks/${id}?include=links`)),
      tasks: async () =>
        z
          .object({ items: z.array(taskSchema) })
          .parse(await request(`/v1/tasks?project=${project.id}&include=links`))
          .items,
      async transition(id: string, to: string) {
        const task = await request(`/v1/tasks/${id}`);
        return request(`/v1/tasks/${id}/transition`, {
          method: "POST",
          headers: { "If-Match": `"${boardTaskSchema.parse(task).version}"` },
          body: JSON.stringify({ to }),
        });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
