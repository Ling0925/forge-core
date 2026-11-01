import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createHostRuntime } from "../../src/host";
import {
  type ConfigureInput,
  type HarnessOptions,
  type RpcRequest,
  agentProfileTemplates,
  rpcRequestSchema,
  rpcResponseSchema,
} from "../../src/shared";
import { openSettingsStore, openSuperAgentStore } from "../../src/store";
import type { OutboxExecutor } from "../../src/superagent";
import { createWebHost } from "../../src/web";

export const http = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
) =>
  new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve(
          new Response(Buffer.concat(chunks), {
            status: res.statusCode!,
            headers: res.headers as Record<string, string>,
          }),
        ),
      );
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });

export async function hostFixture(
  options: {
    providerFactory?: HarnessOptions["providerFactory"];
    enabled?: boolean;
    force?: boolean;
    config?: NonNullable<ConfigureInput["settings"]>["superAgent"];
    since?: string;
    maxBodyBytes?: number;
    board?: NonNullable<
      NonNullable<ConfigureInput["settings"]>["superAgent"]
    >["board"];
    localTools?: boolean;
    beforeStart?: (stateDir: string) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "forge-superagent-host-"));
  const stateDir = join(directory, "state");
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  vi.stubEnv("FORGE_HOME", stateDir);
  for (const name of ["FORGE_API_KEY", "FORGE_BASE_URL", "FORGE_MODEL"])
    vi.stubEnv(name, undefined);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", workspace, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: "pipe",
    });
  git("init", "-q");
  await writeFile(join(workspace, "tracked.txt"), "fixture\n");
  git("add", "tracked.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const settings = await openSettingsStore(stateDir);
  await settings.update({
    settings: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: "fixture",
      defaultPermission: "unrestricted",
      superAgent: options.config ?? {
        enabled: options.enabled ?? true,
        workspace,
        routerProfileId: "router",
        workerProfileId: "worker",
        ...(options.board
          ? { board: options.board, workItems: { backend: "board" } }
          : {}),
        github: {
          login: "forge-bot",
          repos: ["owner/repo"],
          webhook: {
            host: "127.0.0.1",
            port: 0,
            ...(options.maxBodyBytes === undefined
              ? {}
              : { maxBodyBytes: options.maxBodyBytes }),
          },
          webhookSecret: "fixture-secret",
        },
      },
    },
  });
  for (const id of ["router", "worker"])
    await settings.update({
      agent: {
        type: "save",
        expectedRevision: 0,
        profile: {
          ...agentProfileTemplates[0]!,
          id,
          name: id,
          instructions: `Fixture ${id}`,
          permission: "workspace",
          tools: { mode: "inherit" },
        },
      },
    });
  const outbox = { execute: vi.fn<OutboxExecutor["execute"]>(async () => {}) };
  let hosted: Awaited<ReturnType<typeof createHostRuntime>>;
  try {
    await options.beforeStart?.(stateDir);
    if (options.since) {
      const store = await openSuperAgentStore(stateDir);
      try {
        await store.setCursor("github:owner/repo:since", options.since);
      } finally {
        await store.close();
      }
    }
    hosted = await createHostRuntime({
      stateDir,
      superAgent: options.force ?? false,
      outbox,
      providerFactory:
        options.providerFactory ??
        (() => ({
          listModels: async () => ["fixture"],
          complete: async () => ({
            message: { role: "assistant", content: "Done." },
          }),
        })),
      ...(options.localTools
        ? {}
        : {
            toolFactory: () => ({
              definitions: [],
              execute: async () => {
                throw new Error("Unexpected tool");
              },
              dispose: async () => {},
            }),
          }),
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    throw error;
  }
  const web = await createWebHost({
    runtime: hosted.runtime,
    workspace,
    host: "127.0.0.1",
    port: 5173,
  });
  web.server.on("request", (req, res) => {
    void web.handle(req, res, () => res.end());
  });
  await new Promise<void>((resolve) =>
    web.server.listen(0, "127.0.0.1", resolve),
  );
  const address = web.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing host address");
  const url = `http://127.0.0.1:${address.port}`;
  const headers = {
    Host: "127.0.0.1:5173",
    Origin: web.origin,
    "Content-Type": "application/json",
  };
  const connected = await (
    await http(`${url}/api/connect`, headers, {})
  ).json();
  const auth = { ...headers, "X-Forge-Client": connected.clientId as string };
  const rpc = async (input: Omit<RpcRequest, "id"> | object) =>
    rpcResponseSchema.parse(
      await (
        await http(
          `${url}/api/rpc`,
          auth,
          rpcRequestSchema.parse({ id: randomUUID(), ...input }),
        )
      ).json(),
    );
  const webhookAddress = hosted.webhook?.server.address();
  const webhookUrl =
    webhookAddress && typeof webhookAddress !== "string"
      ? `http://127.0.0.1:${webhookAddress.port}`
      : undefined;
  return {
    ...hosted,
    directory,
    workspace,
    outbox,
    web,
    url,
    auth,
    rpc,
    webhookUrl,
    async send(payload: unknown, id: string = randomUUID(), signed = true) {
      const body = JSON.stringify(payload);
      return fetch(webhookUrl!, {
        method: "POST",
        body,
        headers: {
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": id,
          ...(signed
            ? {
                "X-Hub-Signature-256": `sha256=${createHmac("sha256", "fixture-secret").update(body).digest("hex")}`,
              }
            : {}),
        },
      });
    },
    async close() {
      try {
        await Promise.all([web.close(), hosted.webhook?.close()]);
      } finally {
        await hosted.dispose();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
