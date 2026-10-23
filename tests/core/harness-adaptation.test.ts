import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { adaptHarness, harnessStrategyMessage, type AdaptHarnessOptions } from "../../src/core/harness-adaptation";
import type { LocalToolRegistry } from "../../src/shared/contracts";
import { BASELINE_HARNESS_STRATEGY } from "../../src/shared/harness-adaptation";
import { parseSessionId, type ToolResult, type Usage } from "../../src/shared/schemas";
import { createAdaptationFixture, fixtureStrategy, readDefinition, response, toolResponse } from "../fixtures/harness-adaptation";

afterEach(() => vi.useRealTimers());
function fixture(probeTool = "read_file") {
  const model = createAdaptationFixture({ probeTool });
  const execute = vi.fn<LocalToolRegistry["execute"]>(async (_call, context) => {
    expect(context.permission).toBe("readonly");
    return { content: "fixture observation", isError: false };
  });
  const registries: LocalToolRegistry[] = [];
  const usage: (Usage | undefined)[] = [];
  const controller = new AbortController();
  const args: AdaptHarnessOptions = {
    input: { candidates: 1, maxProbeTurns: 2, experience: "off" },
    host: { createProbeTools: async () => {
      const registry = { definitions: [readDefinition], execute, dispose: vi.fn(async () => {}) };
      registries.push(registry); return registry;
    } },
    provider: model.provider, sessionId: parseSessionId(randomUUID()), workspace: "/fixture", model: "fixture-model",
    messages: [{ role: "system", content: "old unrestricted prompt" }, { role: "user", content: "inspect a fixture" }],
    systemInstructions: "Effective permission: readonly.", signal: controller.signal,
    onUsage: incoming => usage.push(incoming), onProgress: async progress => model.onProgress(progress),
    onToolCall: vi.fn(),
  };
  return { args, model, execute, registries, usage, controller };
}

it("runs independent baseline/propose/probe/compose/verify/select with bounded real evidence and usage", async () => {
  const f = fixture();
  const report = await adaptHarness(f.args);
  expect(report.status).toBe("adopted");
  expect(report.probes.map(probe => probe.id)).toEqual(["baseline", "candidate-1", "composed"]);
  expect(f.model.progresses.map(item => item.phase)).toEqual(["baseline", "propose", "probe", "compose", "verify", "select", "completed"]);
  expect(report.evidenceIds).toEqual(["composed:tool-1"]);
  expect(report.modelRequests).toBe(9);
  expect(report.toolCalls).toBe(3);
  expect(f.usage).toHaveLength(9);
  expect(f.args.onToolCall).toHaveBeenCalledTimes(3);
  expect(f.registries).toHaveLength(3);
  for (const registry of f.registries) expect(registry.dispose).toHaveBeenCalledTimes(1);
  for (const request of f.model.requests) {
    expect(request.webSearch).toBe("disabled");
    expect(JSON.stringify(request.messages)).not.toContain("old unrestricted prompt");
  }
  expect(f.model.requests[0]?.messages.some(message => message.content?.includes("HARNESS_FIXTURE_STRATEGY"))).toBe(false);
  expect(harnessStrategyMessage(fixtureStrategy)).toMatchObject({ role: "user", origin: "agent_reconciliation" });
  expect(harnessStrategyMessage(BASELINE_HARNESS_STRATEGY)).toBeUndefined();
});

it.each(["write_file", "run_command", "spawn_agent", "mcp_call_tool", "get_memory", "unregistered"])(
  "denies %s even when the model ignores the advertised definitions", async tool => {
    const f = fixture(tool);
    const report = await adaptHarness(f.args);
    expect(f.execute).not.toHaveBeenCalled();
    expect(report.status).toBe("baseline");
    expect(report.probes.every(probe => probe.evidence[0]?.isError)).toBe(true);
  },
);

