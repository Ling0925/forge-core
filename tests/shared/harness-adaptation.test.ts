import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  BASELINE_HARNESS_STRATEGY,
  HARNESS_ADAPTATION_DEFAULTS,
  harnessAdaptationOptionsSchema,
  harnessAdaptationProgressSchema,
  harnessAdaptationReportSchema,
  harnessExperienceInputSchema,
  harnessExperienceScopeSchema,
  harnessProbeSchema,
  harnessStrategySchema,
} from "../../src/shared/harness-adaptation";
import {
  enqueueInputSchema,
  queuedInputSchema,
} from "../../src/shared/input-queue";
import { rpcRequestSchema } from "../../src/shared/ipc";
import { agentEventSchema, runInputSchema } from "../../src/shared/schemas";

const sessionId = "12345678-1234-4234-8234-123456789abc";
const reportId = randomUUID();
const strategy = {
  planning: "Plan a small change.",
  toolGuidance: "Read the file before editing.",
  verification: "Run the focused test.",
} as const;
const probe = {
  id: "baseline",
  strategy: BASELINE_HARNESS_STRATEGY,
  status: "completed" as const,
  answer: "The fixture contains one line.",
  answerTruncated: false,
  evidence: [
    {
      id: "evidence-1",
      tool: "read_file",
      arguments: '{"path":"notes.txt"}',
      observation: "fixture line",
      isError: false,
      truncated: false,
    },
  ],
  turns: 2,
  toolCalls: 1,
};
const report = {
  id: reportId,
  status: "adopted" as const,
  strategy,
  rationale: "Reading first then editing verified the workflow.",
  evidenceIds: ["evidence-1"],
  probes: [probe],
  experiencesUsed: [],
  modelRequests: 9,
  toolCalls: 3,
};

it("parses explicit opt-in with defaults only applied by the engine", () => {
  expect(harnessAdaptationOptionsSchema.parse({})).toEqual({});
  const full = {
    candidates: 3,
    maxProbeTurns: 6,
    maxProbeToolCalls: 16,
    timeoutMs: 120000,
    domain: "  typescript  ",
    experience: "read-write" as const,
  };
  expect(harnessAdaptationOptionsSchema.parse(full)).toEqual({
    ...full,
    domain: "typescript",
  });
  expect(HARNESS_ADAPTATION_DEFAULTS).toEqual({
    candidates: 2,
    maxProbeTurns: 3,
    maxProbeToolCalls: 6,
    timeoutMs: 60000,
    domain: "general",
    experience: "read",
  });
  expect(Object.isFrozen(HARNESS_ADAPTATION_DEFAULTS)).toBe(true);
  expect(BASELINE_HARNESS_STRATEGY).toEqual({
    planning: "",
    toolGuidance: "",
    verification: "",
  });
  expect(Object.isFrozen(BASELINE_HARNESS_STRATEGY)).toBe(true);
});

it("rejects unknown options and every value outside the bounded ranges", () => {
  const invalid = [
    { candidates: 0 },
    { candidates: 4 },
    { candidates: 1.5 },
    { maxProbeTurns: 0 },
    { maxProbeTurns: 7 },
    { maxProbeToolCalls: 0 },
    { maxProbeToolCalls: 17 },
    { timeoutMs: 999 },
    { timeoutMs: 120001 },
    { timeoutMs: 1500.5 },
    { domain: "" },
    { domain: "   " },
    { domain: "界".repeat(81) },
    { experience: "write" },
    { candidates: "2" },
    { unknown: true },
  ];
  for (const value of invalid)
    expect(harnessAdaptationOptionsSchema.safeParse(value).success).toBe(false);
  expect(
    harnessAdaptationOptionsSchema.safeParse({ domain: "界".repeat(80) })
      .success,
  ).toBe(true);
  expect(
    harnessAdaptationOptionsSchema.safeParse({ experience: "off" }).success,
  ).toBe(true);
  expect(
    harnessAdaptationOptionsSchema.safeParse({ experience: "read" }).success,
  ).toBe(true);
});

it("keeps harness opt-in through run input, IPC startRun and the durable queue", () => {
  const harness = {
    candidates: 1,
    maxProbeTurns: 2,
    maxProbeToolCalls: 2,
    timeoutMs: 5000,
    domain: "fixtures",
    experience: "read-write" as const,
  };
  const input = { sessionId, prompt: "adapt then work", harness };
  expect(runInputSchema.parse(input).harness).toEqual(harness);
  expect(runInputSchema.parse({ sessionId, prompt: "plain" }).harness)
    .toBeUndefined();

  const request = rpcRequestSchema.parse({
    id: randomUUID(),
    method: "startRun",
    input,
  });
  expect(request).toMatchObject({ method: "startRun", input: { harness } });

  const enqueued = enqueueInputSchema.parse({
    inputId: randomUUID(),
    input,
  });
  expect(enqueued.input.harness).toEqual(harness);
  const queued = queuedInputSchema.parse({
    inputId: randomUUID(),
    sessionId,
    sequence: 1,
    state: "queued",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runId: null,
    input,
    selection: { model: "fixture-model", mode: "build", permission: "workspace" },
  });
  expect(queued.input?.harness).toEqual(harness);

  // The nested options stay strict at every ingress, not only at RunInput.
  expect(
    runInputSchema.safeParse({
      sessionId,
      prompt: "adapt",
      harness: { candidates: 1, surprise: true },
    }).success,
  ).toBe(false);
  expect(
    rpcRequestSchema.safeParse({
      id: randomUUID(),
      method: "startRun",
      input: { sessionId, prompt: "adapt", harness: { surprise: true } },
    }).success,
  ).toBe(false);
  expect(
    enqueueInputSchema.safeParse({
      inputId: randomUUID(),
      input: { sessionId, prompt: "adapt", harness: { surprise: true } },
    }).success,
  ).toBe(false);
});

