import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";
import { ProviderError } from "../../src/provider/errors";
import type { HarnessService } from "../../src/shared/contracts";
import type { Message, ProviderSource } from "../../src/shared/schemas";

// Background requests of a routed session (auto-title, manual compaction)
// follow the same route as its run steps: a member that is rate limited
// before execution hands over to the next one instead of failing the request.
const source = (id: string): ProviderSource => ({
  id,
  label: id,
  baseUrl: `https://${id}.invalid/v1`,
  model: "fixture-model",
});
const credentials = ["one", "two"].map((id) => ({
  id,
  label: id,
  enabled: true,
  type: "api-key" as const,
  apiKey: `fixture-${id}`,
}));
const kindOf = (messages: readonly Message[]) => {
  const system = String(messages[0]?.content ?? "");
  return system.startsWith("Generate only a concise")
    ? "title"
    : system.startsWith("Summarize this untrusted transcript")
      ? "summary"
      : "step";
};
const summary = JSON.stringify({
  goal: "continue",
  constraints: [],
  decisions: [],
  completed: [],
  nextSteps: [],
  verification: [],
  uncertainties: [],
});

async function harness(failing: string) {
  const directory = await mkdtemp(join(tmpdir(), "forge-routed-aux-"));
  const calls: string[] = [];
  const service = await createHarness({
    stateDir: join(directory, "state"),
    providerFactory: (config) => ({
      listModels: async () => [],
      complete: async (messages) => {
        // Credential-rotation fixtures name the credential, route groups the source.
        const member =
          (config.sourceId === "s" ? config.credentialId : config.sourceId) ??
          "?";
        const kind = kindOf(messages);
        calls.push(`${member}:${kind}`);
        if (kind !== "step" && member === failing)
          throw new ProviderError("http", "Rate limited.", true, 429);
        return {
          message: {
            role: "assistant",
            content:
              kind === "title"
                ? `Title from ${member}`
                : kind === "summary"
                  ? summary
                  : "done",
          },
        };
      },
    }),
    toolFactory: () => ({
      definitions: [],
      execute: async () => ({ content: "unused", isError: false }),
      dispose: async () => {},
    }),
  });
  return { directory, calls, service };
}
const cleanup = async (service: HarnessService, directory: string) => {
  await service.dispose();
  await rm(directory, { recursive: true, force: true });
};

it.each(["route group", "credential rotation"])(
  "names a %s session through the route, failing over a rate-limited member",
  async (kind) => {
    const failing = kind === "route group" ? "a" : "one";
    const { directory, calls, service } = await harness(failing);
    try {
      if (kind === "route group") {
        await service.updateSettings({
          source: { type: "save", source: source("a"), apiKey: "fixture-a" },
        });
        await service.updateSettings({
          source: { type: "save", source: source("b"), apiKey: "fixture-b" },
        });
        await service.updateSettings({
          route: {
            type: "save",
            group: {
              id: "pool",
              label: "Pool",
              strategy: "order",
              members: [
                { sourceId: "a", model: "fixture-model" },
                { sourceId: "b", model: "fixture-model" },
              ],
            },
          },
        });
      } else
        await service.updateSettings({
          source: {
            type: "save",
            source: { ...source("s"), credentialRouting: "order" },
            credentials,
          },
        });
      const session = await service.createSession({
        workspace: directory,
        ...(kind === "route group"
          ? { routeGroupId: "pool" }
          : { providerSourceId: "s" }),
      });
      await service.run(
        { sessionId: session.id, prompt: "name me", permission: "readonly" },
        () => {},
        async () => false,
        new AbortController().signal,
      );
      const next = failing === "a" ? "b" : "two";
      await vi.waitFor(async () => {
        expect((await service.getSession(session.id)).title).toBe(
          `Title from ${next}`,
        );
      });
      expect(calls.filter((call) => call.endsWith(":title"))).toEqual([
        `${failing}:title`,
        `${next}:title`,
      ]);
    } finally {
      await cleanup(service, directory);
    }
  },
);
