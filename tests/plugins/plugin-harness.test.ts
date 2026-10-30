import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { HarnessService, ModelProvider } from "../../src/shared/contracts";
import type { Message, ToolDefinition } from "../../src/shared/schemas";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function setup(provider: ModelProvider) {
  const root = await mkdtemp(join(tmpdir(), "forge-plugin-harness-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const service = await createHarness({
    stateDir: join(root, "state"),
    providerFactory: () => provider,
  });
  cleanup.push(() => service.dispose());
  await service.updateSettings({
    settings: { model: "fixture-model", baseUrl: "http://fixture.invalid" },
  });
  const session = await service.createSession({
    workspace: root,
    title: "Browser plugin fixture",
  });
  return { root, service, session };
}
it("assembles OfficeCLI tools lazily and removes them after disablement", async () => {
  let definitions: readonly ToolDefinition[] = [];
  let messages: readonly Message[] = [];
  const { service, session } = await setup({
    listModels: async () => ["fixture-model"],
    complete: async (input, tools) => {
      definitions = tools;
      messages = input;
      return { message: { role: "assistant", content: "done" } };
    },
  });
  await service.configurePlugin!({
    pluginId: "officecli",
    enabled: true,
    config: { executablePath: "/nonexistent/officecli-fixture" },
  });
  const result = await service.run(
    { sessionId: session.id, prompt: "Inspect OfficeCLI metadata only" },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(
    definitions
      .filter((tool) => tool.function.name.startsWith("officecli_"))
      .map((tool) => tool.function.name),
  ).toEqual(["officecli_run", "officecli_preview"]);
  expect(JSON.stringify(messages)).toContain("Official OfficeCLI plugin");
  await service.configurePlugin!({ pluginId: "officecli", enabled: false });
  await service.run(
    { sessionId: session.id, prompt: "Inspect disabled plugin" },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(
    definitions.some((tool) => tool.function.name.startsWith("officecli_")),
  ).toBe(false);
});

const configure = (service: HarnessService) =>
  service.configurePlugin!({
    pluginId: "browser",
    enabled: true,
    config: {
      executablePath: "/nonexistent/forge-test-agent-browser",
      allowedDomains: ["example.com"],
    },
  });

it("assembles one plugin browser tool set and its instructions without launching a process", async () => {
  let definitions: readonly ToolDefinition[] = [];
  let messages: readonly Message[] = [];
  const { service, session } = await setup({
    listModels: async () => ["fixture-model"],
    complete: async (input, tools) => {
      definitions = tools;
      messages = input;
      return { message: { role: "assistant", content: "done" } };
    },
  });
  await configure(service);
  const result = await service.run(
    { sessionId: session.id, prompt: "Inspect tool metadata only" },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  const names = definitions.map((definition) => definition.function.name);
  expect(names.filter((name) => name === "browser_navigate")).toHaveLength(1);
  expect(names).toContain("browser_snapshot");
  expect(names).toContain("browser_press");
  expect(names).toContain("read_file");
  expect(JSON.stringify(messages)).toContain("Official browser plugin");
  expect(
    await service.browser!({ sessionId: session.id, action: "status" }),
  ).toMatchObject({ available: false });
  await service.configurePlugin!({ pluginId: "browser", enabled: false });
  await service.run(
    {
      sessionId: session.id,
      prompt: "Inspect metadata with the plugin disabled",
    },
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(
    definitions.some((definition) =>
      definition.function.name.startsWith("browser_"),
    ),
  ).toBe(false);
  expect(
    JSON.stringify(messages.filter((message) => message.role === "system")),
  ).not.toContain("Official browser plugin");
});

it.each(["readonly", "workspace"] as const)(
  "retains runtime %s denial before reaching an unavailable executable",
  async (permission) => {
    let turns = 0;
    let outcome: string | null | undefined;
    const { service, session } = await setup({
      listModels: async () => ["fixture-model"],
      complete: async (messages) => {
        if (turns++ === 0)
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "browser-denied",
                  type: "function",
                  function: {
                    name: "browser_navigate",
                    arguments: JSON.stringify({ url: "https://example.com/" }),
                  },
                },
              ],
            },
          };
        outcome = messages.findLast(
          (message) => message.role === "tool",
        )?.content;
        return {
          message: {
            role: "assistant",
            content: "No browser effects were authorized.",
          },
        };
      },
    });
    await configure(service);
    const result = await service.run(
      { sessionId: session.id, prompt: "Open example.com", permission },
      () => {},
      async () => false,
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(outcome).toContain(
      permission === "readonly"
        ? "Core readonly policy denies"
        : "Browser tool call was denied",
    );
    expect((await service.listPlugins!())[0]).toMatchObject({
      status: "configured",
      activeSessions: 0,
    });
  },
);
