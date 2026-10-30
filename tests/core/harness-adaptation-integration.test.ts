import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import type {
  HarnessService,
  ModelProvider,
  RunControl,
} from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import type { HarnessAdaptationOptions } from "../../src/shared/harness-adaptation";
import type { AgentEvent, RunInput } from "../../src/shared/schemas";
import { openHarnessExperienceStore } from "../../src/store/harness-experiences";
import {
  createAdaptationFixture,
  fixtureStrategy,
  response,
  toolResponse,
} from "../fixtures/harness-adaptation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
async function setup(formal?: ModelProvider["complete"]) {
  const root = await mkdtemp(join(tmpdir(), "forge-adaptation-integration-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  vi.stubEnv("FORGE_HOME", state);
  vi.stubEnv("HOME", root);
  await mkdir(workspace);
  await writeFile(join(workspace, "fixture.txt"), "original\n");
  const model = createAdaptationFixture(formal ? { formal } : {});
  const open = async (): Promise<HarnessService> => {
    const service = await createHarness({
      stateDir: state,
      providerFactory: () => model.provider,
    });
    cleanups.push(() => service.dispose());
    await service.updateSettings({
      apiKey: "fixture-test-key-only",
      settings: {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fixture-model",
        apiMode: "chat-completions",
        defaultPermission: "workspace",
      },
    });
    return service;
  };
  const service = await open();
  const events: AgentEvent[] = [];
  const onEvent = (event: AgentEvent) => {
    events.push(event);
    if (event.type === "harness_adaptation") model.onProgress(event.progress);
  };
  const run = async (
    harness: HarnessAdaptationOptions | undefined = {
      candidates: 1,
      maxProbeTurns: 2,
      experience: "read-write",
    },
    extra: Partial<RunInput> = {},
    control?: RunControl,
  ) => {
    const session = await service.createSession({
      workspace,
      title: "Offline harness test",
    });
    return service.run(
      {
        sessionId: session.id,
        prompt: "Inspect the fixture and verify the outcome.",
        permission: "workspace",
        ...(harness ? { harness } : {}),
        ...extra,
      },
      onEvent,
      async () => false,
      new AbortController().signal,
      control,
    );
  };
  const experiences = async () =>
    (await openHarnessExperienceStore(state)).list({
      workspace,
      model: "fixture-model",
      domain: "general",
    });
  return {
    root,
    state,
    workspace,
    model,
    service,
    open,
    events,
    onEvent,
    run,
    experiences,
  };
}

it("runs preflight without transferring read authority, then edits exactly once and accounts for auxiliary usage", async () => {
  let formalCalls = 0;
  const f = await setup(async (messages) => {
    const last = messages.at(-1);
    formalCalls++;
    if (formalCalls === 1) {
      expect(
        JSON.stringify(messages.filter((message) => message.role === "system")),
      ).not.toContain("HARNESS_FIXTURE_STRATEGY");
      expect(
        messages.some(
          (message) =>
            message.role === "user" &&
            message.origin === "agent_reconciliation" &&
            message.content.includes("HARNESS_FIXTURE_STRATEGY"),
        ),
      ).toBe(true);
      expect(JSON.stringify(messages)).not.toContain("PREVIEW_ONLY");
      return toolResponse("write_file", {
        path: "fixture.txt",
        content: "must not be written\n",
      });
    }
    if (formalCalls === 2) {
      expect(JSON.parse(last?.content ?? "{}")).toMatchObject({
        isError: true,
      });
      expect(await readFile(join(f.workspace, "fixture.txt"), "utf8")).toBe(
        "original\n",
      );
      return toolResponse("read_file", { path: "fixture.txt" });
    }
    if (formalCalls === 3)
      return toolResponse("write_file", {
        path: "fixture.txt",
        content: "verified change\n",
      });
    expect(JSON.parse(last?.content ?? "{}")).toMatchObject({ isError: false });
    return response("formal task completed");
  });
  const result = await f.run();
  expect(result.status).toBe("completed");
  expect(result.changes).toHaveLength(1);
  expect(await readFile(join(f.workspace, "fixture.txt"), "utf8")).toBe(
    "verified change\n",
  );
  expect(JSON.stringify(result.messages)).not.toContain("PREVIEW_ONLY");
  expect(formalCalls).toBe(4);
  const terminal = result.events.findLast(
    (event) => event.type === "run_finished",
  );
  expect(terminal).toMatchObject({
    status: "completed",
    turns: 4,
    toolCalls: 3,
    usageComplete: true,
    usage: { totalTokens: 156 },
    budget: { consumed: 6, usage: { reportedRequests: 13, complete: true } },
  });
  const reports = result.events.filter(
    (event) => event.type === "harness_adaptation" && event.progress.report,
  );
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    progress: { report: { status: "adopted", modelRequests: 9, toolCalls: 3 } },
  });
  const stored = await f.experiences();
  expect(stored).toHaveLength(1);
  expect(stored[0]?.strategy).toEqual(fixtureStrategy);
  expect(await f.service.getSession(result.id)).toEqual(result);
  expect(await f.service.listSessions()).toHaveLength(1);
});