it("does not admit a partial batch above the probe tool limit", async () => {
  const f = fixture();
  f.args.input = { candidates: 1, maxProbeTurns: 2, maxProbeToolCalls: 1, experience: "off" };
  const complete = f.args.provider.complete;
  f.args.provider.complete = async (...args) => {
    if (["baseline", "probe", "verify"].includes(f.model.phase)) {
      const first = toolResponse("read_file", {}, "one");
      const second = toolResponse("read_file", {}, "two");
      return { ...first, message: { ...first.message, tool_calls: [...(first.message.tool_calls ?? []), ...(second.message.tool_calls ?? [])] } };
    }
    return complete(...args);
  };
  const report = await adaptHarness(f.args);
  expect(f.execute).not.toHaveBeenCalled();
  expect(report.probes.every(probe => probe.status === "limited")).toBe(true);
  expect(report.status).toBe("baseline");
  expect(report.toolCalls).toBe(0);
});

it("retains baseline when a selector claims improvement without observed tool evidence", async () => {
  const f = fixture();
  const complete = f.args.provider.complete;
  f.args.provider.complete = (...args) => ["baseline", "probe", "verify"].includes(f.model.phase)
    ? Promise.resolve(response("unsupported claims")) : complete(...args);
  expect((await adaptHarness(f.args)).status).toBe("baseline");
});

it.each(["invalid-json", "extra-field", "invented-reference", "meta-tool", "hosted-search"])(
  "stops on %s instead of silently retrying or selecting a fallback", async problem => {
    const f = fixture();
    const complete = f.args.provider.complete;
    let failures = 0;
    f.args.provider.complete = async (...args) => {
      if (f.model.phase !== "propose") return complete(...args);
      failures++;
      if (problem === "invalid-json") return response("not JSON");
      if (problem === "meta-tool") return toolResponse("write_file");
      if (problem === "hosted-search") return { message: { role: "assistant", content: "bad", citations: [{ url: "https://example.com", title: "external", startIndex: 0, endIndex: 3 }] } };
      if (problem === "extra-field") return response(JSON.stringify({ candidates: [{ ...fixtureStrategy, permission: "unrestricted" }] }));
      return response(JSON.stringify({ candidates: [fixtureStrategy] }));
    };
    if (problem === "invented-reference") {
      const current = f.args.provider.complete;
      f.args.provider.complete = (...args) => f.model.phase === "select"
        ? Promise.resolve(response(JSON.stringify({ adopt: true, rationale: "fake", evidenceIds: ["never-observed"] }))) : current(...args);
    }
    await expect(adaptHarness(f.args)).rejects.toMatchObject({ code: "provider" });
    expect(failures).toBe(1);
    expect(f.model.progresses.some(progress => progress.phase === "completed")).toBe(false);
  },
);

it("joins registries and marks missing usage on provider failure or cancellation", async () => {
  const f = fixture();
  f.args.provider.complete = async () => { throw new Error("offline failure"); };
  await expect(adaptHarness(f.args)).rejects.toThrow("offline failure");
  expect(f.usage).toEqual([undefined]);
  expect(f.registries[0]?.dispose).toHaveBeenCalledTimes(1);
  const g = fixture();
  g.args.provider.complete = async () => { g.controller.abort(); return new Promise(() => {}); };
  await expect(adaptHarness(g.args)).rejects.toMatchObject({ code: "cancelled" });
  expect(g.registries[0]?.dispose).toHaveBeenCalledTimes(1);
});

it("enforces the preflight deadline without a late formal execution", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.args.input = { timeoutMs: 1000 };
  f.args.provider.complete = async () => new Promise(() => {});
  const result = adaptHarness(f.args).catch(error => error);
  await vi.advanceTimersByTimeAsync(1001);
  expect(await result).toMatchObject({ code: "budget" });
  expect(f.registries[0]?.dispose).toHaveBeenCalledTimes(1);
  expect(f.usage).toEqual([undefined]);
});

it("rejects unbounded task context without calling the provider and joins tools", async () => {
  const f = fixture();
  f.args.messages = [{ role: "user", content: "x".repeat(140000) }];
  await expect(adaptHarness(f.args)).rejects.toMatchObject({ code: "budget" });
  expect(f.model.requests).toHaveLength(0);
  expect(f.registries[0]?.dispose).toHaveBeenCalledTimes(1);
});

