import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeDefinitions } from "../../src/core/agents";
import { projectSummary } from "../../src/core/context";
import { buildSystemInstructions } from "../../src/core/prompts";
import { COLD_RESUME_TOKENS, openRunMemory } from "../../src/core/run-memory";
import {
  CONTEXT_SCALE_FLOOR,
  createAgentRuntime,
} from "../../src/core/runtime";
import { measureContext } from "../../src/shared/context-usage";
import type { ModelProvider, SessionStore } from "../../src/shared/contracts";
import {
  type AgentEvent,
  type Message,
  type RunInput,
  type SessionSnapshot,
  type ToolDefinition,
  defaultPublicSettings,
  sessionIdSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";

let root: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-cold-context-"));
  workspace = join(root, "workspace");
  const home = join(root, "home");
  await Promise.all([mkdir(workspace), mkdir(home)]);
  vi.stubEnv("FORGE_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const id = sessionIdSchema.parse("11111111-1111-4111-8111-111111111111");
const endedAt = "2026-01-01T00:00:00.000Z";
const extra = "x".repeat(32000);
const tool: ToolDefinition = {
  type: "function",
  function: {
    name: "inspect",
    description: extra,
    parameters: { type: "object" },
  },
};
const images = Array.from({ length: 4 }, (_, i) => ({
  name: `${i}.png`,
  dataUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=",
}));
type Options = {
  baselineTokens?: number;
  recentTokens?: number;
  projectInstructions?: string;
  definitions?: readonly ToolDefinition[];
  prompt?: string;
  images?: RunInput["images"];
  pending?: string;
  ratio?: number;
  model?: string;
  at?: string;
  savedSystem?: string;
};

async function resume(options: Options = {}) {
  const metadata = { sessionId: id, timestamp: endedAt, turn: 1 };
  const events: AgentEvent[] = [
    {
      ...metadata,
      type: "run_started",
      model: "fixture",
      permission: "readonly",
    },
  ];
  if (options.ratio !== undefined) {
    const projected = {
      windowTokens: 300000,
      usedTokens: 10000,
      estimated: true,
      basis: "projected" as const,
      parts: { instructions: 1000, memory: 0, conversation: 8000, tools: 1000 },
    };
    const promptTokens = projected.usedTokens * options.ratio;
    events.push(
      { ...metadata, type: "context_usage", usage: projected },
      {
        ...metadata,
        type: "context_usage",
        usage: {
          ...projected,
          basis: "request-with-output",
          usedTokens: promptTokens + 90000,
          promptTokens,
          completionTokens: 90000,
          cachedPromptTokens: promptTokens,
        },
      },
    );
  }
  events.push({
    ...metadata,
    type: "run_finished",
    status: "completed",
    turns: 1,
    toolCalls: 0,
  });
  let original = sessionSnapshotSchema.parse({
    version: 1,
    id,
    workspace,
    title: "Existing session",
    model: "fixture",
    status: "completed",
    createdAt: endedAt,
    updatedAt: endedAt,
    changes: [],
    events,
    messages: [
      { role: "system", content: options.savedSystem ?? "obsolete rules" },
      { role: "user", content: "preserve user files" },
      { role: "assistant", content: "OMITTED_HISTORY: " },
      ...(options.recentTokens
        ? [
            { role: "user", content: "recent request" },
            {
              role: "assistant",
              content: "r".repeat(options.recentTokens * 4),
            },
          ]
        : []),
      { role: "user", content: "LATEST_OLD_REQUEST" },
      { role: "assistant", content: "latest report" },
    ],
  });
  const instructions = (
    definitions: readonly ToolDefinition[],
    projectInstructions?: string,
  ) =>
    buildSystemInstructions({
      session: original,
      permission: "readonly",
      mode: "build",
      projectInstructions,
      toolNames: definitions.map((definition) => definition.function.name),
    });
  const baseline = measureContext(
    [
      { role: "system", content: instructions(nativeDefinitions) },
      ...original.messages.slice(1),
      { role: "user", content: "continue" },
    ],
    null,
    nativeDefinitions,
  ).usedTokens;
  const padding = ((options.baselineTokens ?? 20000) - baseline) * 4;
  expect(padding).toBeGreaterThan(0);
  original = {
    ...original,
    messages: original.messages.map((message, index) =>
      index === 2
        ? {
            role: "assistant",
            content: `${message.content}${"h".repeat(padding)}`,
          }
        : message,
    ),
    ...(options.pending
      ? { pendingSteering: [{ role: "user", content: options.pending }] }
      : {}),
  };
  const input: RunInput = {
    sessionId: id,
    prompt: options.prompt ?? "continue",
    permission: "readonly",
    ...(options.model ? { model: options.model } : {}),
    ...(options.images ? { images: options.images } : {}),
  };
  const prompt: Message = {
    role: "user",
    content: input.prompt,
    ...(input.images ? { images: input.images } : {}),
  };
  const definitions = [...(options.definitions ?? []), ...nativeDefinitions];
  const system = {
    role: "system" as const,
    content: instructions(definitions, options.projectInstructions),
  };
  const before = [
    system,
    ...original.messages.slice(1),
    ...(original.pendingSteering ?? []),
    prompt,
  ];
  const rawBefore = measureContext(before, null, definitions).usedTokens;
  let stored: SessionSnapshot = original;
  const store: SessionStore = {
    get: async () => stored,
    list: async () => [],
    create: async () => stored,
    save: async (value) => {
      stored = sessionSnapshotSchema.parse(value);
    },
    acquire: async () => async () => {},
  };
  const memory = await openRunMemory(process.env.FORGE_HOME!);
  await memory.record(original);
  const complete = vi.fn<ModelProvider["complete"]>(async () => ({
    message: { role: "assistant", content: "done" },
  }));
  const runtime = createAgentRuntime({
    store,
    runMemory: memory,
    provider: { complete, listModels: async () => [] },
    settings: defaultPublicSettings,
    tools: {
      definitions: options.definitions ?? [],
      execute: async () => {
        throw Error("Unexpected tool call");
      },
      dispose: async () => {},
    },
    ...(options.projectInstructions !== undefined
      ? { projectInstructions: options.projectInstructions }
      : {}),
    now: () => options.at ?? "2026-01-01T01:00:00.000Z",
  });
  const result = await runtime.run(
    input,
    () => {},
    async () => false,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(complete).toHaveBeenCalledTimes(1); // No extra model call to summarize.
  const [sent, sentDefinitions] = complete.mock.calls[0]!;
  expect(sent[0]).toEqual(system);
  expect(sentDefinitions).toEqual(definitions);
  expect(sent.at(-1)).toEqual(prompt);
  expect(result.messages.slice(0, original.messages.length)).toEqual(
    original.messages,
  );
  return { original, result, sent, definitions, rawBefore, before };
}

it.each<[string, Options]>([
  ["current project/system instructions", { projectInstructions: extra }],
  ["tool definitions", { definitions: [tool] }],
  ["new user input", { prompt: `NEW_REQUEST ${extra}` }],
  ["recovered steering", { pending: `PENDING_REQUEST ${extra}` }],
  ["new images", { images }],
  ["provider input calibration", { ratio: 2 }],
  ["the existing calibration floor", { baselineTokens: 27000 }],
])("includes %s when deciding a cold resume", async (_name, options) => {
  const { original, result, sent, rawBefore } = await resume(options);
  expect(
    measureContext(projectSummary(original), null).usedTokens,
  ).toBeLessThan(COLD_RESUME_TOKENS);
  expect(rawBefore * (options.ratio ?? CONTEXT_SCALE_FLOOR)).toBeGreaterThan(
    COLD_RESUME_TOKENS,
  );
  expect(Boolean(result.contextSummary)).toBe(true);
  expect(result.contextSummary?.boundary).toBe(original.messages.length);
  expect(JSON.stringify(sent).includes("OMITTED_HISTORY")).toBe(false);
  expect(result.contextSummary?.content).toContain("LATEST_OLD_REQUEST");
  // New and recovered inputs count toward size but must never enter the old checkpoint.
  expect(result.contextSummary?.content).not.toContain("NEW_REQUEST");
  expect(result.contextSummary?.content).not.toContain("PENDING_REQUEST");
  expect(sent.filter((message) => message.role === "user")).toHaveLength(
    options.pending ? 2 : 1,
  );
  if (options.pending) expect(sent.at(-2)?.content).toBe(options.pending);
});

it.each([false, true])(
  "uses the complete request for the recent-turn retention target (large tools: %s)",
  async (largeTools) => {
    const { original, result, sent, definitions } = await resume({
      baselineTokens: 40000,
      recentTokens: 2000,
      definitions: largeTools ? [tool] : [],
    });
    expect(result.contextSummary?.boundary).toBe(
      largeTools ? original.messages.length : 3,
    );
    expect(sent.filter((message) => message.role === "user")).toHaveLength(
      largeTools ? 1 : 3,
    );
    if (!largeTools)
      expect(
        measureContext(sent, null, definitions).usedTokens *
          CONTEXT_SCALE_FLOOR,
      ).toBeLessThanOrEqual(12000);
  },
);

it.each([25600, 25601])(
  "uses the strict 32K calibrated threshold for %i raw request tokens",
  async (baselineTokens) => {
    const { result, rawBefore } = await resume({ baselineTokens });
    expect(rawBefore).toBe(baselineTokens);
    expect(Boolean(result.contextSummary)).toBe(
      baselineTokens * CONTEXT_SCALE_FLOOR > COLD_RESUME_TOKENS,
    );
  },
);

it("leaves warm context untouched even when the complete request exceeds the threshold", async () => {
  const { result, sent, before } = await resume({
    definitions: [tool],
    at: "2026-01-01T00:59:59.999Z",
  });
  expect(result.contextSummary).toBeUndefined();
  expect(sent).toEqual(before);
});

it("does not use the old model's calibration after an explicit model change", async () => {
  const { result, rawBefore } = await resume({
    ratio: 2,
    model: "other-model",
  });
  expect(rawBefore * 2).toBeGreaterThan(COLD_RESUME_TOKENS);
  expect(rawBefore * CONTEXT_SCALE_FLOOR).toBeLessThan(COLD_RESUME_TOKENS);
  expect(result.contextSummary).toBeUndefined();
});

it("uses input calibration, not cumulative/output tokens or a cache discount", async () => {
  const { result, rawBefore } = await resume({ ratio: 1 });
  expect(rawBefore * CONTEXT_SCALE_FLOOR).toBeLessThan(COLD_RESUME_TOKENS);
  expect(result.contextSummary).toBeUndefined();
});

it("measures the current system message instead of an oversized obsolete one", async () => {
  const { original, result, rawBefore } = await resume({
    savedSystem: "old instructions ".repeat(10000),
  });
  expect(
    measureContext(projectSummary(original), null).usedTokens,
  ).toBeGreaterThan(COLD_RESUME_TOKENS);
  expect(rawBefore * CONTEXT_SCALE_FLOOR).toBeLessThan(COLD_RESUME_TOKENS);
  expect(result.contextSummary).toBeUndefined();
});
