import { randomUUID } from "node:crypto";
import { createHarness, resolveStateDirectory } from "../core";
import {
  ForgeError,
  type HarnessOptions,
  type PublicSettings,
  type PublicSuperAgentSettings,
  type RuntimeHost,
  type SuperAgentEvent,
} from "../shared";
import { openSettingsStore, openSuperAgentStore } from "../store";
import {
  type OutboxExecutor,
  createGithubOutboxExecutor,
  createGithubSource,
  createSuperAgent,
} from "../superagent";
import { createGithubWebhook } from "./github-webhook";
import { createRuntimeHub } from "./runtime";

function requireConfiguration(
  config: PublicSuperAgentSettings,
  secret: string | undefined,
) {
  const { workspace, routerProfileId, workerProfileId } = config;
  const login = config.github?.login;
  const repos = config.github?.repos;
  const port = config.github?.webhook?.port;
  const board =
    config.workItems?.backend === "board"
      ? {
          "board.url": config.board?.url,
          "board.projectId": config.board?.projectId,
          "board.accountable": config.board?.accountable,
          "board.token": config.board?.hasToken,
          "board.reconnectDelay": config.board?.reconnectDelay !== undefined,
        }
      : {};
  if (
    !workspace ||
    !routerProfileId ||
    !workerProfileId ||
    !login ||
    !repos?.length ||
    !secret ||
    port === undefined ||
    Object.values(board).some((value) => !value)
  ) {
    const missing = Object.entries({
      workspace,
      routerProfileId,
      workerProfileId,
      "github.login": login,
      "github.repos": repos?.length,
      "github.webhookSecret": secret,
      "github.webhook.port": port !== undefined,
      ...board,
    })
      .filter(([, value]) => !value)
      .map(([key]) => `superAgent.${key}`);
    throw new ForgeError(
      "invalid_input",
      `Missing required settings: ${missing.join(", ")}.`,
    );
  }
  return {
    workspace,
    routerProfileId,
    workerProfileId,
    login,
    repos,
    port,
    secret,
    host: config.github?.webhook?.host,
    maxBodyBytes: config.github?.webhook?.maxBodyBytes,
  };
}

export async function createHostRuntime(
  options: Omit<HarnessOptions, "sessionTools" | "canReadSession"> & {
    superAgent?: boolean;
    outbox?: OutboxExecutor;
  } = {},
) {
  const directory = resolveStateDirectory(options.stateDir);
  const settings = await openSettingsStore(directory);
  const getPublic = async (): Promise<PublicSettings> => {
    const value = await settings.getPublic();
    return options.superAgent
      ? { ...value, superAgent: { ...value.superAgent, enabled: true } }
      : value;
  };
  const publicSettings = await getPublic();
  const config = publicSettings.superAgent?.enabled
    ? requireConfiguration(
        publicSettings.superAgent,
        await settings.getWebhookSecret(),
      )
    : undefined;
  if (config) {
    for (const key of ["routerProfileId", "workerProfileId"] as const)
      if (
        !publicSettings.agentProfiles?.some(
          (profile) => profile.id === config[key],
        )
      )
        throw new ForgeError(
          "invalid_input",
          `Unknown profile in superAgent.${key}: ${config[key]}.`,
        );
  }
  let engine: ReturnType<typeof createSuperAgent> | undefined;
  const harness = await createHarness({
    ...options,
    sessionTools: (session) => engine?.sessionTools(session),
    canReadSession: (reader, target) =>
      engine?.canReadSession(reader, target) ?? false,
  });
  let store: Awaited<ReturnType<typeof openSuperAgentStore>> | undefined;
  let webhook: Awaited<ReturnType<typeof createGithubWebhook>> | undefined;
  let runtime: RuntimeHost;
  const dispose = async () => {
    try {
      if (runtime) await runtime.dispose();
      else await harness.dispose();
    } finally {
      await store?.close();
    }
  };
  try {
    const listeners = new Set<(event: SuperAgentEvent) => void>();
    if (config) {
      store = await openSuperAgentStore(directory);
      if (!harness.inputQueue)
        throw new ForgeError(
          "not_found",
          "Super-agent requires the host input queue.",
        );
      engine = createSuperAgent({
        stateDirectory: directory,
        harness,
        inputQueue: harness.inputQueue,
        store,
        workItems: store.workItems,
        settings: { getPublic },
        outbox: options.outbox ?? createGithubOutboxExecutor(store.workItems),
        events: {
          emit: (event) => {
            for (const listener of listeners) listener(event);
          },
        },
        sessions: {
          isRunning: (id) =>
            runtime.hostState().runs.some((run) => run.sessionId === id),
          async steer(id, input) {
            const run = runtime
              .hostState()
              .runs.find((run) => run.sessionId === id);
            if (!run) return false;
            const response = await runtime.request({
              id: randomUUID(),
              method: "steerRun",
              runId: run.runId,
              ...(typeof input === "string" ? { prompt: input } : input),
            });
            if (response.ok) return true;
            if (
              response.error.code === "not_found" ||
              response.error.code === "cancelled"
            )
              return false;
            throw new ForgeError(
              response.error.code,
              response.error.message,
              response.error.retryable,
            );
          },
        },
      });
    }
    runtime = createRuntimeHub(harness, {
      superAgent: () => engine,
      superAgentEvents: (emit) => {
        listeners.add(emit);
        return () => {
          listeners.delete(emit);
        };
      },
    });
    if (engine && store && config) {
      const source = createGithubSource({
        login: config.login,
        repos: config.repos,
        store,
        ingest: engine.ingest,
      });
      await engine.start();
      await source.recover();
      webhook = await createGithubWebhook({
        host: config.host,
        port: config.port,
        maxBodyBytes: config.maxBodyBytes,
        secret: config.secret,
        store,
        processDelivery: source.processDelivery,
        onError: () =>
          console.error(
            "GitHub delivery processing failed; the persisted delivery will be retried at startup.",
          ),
      });
      try {
        await source.catchUp();
      } catch (error) {
        engine.reportCatchUpFailure(error);
      }
    }
    return { harness, runtime, webhook, dispose };
  } catch (error) {
    try {
      await webhook?.close();
    } finally {
      await dispose();
    }
    throw error;
  }
}
