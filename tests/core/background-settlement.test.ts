import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentRuntime } from "../../src/core/runtime";
import { createCombinedToolRegistry } from "../../src/tools/combined";
import { defaultPublicSettings } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";

it("joins background commands before finalizing and delivers each settlement only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-background-runtime-"));
  const store = await openSessionStore(dir);
  const session = await store.create({ workspace: dir, title: "background", model: "test" });
  let turns = 0; let settled = false;
  const tools = createCombinedToolRegistry({ definitions: [], execute: async () => ({ content: "", isError: false }),
    settleBackground: async (id, signal) => {
      expect(id).toBe(session.id); expect(signal.aborted).toBe(false);
      if (settled) return undefined;
      settled = true;
      return { content: JSON.stringify({ tasks: [{ id: "owned-task", status: "failed", exit_code: 1 }] }), isError: true };
    }, dispose: async () => {} });
  try {
    const runtime = createAgentRuntime({ store, tools, settings: defaultPublicSettings, provider: {
      listModels: async () => [], complete: async messages => {
        if (++turns === 2) {
          expect(messages.at(-1)).toMatchObject({ role: "user", origin: "agent_reconciliation" });
          expect(messages.at(-1)?.content).toContain("owned-task");
          expect(messages.at(-1)?.content).toContain("do not replay");
        }
        return { message: { role: "assistant", content: turns === 1 ? "preliminary" : "Failure inspected and explained." } };
      },
    } });
    const result = await runtime.run({ sessionId: session.id, prompt: "run" }, () => {}, async () => false, new AbortController().signal);
    expect(turns).toBe(2);
    expect(result.messages.at(-1)?.content).toBe("Failure inspected and explained.");
    expect(result.messages.filter(m => m.role === "user" && m.origin)).toHaveLength(1);
  } finally { await tools.dispose(); await rm(dir, { recursive: true, force: true }); }
});
