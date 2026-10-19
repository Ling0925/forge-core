import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type {
  LocalToolRegistry,
  ModelProvider,
} from "../../src/shared/contracts";
import type { AgentEvent, ProviderConfig } from "../../src/shared/schemas";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "forge-integration-"));
  cleanups.push(async () => {
    await rm(path, { recursive: true, force: true });
  });
  return path;
};

/** Loopback provider fixture; never touches real credentials. */
const gateway = async (handler: (body: string) => unknown): Promise<string> => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(handler(Buffer.concat(chunks).toString("utf8"))),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture address unavailable");
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${address.port}`;
};

const reply = {
  choices: [
    { message: { role: "assistant", content: "done" }, finish_reason: "stop" },
  ],
};
const fakeKey = "fixture-only-test-key";

const configured = async (
  origins: string[] = [],
  executable = "",
): Promise<{ baseUrl: string; state: string; workspace: string }> => {
  const baseUrl = await gateway(() => reply);
  const [state, workspace] = [await directory(), await directory()];
  const service = await createHarness({ stateDir: state });
  cleanups.push(() => service.dispose());
  await service.updateSettings({
    apiKey: fakeKey,
    settings: {
      baseUrl,
      model: "fixture-model",
      browserAllowedOrigins: origins,
      browserExecutablePath: executable,
    },
  });
  return { baseUrl, state, workspace };
};

const runOnce = async (
  service: Awaited<ReturnType<typeof createHarness>>,
  workspace: string,
): Promise<{ events: AgentEvent[] }> => {
  const session = await service.createSession({ workspace });
  const events: AgentEvent[] = [];
  const result = await service.run(
    { sessionId: session.id, prompt: "inspect" },
    (event) => events.push(event),
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  return { events };
};

describe("default harness tool integration", () => {
  it("exposes local and public web tools by default without a browser installed", async () => {
    const { state, workspace } = await configured();
    let definitions: readonly { function: { name: string } }[] = [];
    const providerFactory = (config: ProviderConfig): ModelProvider => {
      expect(config.apiKey).toBe(fakeKey);
      return {
        listModels: async () => ["fixture-model"],
        complete: async (_messages, tools) => {
          definitions = tools;
          return { message: { role: "assistant", content: "done" } };
        },
      };
    };
    const service = await createHarness({ stateDir: state, providerFactory });
    cleanups.push(() => service.dispose());
    await runOnce(service, workspace);
    const names = definitions.map((definition) => definition.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("run_command");
    expect(names).not.toContain("web_search"); // Hosted Responses tool, never a local function.
    expect(names).toContain("web_fetch");
    expect(names.some((name) => name.startsWith("browser_"))).toBe(false);
    expect(JSON.stringify(definitions)).not.toContain(fakeKey);
  });

  it.each(["readonly", "workspace"] as const)(
    "routes web calls through default tools and honors %s denial",
    async (permission) => {
      const { state, workspace } = await configured();
      let turns = 0;
      const providerFactory = (): ModelProvider => ({
        listModels: async () => ["fixture-model"],
        complete: async (messages, tools) => {
          expect(tools.some((tool) => tool.function.name === "web_fetch")).toBe(true);
          if (turns++ === 0) return { message: {
            role: "assistant", content: null, tool_calls: [{
              id: "web-denied", type: "function", function: {
                name: "web_fetch", arguments: JSON.stringify({ url: "https://example.com/docs" }),
              },
            }],
          } };
          const outcome = messages.findLast((message) => message.role === "tool");
          expect(outcome?.content).toContain(permission === "readonly"
            ? "Core readonly policy denies" : "Web request was denied");
          return { message: { role: "assistant", content: "Access denied; no source read." } };
        },
      });
      const service = await createHarness({ stateDir: state, providerFactory });
      cleanups.push(() => service.dispose());
      await service.updateSettings({ settings: { defaultPermission: permission } });
      const { events } = await runOnce(service, workspace);
      const approvals = events.filter((event) => event.type === "approval_requested");
      expect(approvals).toHaveLength(permission === "readonly" ? 0 : 1);
      if (permission !== "readonly")
        expect(JSON.stringify(approvals)).toContain("https://example.com/docs");
      expect(turns).toBe(2);
    },
  );

  it("exposes browser tools only when exact allowed origins are configured", async () => {
    const { state, workspace } = await configured(["http://127.0.0.1:4173"]);
    let definitions: readonly { function: { name: string } }[] = [];
    const providerFactory = (): ModelProvider => ({
      listModels: async () => ["fixture-model"],
      complete: async (_messages, tools) => {
        definitions = tools;
        return { message: { role: "assistant", content: "done" } };
      },
    });
    const service = await createHarness({ stateDir: state, providerFactory });
    cleanups.push(() => service.dispose());
    await runOnce(service, workspace);
    const names = definitions.map((definition) => definition.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_read");
    // Registration alone must not launch Chromium; definitions are static.
    expect(JSON.stringify(definitions)).not.toContain(fakeKey);
  });

  it("keeps an injected tool factory exact and disposes it after the run", async () => {
    const { state, workspace } = await configured(["http://127.0.0.1:4173"]);
    let created = 0;
    let disposed = 0;
    const providerFactory = (): ModelProvider => ({
      listModels: async () => ["fixture-model"],
      complete: async (_messages, tools) => {
        expect(tools.filter((t) => t.function.name === "custom")).toEqual([
          {
            type: "function",
            function: { name: "custom", description: "d", parameters: {} },
          },
        ]);
        return { message: { role: "assistant", content: "done" } };
      },
    });
    const toolFactory = async (): Promise<LocalToolRegistry> => {
      created += 1;
      return {
        definitions: [
          {
            type: "function",
            function: { name: "custom", description: "d", parameters: {} },
          },
        ],
        execute: async () => ({ content: "ok", isError: false }),
        dispose: async () => {
          disposed += 1;
        },
      };
    };
    const service = await createHarness({
      stateDir: state,
      providerFactory,
      toolFactory,
    });
    cleanups.push(() => service.dispose());
    await runOnce(service, workspace);
    expect(created).toBe(1);
    expect(disposed).toBe(1);
  });

  it("rejects invalid browser origins and keeps legacy config valid", async () => {
    const state = await directory();
    const service = await createHarness({ stateDir: state });
    cleanups.push(() => service.dispose());
    const defaults = await service.getSettings();
    expect(defaults.browserAllowedOrigins).toEqual([]);
    expect(defaults.browserExecutablePath).toBe("");
    for (const browserAllowedOrigins of [
      ["*"],
      ["https://*"],
      ["https://*.example.invalid"],
      ["https://user:pass@example.invalid"],
      ["https://example.invalid/path"],
      ["https://example.invalid?x=1"],
      ["https://example.invalid#x"],
      ["ftp://example.invalid"],
      ["example.invalid"],
      [""],
    ]) {
      await expect(
        service.updateSettings({ settings: { browserAllowedOrigins } }),
      ).rejects.toThrow();
    }
    await expect(
      service.updateSettings({
        settings: {
          browserAllowedOrigins: Array.from(
            { length: 33 },
            (_, index) => `https://o${index}.invalid`,
          ),
        },
      }),
    ).rejects.toThrow();
    const updated = await service.updateSettings({
      settings: {
        browserAllowedOrigins: [
          "https://example.invalid",
          "http://127.0.0.1:8080",
        ],
        browserExecutablePath: "/usr/bin/chromium",
      },
    });
    expect(updated.browserAllowedOrigins).toEqual([
      "https://example.invalid",
      "http://127.0.0.1:8080",
    ]);
    expect(updated.browserExecutablePath).toBe("/usr/bin/chromium");
    const cleared = await service.updateSettings({
      settings: { browserAllowedOrigins: [], browserExecutablePath: "" },
    });
    expect(cleared.browserAllowedOrigins).toEqual([]);
    expect(cleared.browserExecutablePath).toBe("");
    expect(updated.hasApiKey).toBe(false);
  });

  it("still cancels and releases the session lock with default tools", async () => {
    const { state, workspace } = await configured();
    let entered = (): void => undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const providerFactory = (): ModelProvider => {
      return {
        listModels: async () => ["fixture-model"],
        complete: async () => {
          calls += 1;
          if (calls > 1)
            return { message: { role: "assistant", content: "done" } };
          entered();
          await new Promise(() => undefined);
          return { message: { role: "assistant", content: "never" } };
        },
      };
    };
    const service = await createHarness({ stateDir: state, providerFactory });
    cleanups.push(() => service.dispose());
    const session = await service.createSession({ workspace });
    const controller = new AbortController();
    const running = service.run(
      { sessionId: session.id, prompt: "work" },
      () => undefined,
      async () => false,
      controller.signal,
    );
    await enteredPromise;
    controller.abort();
    const result = await running;
    expect(result.status).toBe("cancelled");
    // The run's default tool registry is disposed and the lock is released.
    const second = await service.run(
      { sessionId: session.id, prompt: "again" },
      () => undefined,
      async () => false,
      new AbortController().signal,
    );
    expect(second.status).toBe("completed");
  });

  it("rejects concurrent runs and settles dispose during active work", async () => {
    const { state, workspace } = await configured();
    let entered = (): void => undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const providerFactory = (): ModelProvider => ({
      listModels: async () => ["fixture-model"],
      complete: async () => {
        entered();
        await new Promise(() => undefined);
        return { message: { role: "assistant", content: "never" } };
      },
    });
    const service = await createHarness({ stateDir: state, providerFactory });
    const session = await service.createSession({ workspace });
    const running = service.run(
      { sessionId: session.id, prompt: "work" },
      () => undefined,
      async () => false,
      new AbortController().signal,
    );
    await enteredPromise;
    await expect(
      service.run(
        { sessionId: session.id, prompt: "again" },
        () => undefined,
        async () => false,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    await service.dispose();
    const result = await running;
    expect(result.status).toBe("cancelled");
  });

  it("fails safely when the browser registry cannot be created and keeps the local registry closed", async () => {
    // An executable path that cannot exist fails browser construction/launch;
    // the run must fail without leaving the local registry active.
    const { state, workspace } = await configured(
      ["http://127.0.0.1:4173"],
      join(tmpdir(), "forge-no-such-browser-executable"),
    );
    let completions = 0;
    const providerFactory = (): ModelProvider => ({
      listModels: async () => ["fixture-model"],
      complete: async (messages, tools) => {
        if (messages[0]?.content?.startsWith("Generate only"))
          return { message: { role: "assistant", content: "Browser task" } };
        completions += 1;
        expect(
          tools.some(
            (definition) => definition.function.name === "browser_navigate",
          ),
        ).toBe(true);
        if (completions > 1) {
          // A real model would stop after the failed browser call; the fixture
          // models that decision instead of re-issuing the same failing call.
          return { message: { role: "assistant", content: "abandoned" } };
        }
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "b1",
                type: "function",
                function: {
                  name: "browser_navigate",
                  arguments: '{"url":"http://127.0.0.1:4173/"}',
                },
              },
            ],
          },
        };
      },
    });
    const service = await createHarness({ stateDir: state, providerFactory });
    cleanups.push(() => service.dispose());
    const session = await service.createSession({ workspace });
    const events: AgentEvent[] = [];
    const result = await service.run(
      { sessionId: session.id, prompt: "browse" },
      (event) => events.push(event),
      async () => true,
      new AbortController().signal,
    );
    // Browser launch fails inside the tool call; the runtime must surface the
    // browser failure outcome rather than hanging or reporting an unrelated
    // generic failure, and the registries are disposed on run end.
    expect(result.status).toBe("completed");
    expect(events.some((event) => event.type === "error")).toBe(false);
    const started = events.filter((event) => event.type === "tool_started");
    expect(started.map((event) => event.call.function.name)).toEqual([
      "browser_navigate",
    ]);
    const finished = events.filter((event) => event.type === "tool_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.result.isError).toBe(true);
    // The tool-level error is the intended browser lifecycle failure.
    expect(finished[0]?.result.content).toContain(
      "Browser operation denied or failed.",
    );
    // Exactly one tool call ran: the failed navigation, with no retries or
    // later browser side effects recorded.
    const toolMessages = result.messages.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    expect(JSON.parse(toolMessages[0]?.content ?? "{}")).toMatchObject({
      isError: true,
    });
    const terminal = events.find((event) => event.type === "run_finished");
    expect(
      terminal && terminal.type === "run_finished" ? terminal.toolCalls : -1,
    ).toBe(1);
    // The failed run disposed its registry and released the session lock, so a
    // fresh run can proceed and reach the provider again.
    let reached = 0;
    const secondFactory = (): ModelProvider => ({
      listModels: async () => ["fixture-model"],
      complete: async () => {
        reached += 1;
        return { message: { role: "assistant", content: "done" } };
      },
    });
    const secondService = await createHarness({
      stateDir: state,
      providerFactory: secondFactory,
    });
    cleanups.push(() => secondService.dispose());
    const second = await secondService.run(
      { sessionId: session.id, prompt: "again" },
      () => undefined,
      async () => false,
      new AbortController().signal,
    );
    expect(second.status).toBe("completed");
    expect(reached).toBe(1);
  });
});