it("enforces strict strategy and probe shapes with their upper bounds", () => {
  expect(harnessStrategySchema.parse(strategy)).toEqual(strategy);
  // Baseline deliberately uses empty advisory text; the fields are bounded,
  // not required to be nonempty.
  expect(
    harnessStrategySchema.parse({ planning: "", toolGuidance: "", verification: "" }),
  ).toEqual(BASELINE_HARNESS_STRATEGY);
  for (const value of [
    { ...strategy, unknown: "x" },
    { ...strategy, planning: "界".repeat(2049) },
    { ...strategy, toolGuidance: "界".repeat(2049) },
    { ...strategy, verification: "界".repeat(2049) },
    { planning: strategy.planning },
  ])
    expect(harnessStrategySchema.safeParse(value).success).toBe(false);

  expect(harnessProbeSchema.parse(probe)).toEqual(probe);
  for (const value of [
    { ...probe, unknown: true },
    { ...probe, turns: 7 },
    { ...probe, toolCalls: 17 },
    { ...probe, status: "running" },
    { ...probe, answer: "界".repeat(4097) },
    { ...probe, evidence: Array(17).fill(probe.evidence[0]) },
    {
      ...probe,
      evidence: [{ ...probe.evidence[0], unknown: true }],
    },
  ])
    expect(harnessProbeSchema.safeParse(value).success).toBe(false);
});

it("parses a completed report event as the browser-facing public contract", () => {
  expect(harnessAdaptationReportSchema.parse(report)).toEqual(report);
  const completed = agentEventSchema.parse({
    type: "harness_adaptation",
    sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    progress: { phase: "completed", report },
  });
  expect(completed).toMatchObject({
    type: "harness_adaptation",
    progress: { phase: "completed", report: { id: reportId } },
  });
  // The same event survives a transport JSON round trip and is not provider-
  // or Node-specific at the shared boundary.
  expect(
    agentEventSchema.parse(JSON.parse(JSON.stringify(completed))),
  ).toEqual(completed);
  expect(
    harnessAdaptationProgressSchema.parse({
      phase: "completed",
      report,
    }).report?.experiencesUsed,
  ).toEqual([]);
});

it("rejects unreported or inconsistent adaptation progress", () => {
  for (const phase of [
    "baseline",
    "propose",
    "probe",
    "compose",
    "verify",
    "select",
    "completed",
    "experience",
  ] as const)
    expect(harnessAdaptationProgressSchema.parse({ phase }).phase).toBe(phase);
  expect(
    harnessAdaptationProgressSchema.parse({ phase: "probe", probeId: "composed" })
      .probeId,
  ).toBe("composed");
  expect(
    harnessAdaptationProgressSchema.parse({
      phase: "experience",
      experienceId: randomUUID(),
    }).experienceId,
  ).toBeTruthy();
  // Optional fields are shape-validated, not coupled to a specific phase.
  expect(
    harnessAdaptationProgressSchema.parse({ phase: "probe", report }).report?.id,
  ).toBe(reportId);
  for (const value of [
    { phase: "unknown" },
    { phase: "completed", report: { ...report, unknown: true } },
    { phase: "experience", experienceId: "not-a-uuid" },
    { phase: "baseline", unknown: true },
  ])
    expect(harnessAdaptationProgressSchema.safeParse(value).success).toBe(false);

  for (const value of [
    { ...report, unknown: true },
    { ...report, status: "rejected" },
    { ...report, rationale: "" },
    { ...report, evidenceIds: Array(17).fill("evidence") },
    { ...report, probes: [] },
    { ...report, probes: Array(6).fill(probe) },
    { ...report, modelRequests: 34 },
    { ...report, toolCalls: 81 },
    { ...report, experiencesUsed: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()] },
    { ...report, experiencesUsed: ["not-a-uuid"] },
    { ...report, strategy: { ...strategy, unknown: true } },
  ])
    expect(harnessAdaptationReportSchema.safeParse(value).success).toBe(false);
});

it("keeps experience inputs strict and scope-bound", () => {
  const scope = {
    workspace: "/tmp/workspace",
    model: "fixture-model",
    domain: "general",
  };
  expect(harnessExperienceScopeSchema.parse(scope)).toEqual(scope);
  expect(
    harnessExperienceInputSchema.parse({
      scope,
      sessionId,
      reportId,
      strategy,
      lesson: "Read before writing.",
      evidence: ["read_file: fixture"],
    }),
  ).toMatchObject({ scope, reportId });
  for (const value of [
    { scope: { ...scope, unknown: true }, sessionId, reportId, strategy, lesson: "x", evidence: ["e"] },
    { scope, sessionId, reportId, strategy, lesson: "", evidence: ["e"] },
    { scope, sessionId, reportId, strategy, lesson: "x", evidence: [] },
    { scope, sessionId, reportId, strategy, lesson: "x", evidence: ["e", "e", "e", "e", "e"] },
    { scope, sessionId, reportId, strategy: { ...strategy, unknown: true }, lesson: "x", evidence: ["e"] },
  ])
    expect(harnessExperienceInputSchema.safeParse(value).success).toBe(false);
});
