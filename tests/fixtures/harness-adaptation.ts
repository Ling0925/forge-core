import type { ModelProvider } from "../../src/shared/contracts";
import type {
  HarnessAdaptationProgress,
  HarnessProbe,
  HarnessStrategy,
} from "../../src/shared/harness-adaptation";
import type {
  Message,
  ProviderResponse,
  ToolDefinition,
} from "../../src/shared/schemas";

export const fixtureStrategy: HarnessStrategy = {
  planning:
    "HARNESS_FIXTURE_STRATEGY: inspect the smallest relevant file first.",
  toolGuidance: "Use read_file before the formal edit.",
  verification:
    "Run the focused test in the formal task, not during preflight.",
};
export const fixtureUsage = {
  promptTokens: 10,
  completionTokens: 2,
  totalTokens: 12,
};
export const response = (content: string): ProviderResponse => ({
  message: { role: "assistant", content },
  usage: fixtureUsage,
});
export const toolResponse = (
  name: string,
  args: object = {},
  id = "fixture-call",
): ProviderResponse => ({
  message: {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
  usage: fixtureUsage,
});
export const readDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a fixture",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
};

/** Deterministic fake model. It never makes network calls or accesses credentials. */
export function createAdaptationFixture(
  options: {
    candidates?: number;
    probeTool?: string;
    strategy?: HarnessStrategy;
    formal?: ModelProvider["complete"];
  } = {},
) {
  let phase = "formal";
  const requests: {
    phase: string;
    messages: readonly Message[];
    tools: readonly ToolDefinition[];
    webSearch: string | undefined;
  }[] = [];
  const progresses: HarnessAdaptationProgress[] = [];
  const strategy = options.strategy ?? fixtureStrategy;
  const onProgress = (progress: HarnessAdaptationProgress) => {
    progresses.push(progress);
    phase =
      progress.phase === "completed" || progress.phase === "experience"
        ? "formal"
        : progress.phase;
  };
  const provider: ModelProvider = {
    listModels: async () => ["fixture-model"],
    complete: async (messages, tools, request) => {
      requests.push({
        phase,
        messages: structuredClone(messages),
        tools,
        webSearch: request.webSearch,
      });
      if (phase === "formal")
        return (
          options.formal?.(messages, tools, request) ??
          response("formal task completed")
        );
      if (["baseline", "probe", "verify"].includes(phase)) {
        if (messages.at(-1)?.role !== "tool")
          return toolResponse(options.probeTool ?? "read_file", {
            path: "fixture.txt",
          });
        return response(
          "PREVIEW_ONLY: read observation; work and tests are not executed.",
        );
      }
      const last = messages.at(-1);
      const data = JSON.parse(last?.content ?? "{}").data as {
        probes: HarnessProbe[];
        composed: HarnessProbe;
      };
      if (phase === "propose")
        return response(
          JSON.stringify({
            candidates: Array.from(
              { length: options.candidates ?? 1 },
              () => strategy,
            ),
          }),
        );
      if (phase === "compose")
        return response(
          JSON.stringify({
            strategy,
            rationale: "Combine observed reading guidance.",
            evidenceIds: data.probes
              .flatMap((probe) => probe.evidence.map((item) => item.id))
              .slice(0, 1),
          }),
        );
      if (phase === "select")
        return response(
          JSON.stringify({
            adopt: true,
            rationale: "Observed composed read supports the strategy.",
            evidenceIds: data.composed.evidence
              .filter((item) => !item.isError)
              .slice(0, 1)
              .map((item) => item.id),
          }),
        );
      throw new Error(`Unexpected fixture phase ${phase}`);
    },
  };
  return {
    provider,
    requests,
    progresses,
    onProgress,
    get phase() {
      return phase;
    },
  };
}
