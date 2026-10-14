import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executeNative, nativeDefinitions } from "../../src/core/agents";
import { createAgentRuntime } from "../../src/core/runtime";
import type {
  AgentRuntimeDependencies,
  ModelProvider,
} from "../../src/shared/contracts";
import { defaultPublicSettings } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
const tools = {
  definitions: [],
  execute: async () => ({ content: "", isError: false }),
  dispose: async () => {},
};
async function fixture(listModels: ModelProvider["listModels"]) {
  const dir = await mkdtemp(join(tmpdir(), "forge-model-discovery-"));
  const store = await openSessionStore(dir);
  const snapshot = await store.create({
    workspace: dir,
    title: "catalog",
    model: "explicit/parent",
  });
  const deps: AgentRuntimeDependencies = {
    store,
    tools,
    settings: defaultPublicSettings,
    provider: {
      listModels,
      complete: async () => ({
        message: { role: "assistant", content: "done" },
      }),
    },
  };
  const controller = new AbortController();
  return {
    dir,
    store,
    snapshot,
    deps,
    controller,
    invoke: (args: Record<string, unknown>) =>
      executeNative("list_models", args, {
        deps,
        snapshot,
        input: { sessionId: snapshot.id, prompt: "discover" },
        permission: "readonly",
        signal: controller.signal,
        children: new Map(),
        savePlan: async () => {},
        runChild: async () => snapshot,
        approveChild: () => async () => false,
      }),
  };
}
it("returns exact configured IDs with substring filtering and bounded pagination", async () => {
  let signal: AbortSignal | undefined;
  const f = await fixture(async (s) => {
    signal = s;
    return ["cx/gpt-6-sol", "cbcn/deepseek-v4.1-flash", "Custom/GPT-special"];
  });
  try {
    const first = await f.invoke({ query: "GpT", limit: 1 });
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.content)).toEqual({
      ids: ["cx/gpt-6-sol"],
      total: 2,
      offset: 0,
      returned: 1,
      nextOffset: 1,
      truncated: true,
    });
    expect(signal).toBe(f.controller.signal);
    expect(
      JSON.parse(
        (await f.invoke({ query: "GpT", offset: 1, limit: 1 })).content,
      ),
    ).toEqual({
      ids: ["Custom/GPT-special"],
      total: 2,
      offset: 1,
      returned: 1,
      nextOffset: null,
      truncated: false,
    });
    expect(JSON.parse((await f.invoke({ offset: 9 })).content)).toMatchObject({
      ids: [],
      total: 3,
      returned: 0,
      nextOffset: null,
      truncated: false,
    });
    expect(
      JSON.parse((await f.invoke({ query: "not-in-catalog" })).content),
    ).toMatchObject({ ids: [], total: 0 });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
it("enforces default/max page sizes and a UTF8 byte ceiling without slicing JSON or IDs", async () => {
  const ids = Array.from(
    { length: 150 },
    (_, i) => `exact/${i}/${"😀".repeat(300)}`,
  );
  const f = await fixture(async () => ids);
  try {
    const result = await f.invoke({ limit: 100 });
    expect(result.isError).toBe(false);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(
      32768,
    );
    const page = JSON.parse(result.content);
    expect(page.returned).toBeGreaterThan(0);
    expect(page.returned).toBeLessThan(100);
    expect(page.ids).toEqual(ids.slice(0, page.returned));
    expect(page.nextOffset).toBe(page.returned);
    expect(page.truncated).toBe(true);
    f.deps.provider.listModels = async () =>
      Array.from({ length: 150 }, (_, i) => `id-${i}`);
    expect(JSON.parse((await f.invoke({})).content).returned).toBe(50);
    expect(JSON.parse((await f.invoke({ limit: 100 })).content).returned).toBe(
      100,
    );
    f.deps.provider.listModels = async () => [
      "😀".repeat(40000),
      "exact/small",
    ];
    const oversized = await f.invoke({});
    expect(oversized.isError).toBe(true);
    expect(JSON.parse(oversized.content)).toMatchObject({
      returned: 0,
      nextOffset: 1,
      truncated: true,
    });
    expect(JSON.parse((await f.invoke({ offset: 1 })).content).ids).toEqual([
      "exact/small",
    ]);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
it("rejects malformed or unknown options before calling the provider", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return [];
  });
  try {
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: "0" },
      { query: 4 },
      { query: "x".repeat(257) },
      { unexpected: true },
    ]) {
      expect((await f.invoke(args)).isError).toBe(true);
    }
    expect(calls).toBe(0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
it("reports discovery failure without exposing endpoint/provider exception details or fallback", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    throw Error("private provider endpoint detail");
  });
  try {
    const result = await f.invoke({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("explicitly supplied model IDs");
    expect(result.content).not.toContain("private provider endpoint detail");
    expect(calls).toBe(1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
it("settles cancellation even with an uncooperative provider and denies pre-aborted discovery", async () => {
  let calls = 0;
  let started = () => {};
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const f = await fixture(async () => {
    calls++;
    started();
    return new Promise(() => {});
  });
  try {
    const pending = f.invoke({});
    await entered;
    f.controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cancelled");
    expect((await f.invoke({})).isError).toBe(true);
    expect(calls).toBe(1);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
it("allows native catalog discovery in readonly plan mode with tool pairing and normal budget", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return ["cx/gpt-6-sol", "cbcn/deepseek-v4.1-flash"];
  });
  let turns = 0;
  f.deps.provider.complete = async (messages, definitions, options) => {
    expect(options.model).toBe("explicit/parent");
    expect(definitions).toContainEqual(
      nativeDefinitions.find((d) => d.function.name === "list_models"),
    );
    if (++turns === 1)
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "catalog",
              type: "function",
              function: { name: "list_models", arguments: "{}" },
            },
          ],
        },
      };
    const tool = messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "catalog",
    );
    expect(tool).toBeDefined();
    const result = JSON.parse(tool?.content ?? "{}");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content).ids).toEqual([
      "cx/gpt-6-sol",
      "cbcn/deepseek-v4.1-flash",
    ]);
    return {
      message: {
        role: "assistant",
        content:
          "Plan uses the exact discovered IDs; availability is unverified",
      },
    };
  };
  try {
    const result = await createAgentRuntime(f.deps).run(
      {
        sessionId: f.snapshot.id,
        prompt: "Plan distinct models",
        mode: "plan",
        permission: "unrestricted",
      },
      () => {},
      async () => {
        throw Error("Readonly catalog must not require approval");
      },
      f.controller.signal,
    );
    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
    expect(result.messages.at(-1)?.content).toContain("exact discovered IDs");
    expect(result.events.find((e) => e.type === "run_finished")).toMatchObject({
      toolCalls: 1,
    });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