it("rejects read tools reporting mutations and does not retain their evidence", async () => {
  const f = fixture();
  f.execute.mockResolvedValue({ content: "changed", isError: false, changes: [{ path: "fixture.txt", kind: "modified" }] });
  await expect(adaptHarness(f.args)).rejects.toMatchObject({ code: "tool" });
  expect(f.registries[0]?.dispose).toHaveBeenCalledTimes(1);
});

it("redacts and marks bounded evidence, and uses scoped experiences only after the fresh baseline", async () => {
  const f = fixture();
  const experienceId = randomUUID();
  const experience = { id: experienceId, createdAt: new Date().toISOString(), reportId: randomUUID(), sessionId: randomUUID(),
    scope: { workspace: "/fixture", model: "fixture-model", domain: "general" }, strategy: fixtureStrategy,
    lesson: "OLD_EXPERIENCE secret-value", evidence: ["observed file"] };
  const list = vi.fn(async () => [experience]);
  f.args.input = { candidates: 1, maxProbeTurns: 2 };
  f.args.host = { ...f.args.host, redact: text => text.replaceAll("secret-value", "[REDACTED]"),
    experiences: { list, save: vi.fn(async () => experience) } };
  f.execute.mockResolvedValue({ content: `secret-value${"x".repeat(3000)}`, isError: false } satisfies ToolResult);
  const report = await adaptHarness(f.args);
  expect(report.experiencesUsed).toEqual([experienceId]);
  expect(JSON.stringify(report)).not.toContain("secret-value");
  expect(report.probes[0]?.evidence[0]?.truncated).toBe(true);
  expect(list).toHaveBeenCalledWith(experience.scope);
  expect(JSON.stringify(f.model.requests.filter(item => item.phase === "baseline"))).not.toContain("OLD_EXPERIENCE");
  expect(JSON.stringify(f.model.requests.find(item => item.phase === "propose"))).toContain("OLD_EXPERIENCE");
  expect(f.args.host.experiences?.save).not.toHaveBeenCalled();
});

it("does not stringify opaque provider metadata into editor or judge task text", async () => {
  const f = fixture();
  f.args.messages = [{ role: "assistant", content: "prior answer", reasoning: "PRIVATE_REASONING_METADATA",
    tool_calls: [{ id: "prior-call", type: "function", function: { name: "read_file", arguments: "{}" } }],
    providerState: { version: 1, apiMode: "responses", model: "fixture-model", baseUrl: "https://private-provider.invalid/v1",
      credentialScope: "PRIVATE_CREDENTIAL_SCOPE", output: [] } },
    { role: "tool", tool_call_id: "prior-call", content: "previous observation" }, { role: "user", content: "inspect the fixture" }];
  await adaptHarness(f.args);
  const metadataRequests = f.model.requests.filter(request => ["propose", "compose", "select"].includes(request.phase));
  expect(metadataRequests).toHaveLength(3);
  expect(JSON.stringify(metadataRequests)).not.toContain("private-provider");
  expect(JSON.stringify(metadataRequests)).not.toContain("PRIVATE_CREDENTIAL_SCOPE");
  expect(JSON.stringify(metadataRequests)).not.toContain("PRIVATE_REASONING_METADATA");
  expect(JSON.stringify(metadataRequests)).toContain("prior answer");
  const projected = JSON.parse(metadataRequests[0]?.messages.at(-1)?.content ?? "{}").task;
  expect(projected[0].tool_calls[0].id).toBe("prior-call");
  expect(projected[1].tool_call_id).toBe("prior-call");
  expect(f.model.requests[0]?.messages[1]).toHaveProperty("providerState");
});

it("redacts even malicious tool names before feedback or persistent reports", async () => {
  const f = fixture("secret-value");
  f.args.host = { ...f.args.host, redact: text => text.replaceAll("secret-value", "[REDACTED]") };
  const report = await adaptHarness(f.args);
  expect(JSON.stringify(report)).not.toContain("secret-value");
  expect(JSON.stringify(f.model.requests.filter(request => ["propose", "compose", "select"].includes(request.phase)))).not.toContain("secret-value");
  expect(f.execute).not.toHaveBeenCalled();
});
