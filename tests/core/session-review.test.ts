import { expect, it, vi } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type { LocalToolRegistry, ModelProvider, SessionStore } from "../../src/shared/contracts";
import { defaultPublicSettings, type AgentEvent } from "../../src/shared/schemas";
import { sessionReviewInput } from "../../src/shared/session-review";
import { reviewSession } from "../fixtures/review-session";

it("reviews compacted edits in the same runtime/model, enforces readonly tools and persists findings", async () => {
  const original = reviewSession({ messages: [
    { role: "system", content: "old instructions" },
    { role: "user", content: "change example" },
    { role: "assistant", content: "Committed changes." },
  ], contextSummary: { boundary: 3, content: "Earlier change was committed.", fallback: false } });
  let current = original;
  const store: SessionStore = {
    list: async () => [], get: async () => current, create: async () => current,
    save: async snapshot => { current = snapshot; }, acquire: async () => async () => {},
  };
  let turn = 0;
  const provider: ModelProvider = {
    listModels: async () => [],
    complete: async (messages, _tools, options) => {
      expect(options.model).toBe("selected-model");
      expect(options.sessionId).toBe(original.id);
      const prompt = messages.findLast(message => message.role === "user")?.content;
      if (prompt === "ordinary follow up") {
        expect(messages[0]?.content).toContain("Effective permission: unrestricted");
        return { message: { role: "assistant", content: "Follow up complete." } };
      }
      expect(prompt).toContain("src/example.ts");
      expect(prompt).toContain('"text":"old\\n"');
      expect(messages[0]?.content).toContain("Effective permission: readonly");
      expect(messages[0]?.content).not.toContain("Plan mode:");
      if (turn++ === 0) return { message: { role: "assistant", content: null, tool_calls: [
        { id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"src/example.ts"}' } },
        { id: "write", type: "function", function: { name: "write_file", arguments: '{"path":"src/example.ts","content":"bad"}' } },
        { id: "command", type: "function", function: { name: "run_command", arguments: '{"argv":["echo","bad"],"timeout_ms":1000}' } },
      ] } };
      for (const id of ["write", "command"]) {
        const result = messages.find(message => message.role === "tool" && message.tool_call_id === id);
        expect(result?.content).toContain("Core readonly policy denies");
      }
      options.onText("审查结果：没有发现明确问题。");
      return { message: { role: "assistant", content: "审查结果：没有发现明确问题。" } };
    },
  };
  const execute = vi.fn<LocalToolRegistry["execute"]>(async () => ({ content: "1: new", isError: false }));
  const approve = vi.fn(async () => true);
  const events: AgentEvent[] = [];
  const runtime = createAgentRuntime({ store, provider,
    settings: { ...defaultPublicSettings, defaultPermission: "unrestricted" },
    tools: { definitions: [], execute, dispose: async () => {} },
  });
  const result = await runtime.run({ ...sessionReviewInput(original), model: "selected-model" },
    event => events.push(event), approve, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(result.id).toBe(original.id);
  expect(result.changes).toEqual(original.changes);
  expect(result.messages.at(-1)?.content).toBe("审查结果：没有发现明确问题。");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]).toMatchObject({ function: { name: "read_file" } });
  expect(approve).not.toHaveBeenCalled();
  expect(events).toContainEqual(expect.objectContaining({ type: "run_started", permission: "readonly", model: "selected-model" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "审查结果：没有发现明确问题。" }));
  const next = await runtime.run({ sessionId: original.id, prompt: "ordinary follow up" },
    () => {}, approve, new AbortController().signal);
  expect(next.status).toBe("completed");
});
