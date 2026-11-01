import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createHarness } from "../../src/core";
import {
  type ModelProvider,
  type ProviderResponse,
  type QueuedInput,
  type SessionId,
  type SteeringHandler,
  type SuperAgentEvent,
  type Thread,
  type Trigger,
  agentProfileTemplates,
  queuedInputSchema,
} from "../../src/shared";
import { openSuperAgentStore } from "../../src/store";
import { type SuperAgentDeps, createSuperAgent } from "../../src/superagent";

type Step = ProviderResponse | ModelProvider["complete"];
export const done: ProviderResponse = {
  message: { role: "assistant", content: "Finished." },
};
export const call = (name: string, args: unknown): ProviderResponse => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
export function hold() {
  const entered = deferred();
  const release = deferred();
  const step: ModelProvider["complete"] = async (
    _messages,
    _tools,
    { signal },
  ) => {
    entered.resolve();
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return done;
  };
  return { entered: entered.promise, release: release.resolve, step };
}

export const trigger = (
  id: string,
  options: Partial<Trigger> = {},
): Trigger => ({
  id: `gh:${id}`,
  source: "github",
  kind: "issue_comment",
  actor: "contributor",
  explicit: true,
  threadId: `gh:owner/repo#${id}`,
  summary: `Trigger ${id}`,
  payload: { body: "Please investigate." },
  receivedAt: "2026-11-01T00:00:00.000Z",
  disposition: null,
  reason: null,
  ...options,
});
export const thread = (event: Trigger): Thread => ({
  id: event.threadId,
  title: `Thread ${event.threadId}`,
  url: "https://github.com/owner/repo/issues/1",
  state: "open",
  lastTriggerAt: event.receivedAt,
});
export const newDecision = (event: Trigger) => ({
  type: "new",
  threads: [event.threadId],
  triggers: [event.id],
  brief: `Investigate ${event.id}.`,
});

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-superagent-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  vi.stubEnv("FORGE_HOME", join(directory, "state"));
  for (const name of ["FORGE_MODEL", "FORGE_BASE_URL", "FORGE_API_KEY"])
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
  const scripts = new Map<string, Step[]>();
  let engine: ReturnType<typeof createSuperAgent>;
  const harness = await createHarness({
    stateDir: join(directory, "state"),
    providerFactory: () => ({
      listModels: async () => ["fixture"],
      complete: async (...args) => {
        const step = scripts.get(args[2].sessionId!)?.shift() ?? done;
        return typeof step === "function" ? step(...args) : step;
      },
    }),
    toolFactory: () => ({
      definitions: [],
      execute: async () => {
        throw new Error("Unexpected tool");
      },
      dispose: async () => {},
    }),
    sessionTools: (session) => engine.sessionTools(session),
    canReadSession: (reader, target) => engine.canReadSession(reader, target),
  });
  await harness.updateSettings({
    settings: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: "fixture",
      defaultPermission: "unrestricted",
      superAgent: {
        enabled: true,
        workspace,
        routerProfileId: "router",
        workerProfileId: "worker",
        github: { login: "forge-bot", repos: ["owner/repo"] },
      },
    },
  });
  for (const id of ["router", "worker"])
    await harness.updateSettings({
      agent: {
        type: "save",
        expectedRevision: 0,
        profile: {
          ...agentProfileTemplates[0]!,
          id,
          name: id,
          instructions: `Fixture ${id}.`,
          permission: "workspace",
          tools: { mode: "inherit" },
        },
      },
    });
  let store = await openSuperAgentStore(join(directory, "state"));
  const items: QueuedInput[] = [];
  const running = new Set<SessionId>();
  const handlers = new Map<SessionId, SteeringHandler>();
  const inputQueue: SuperAgentDeps["inputQueue"] = {
    notify: vi.fn(async (request, origin) => {
      const item = queuedInputSchema.parse({
        ...request,
        sessionId: request.input.sessionId,
        origin,
        sequence: items.length + 1,
        state: "queued",
        acceptedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runId: null,
        selection: { model: "fixture", mode: "build", permission: "workspace" },
      });
      items.push(item);
      return item;
    }),
    list: async (sessionId) => ({
      sessionId,
      paused: false,
      items: items.filter((item) => item.sessionId === sessionId),
    }),
    cancel: async (sessionId, inputId) => {
      const index = items.findIndex(
        (item) =>
          item.sessionId === sessionId &&
          item.inputId === inputId &&
          item.state === "queued",
      );
      if (index === -1) return false;
      items[index] = { ...items[index]!, state: "cancelled" };
      return true;
    },
    resume: async (sessionId) => inputQueue.list(sessionId),
  };
  const events: SuperAgentEvent[] = [];
  const outbox = {
    execute: vi.fn<SuperAgentDeps["outbox"]["execute"]>(async () => {}),
  };
  const sessions: SuperAgentDeps["sessions"] = {
    isRunning: (id) => running.has(id),
    steer: vi.fn(async (id, input) => {
      const handler = handlers.get(id);
      if (!handler) return false;
      await handler(input);
      return true;
    }),
  };
  const deps: SuperAgentDeps = {
    harness,
    inputQueue,
    sessions,
    store,
    workItems: store.workItems,
    settings: { getPublic: () => harness.getSettings() },
    outbox,
    events: { emit: (event) => events.push(event) },
  };
  engine = createSuperAgent(deps);
  await engine.start();
  const operations = new Set<Promise<unknown>>();
  const runNext = (sessionId: SessionId, steps: Step[] = []) => {
    const index = items.findIndex(
      (item) => item.sessionId === sessionId && item.state === "queued",
    );
    if (index === -1) throw new Error("No queued input");
    const item = items[index]!;
    items[index] = { ...item, state: "bound" };
    running.add(sessionId);
    scripts.set(sessionId, steps);
    const operation = harness
      .run(
        item.input!,
        () => {},
        async () => false,
        new AbortController().signal,
        {
          inputOrigin: item.origin,
          drainSteering: () => [],
          setSteeringHandler: (handler) => {
            if (handler) handlers.set(sessionId, handler);
            else handlers.delete(sessionId);
          },
        },
      )
      .finally(async () => {
        running.delete(sessionId);
        items[index] = { ...items[index]!, state: "consumed" };
        await engine.sessionSettled();
      });
    operations.add(operation);
    void operation
      .finally(() => operations.delete(operation))
      .catch(() => undefined);
    return operation;
  };
  const router = async () =>
    (await harness.listSessions()).find(
      (session) => session.agentRole?.kind === "router",
    )!;
  return {
    directory,
    workspace,
    harness,
    get store() {
      return store;
    },
    inputQueue,
    outbox,
    events,
    items,
    sessions,
    get engine() {
      return engine;
    },
    async restart() {
      await store.close();
      store = await openSuperAgentStore(join(directory, "state"));
      engine = createSuperAgent({ ...deps, store, workItems: store.workItems });
      await engine.start();
    },
    ingest: (...triggers: Trigger[]) =>
      engine.ingest(triggers, triggers.map(thread)),
    router,
    runNext,
    async createWork(event = trigger("1")) {
      await engine.ingest([event], [thread(event)]);
      await runNext((await router()).id, [
        call("superagent_route", { decisions: [newDecision(event)] }),
      ]);
      return (await store.workItems.list())[0]!;
    },
    async close() {
      await harness.dispose();
      await Promise.allSettled(operations);
      await store.close();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