it("persists automatic title provenance and protects explicit titles across reopen", async () => {
  const {state, workspace} = await configured();
  const providerFactory = (): ModelProvider => ({listModels: async () => [], complete: async messages => ({message: {role: "assistant", content: messages[0]?.content?.startsWith("Generate only") ? "登录修复" : "done"}})});
  const service = await createHarness({stateDir: state, providerFactory});
  cleanups.push(() => service.dispose());
  const created = await service.createSession({workspace});
  expect(created.titleSource).toBe("default");
  const result = await service.run({sessionId: created.id, prompt: "修复登录问题"}, () => {}, async () => false, new AbortController().signal);
  expect(result.status).toBe("completed");
  for (let i = 0; i < 100 && (await service.getSession(created.id)).title !== "登录修复"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect((await service.getSession(created.id)).title).toBe("登录修复");
  const renamed = await service.renameSession(created.id, "  手动标题  ");
  expect(renamed).toMatchObject({title: "手动标题", titleSource: "user"});
  await service.dispose();
  const reopened = await createHarness({stateDir: state, providerFactory});
  cleanups.push(() => reopened.dispose());
  expect((await reopened.getSession(created.id)).autoTitleAttempted).toBe(true);
  await reopened.run({sessionId: created.id, prompt: "继续"}, () => {}, async () => false, new AbortController().signal);
  expect((await reopened.getSession(created.id)).title).toBe("手动标题");
});
