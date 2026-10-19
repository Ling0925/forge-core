import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import type { ModelProvider } from "../../src/shared/contracts";
import { defaultPublicSettings } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { createLocalToolRegistry } from "../../src/tools/local";

it.each(["create_plan", "write_file"])("returns actionable %s errors and stops repeated invalid input after three attempts", async (name) => {
  const root = await mkdtemp(join(tmpdir(), "forge-validation-loop-"));
  const tools = await createLocalToolRegistry(root);
  try {
    const store = await openSessionStore(join(root, "state"));
    const session = await store.create({ workspace: root, model: "fixture", title: "Validation" });
    let attempts = 0;
    const provider: ModelProvider = {
      listModels: async () => [],
      complete: async messages => {
        const last = messages.at(-1);
        if (last?.role === "tool") {
          const result = JSON.parse(last.content);
          expect(result.isError).toBe(true);
          expect(JSON.parse(result.content)).toMatchObject({ code: "invalid_input" });
          expect(result.content).toContain(name === "create_plan" ? "steps.0.status" : "use append_file");
          expect(result.content).not.toContain("private-marker");
        }
        attempts++;
        const args = name === "create_plan"
          ? { name: `Task ${attempts}`, explanation: "verify", steps: [{ step: `Step ${attempts}`, status: `private-marker-${attempts}` }] }
          : { path: "a.txt", content: `private-marker-${attempts}`, expected_bytes: attempts };
        return { message: { role: "assistant", content: null, tool_calls: [{ id: `call-${attempts}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } };
      },
    };
    const runtime = createAgentRuntime({ store, provider, tools, settings: { ...defaultPublicSettings, maxToolCalls: 10 } });
    const result = await runtime.run({ sessionId: session.id, prompt: "Task" }, () => {}, async () => false, new AbortController().signal);
    expect(attempts).toBe(3);
    expect(result.status).toBe("failed");
    expect(result.events.filter(event => event.type === "tool_finished")).toHaveLength(3);
    expect(result.events.filter(event => event.type === "error")).toMatchObject([{ error: { message: expect.stringContaining("three identical failures") } }]);
    expect(result.changes).toEqual([]);
    expect(result.plan).toBeUndefined();
  } finally {
    await tools.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