it("persists opt-in experiences and uses them only to inform proposals on the next run", async () => {
  const f = await setup();
  expect((await f.run()).status).toBe("completed");
  const [learned] = await f.experiences();
  expect(learned).toBeDefined();
  if (!learned) throw new Error("Expected a saved experience.");
  await f.service.dispose();
  const reopened = await f.open();
  f.model.requests.splice(0);
  const session = await reopened.createSession({
    workspace: f.workspace,
    title: "second task",
  });
  const result = await reopened.run(
    {
      sessionId: session.id,
      prompt: "Inspect again.",
      harness: { candidates: 1, maxProbeTurns: 2, experience: "read" },
    },
    f.onEvent,
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  const report = f.model.progresses.findLast(
    (progress) => progress.report,
  )?.report;
  expect(report?.experiencesUsed).toEqual([learned.id]);
  const baseline = f.model.requests.filter(
    (request) => request.phase === "baseline",
  );
  expect(JSON.stringify(baseline)).not.toContain("HARNESS_FIXTURE_STRATEGY");
  const proposal = f.model.requests.find(
    (request) => request.phase === "propose",
  );
  expect(JSON.stringify(proposal)).toContain(learned.id);
  expect(await f.experiences()).toHaveLength(1);
});

it("leaves ordinary runs unchanged with no extra requests or experience directory", async () => {
  const f = await setup();
  const session = await f.service.createSession({
    workspace: f.workspace,
    title: "ordinary task",
  });
  const result = await f.service.run(
    { sessionId: session.id, prompt: "hello" },
    f.onEvent,
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(f.model.requests).toHaveLength(1);
  expect(f.events.some((event) => event.type === "harness_adaptation")).toBe(
    false,
  );
  await expect(
    readdir(join(f.state, "harness-experiences")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["readonly", "plan"] as const)(
  "does not elevate %s or save its experience",
  async (mode) => {
    let turns = 0;
    const f = await setup(async (messages) => {
      if (turns++ === 0)
        return toolResponse("write_file", {
          path: "fixture.txt",
          content: "forbidden",
        });
      expect(JSON.parse(messages.at(-1)?.content ?? "{}")).toMatchObject({
        isError: true,
      });
      return response("mutation denied");
    });
    const result = await f.run(
      undefined,
      mode === "plan"
        ? { mode: "plan", permission: "unrestricted" }
        : { permission: "readonly" },
    );
    expect(result.status).toBe("completed");
    expect(await readFile(join(f.workspace, "fixture.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(await f.experiences()).toHaveLength(0);
  },
);

it("does not save an adopted strategy if formal execution fails", async () => {
  const f = await setup(async () => {
    throw new ForgeError("provider", "fixture failure", false);
  });
  expect((await f.run()).status).toBe("failed");
  expect(await f.experiences()).toHaveLength(0);
  expect(
    f.model.requests.filter((request) => request.phase === "formal"),
  ).toHaveLength(1);
});

it("stops before formal execution on preflight failure, without a retry", async () => {
  const f = await setup();
  const complete = f.model.provider.complete;
  f.model.provider.complete = (...args) =>
    f.model.phase === "propose"
      ? Promise.resolve(response("malformed"))
      : complete(...args);
  expect((await f.run()).status).toBe("failed");
  expect(f.model.requests.some((request) => request.phase === "formal")).toBe(
    false,
  );
  expect(await f.experiences()).toHaveLength(0);
});

it("cancels the owned preflight and never starts the formal task", async () => {
  const f = await setup();
  const controller = new AbortController();
  const session = await f.service.createSession({
    workspace: f.workspace,
    title: "cancelled task",
  });
  const result = await f.service.run(
    {
      sessionId: session.id,
      prompt: "inspect",
      harness: { candidates: 1, experience: "read-write" },
    },
    (event) => {
      f.onEvent(event);
      if (
        event.type === "harness_adaptation" &&
        event.progress.phase === "probe"
      )
        controller.abort();
    },
    async () => false,
    controller.signal,
  );
  expect(result.status).toBe("cancelled");
  expect(f.model.requests.some((request) => request.phase === "formal")).toBe(
    false,
  );
  expect(await f.experiences()).toHaveLength(0);
});

it("invalidates an adopted strategy on steering without replaying the preflight", async () => {
  const f = await setup();
  let pending = true;
  const result = await f.run(
    undefined,
    {},
    {
      drainSteering: () => {
        if (!pending) return [];
        pending = false;
        return [
          "Changed task: just inspect, do not apply the suggested strategy.",
        ];
      },
    },
  );
  expect(result.status).toBe("completed");
  const formal = f.model.requests.filter(
    (request) => request.phase === "formal",
  );
  expect(formal).toHaveLength(1);
  expect(JSON.stringify(formal)).not.toContain("HARNESS_FIXTURE_STRATEGY");
  expect(
    f.model.progresses.filter((progress) => progress.phase === "baseline"),
  ).toHaveLength(1);
  expect(
    f.model.progresses.findLast((progress) => progress.report)?.report,
  ).toMatchObject({ status: "baseline" });
  expect(await f.experiences()).toHaveLength(0);
});

it("keeps the private state root unreadable even when it is inside the probe workspace", async () => {
  const f = await setup();
  const complete = f.model.provider.complete;
  f.model.provider.complete = (messages, ...rest) =>
    ["baseline", "probe", "verify"].includes(f.model.phase) &&
    messages.at(-1)?.role !== "tool"
      ? Promise.resolve(
          toolResponse("read_file", { path: "state/settings.json" }),
        )
      : complete(messages, ...rest);
  const session = await f.service.createSession({
    workspace: f.root,
    title: "protected state",
  });
  const result = await f.service.run(
    {
      sessionId: session.id,
      prompt: "inspect",
      permission: "unrestricted",
      harness: { candidates: 1, maxProbeTurns: 2, experience: "off" },
    },
    f.onEvent,
    async () => true,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  const report = f.model.progresses.findLast(
    (progress) => progress.report,
  )?.report;
  expect(report?.status).toBe("baseline");
  expect(report?.probes.every((probe) => probe.evidence[0]?.isError)).toBe(
    true,
  );
  expect(JSON.stringify(report)).not.toContain("fixture-test-key-only");
});

it("honors a dynamic downgrade after preflight and suppresses experience promotion", async () => {
  let calls = 0;
  const f = await setup(async (messages) => {
    if (calls++ === 0)
      return toolResponse("write_file", {
        path: "fixture.txt",
        content: "forbidden",
      });
    expect(JSON.parse(messages.at(-1)?.content ?? "{}")).toMatchObject({
      isError: true,
    });
    return response("permission downgrade honored");
  });
  const result = await f.run(
    undefined,
    {},
    {
      drainSteering: () => [],
      getPermission: () =>
        f.model.progresses.some((progress) => progress.phase === "completed")
          ? "readonly"
          : "workspace",
    },
  );
  expect(result.status).toBe("completed");
  expect(await f.experiences()).toHaveLength(0);
  expect(await readFile(join(f.workspace, "fixture.txt"), "utf8")).toBe(
    "original\n",
  );
});

it("reports an experience storage failure without replaying completed user work", async () => {
  let calls = 0;
  const f = await setup(async () => {
    calls++;
    await chmod(join(f.state, "harness-experiences"), 0o755);
    return response("formal task completed");
  });
  const result = await f.run();
  expect(result.status).toBe("completed");
  expect(calls).toBe(1);
  expect(
    f.events.some(
      (event) =>
        event.type === "error" &&
        event.error.message.includes(
          "Harness experience could not be recorded",
        ),
    ),
  ).toBe(true);
  expect(
    f.model.progresses.some((progress) => progress.phase === "experience"),
  ).toBe(false);
  expect(await readdir(join(f.state, "harness-experiences"))).toEqual([]);
});
