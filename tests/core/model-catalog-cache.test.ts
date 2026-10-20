import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import { runCliWithIO, type CliIO } from "../../src/cli/cli";
import { createModelProvider } from "../../src/provider/openai";
import type { HarnessService } from "../../src/shared/contracts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(apiMode: "chat-completions" | "responses" | "anthropic") {
  const requests: { url: string; key: unknown }[] = [];
  let fail = false;
  let data: unknown[] = [
    { id: "shared", context_length: "1048576", private_metadata: "do-not-persist" },
    { id: "unknown", max_output_tokens: 8192 },
  ];
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, key: apiMode === "anthropic" ? req.headers["x-api-key"] : req.headers.authorization });
    if (fail) { res.writeHead(401); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data, has_more: false, first_id: "shared", last_id: "unknown" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  const home = await mkdtemp(join(tmpdir(), "forge-persisted-models-"));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });
  let toolStep = false;
  const open = async () => {
    const service = await createHarness({ stateDir: home,
      providerFactory: config => ({ ...createModelProvider(config),
        // Generation stays offline; metadata exercises the real protocol adapter.
        complete: async () => {
          if (!toolStep) {
            toolStep = true;
            return { message: { role: "assistant", content: "", tool_calls: [{ id: "catalog", type: "function", function: { name: "list_models", arguments: "{}" } }] } };
          }
          return { message: { role: "assistant", content: "done" } };
        },
      }),
      toolFactory: () => ({ definitions: [], execute: async () => ({ content: "", isError: false }), dispose: async () => {} }),
    });
    cleanups.push(() => service.dispose());
    return service;
  };
  const base = `http://127.0.0.1:${address.port}`;
  const save = (service: HarnessService, id: string, apiKey = `fixture-${id}`, path = id, mode = apiMode) =>
    service.updateSettings({ source: { type: "save", source: { id, label: id, baseUrl: `${base}/${path}/v1`, model: "shared", apiMode: mode }, apiKey } });
  return { home, requests, open, save, setData: (next: unknown[]) => { data = next; }, setFail: (value: boolean) => { fail = value; } };
}

it.each(["chat-completions", "responses", "anthropic"] as const)("shares persisted %s metadata across discovery, runtime, restart and offline reads", async apiMode => {
  const f = await fixture(apiMode);
  const first = await f.open();
  await f.save(first, "a");
  expect(await first.listModels()).toEqual(["shared", "unknown"]);
  expect(await first.getModelContextWindow!("shared", undefined, "a")).toBe(1048576);
  expect(await first.getModelContextWindow!("unknown")).toBeNull();
  expect(await first.getModelContextWindow!("not-listed")).toBeNull();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.url).toMatch(/^\/a\/v1\/models/);
  expect(f.requests[0]!.key).toBe(apiMode === "anthropic" ? "fixture-a" : "Bearer fixture-a");
  await first.dispose();
  f.setFail(true);
  const restarted = await f.open();
  expect(await restarted.listModels(undefined, "a")).toEqual(["shared", "unknown"]);
  expect(await restarted.getModelContextWindow!("shared")).toBe(1048576);
  const session = await restarted.createSession({ workspace: f.home, title: "Cache fixture" });
  const result = await restarted.run({ sessionId: session.id, prompt: "Use model discovery", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
  expect(result.status).toBe("completed");
  const tool = result.messages.find(message => message.role === "tool");
  const toolResult = JSON.parse(tool!.content!);
  expect(toolResult.isError).toBe(false);
  expect(JSON.parse(toolResult.content)).toMatchObject({ ids: ["shared", "unknown"] });
  expect(result.events.some(event => event.type === "context_usage" && event.usage.windowTokens === 1048576)).toBe(true);
  expect(f.requests).toHaveLength(1);
  const files = (await readdir(join(f.home, "model-catalogs"))).filter(file => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  const text = await readFile(join(f.home, "model-catalogs", files[0]!), "utf8");
  expect(text).not.toContain("do-not-persist");
  expect(text).not.toContain("fixture-a");
  expect(JSON.parse(text).models).toEqual([{ id: "shared", contextWindowTokens: 1048576 }, { id: "unknown", contextWindowTokens: null }]);
});

it("isolates source IDs, endpoints, credentials and protocols even when model IDs overlap", async () => {
  const f = await fixture("chat-completions");
  const service = await f.open();
  await f.save(service, "a");
  expect(await service.getModelContextWindow!("shared", undefined, "a")).toBe(1048576);
  f.setData([{ id: "shared", context_length: 64000 }]);
  await f.save(service, "b", "fixture-a", "a");
  expect(await service.getModelContextWindow!("shared", undefined, "b")).toBe(64000);
  expect(await service.getModelContextWindow!("shared", undefined, "a")).toBe(1048576);
  for (const [secret, path, mode] of [["changed", "a", "chat-completions"], ["changed", "new", "chat-completions"], ["changed", "new", "responses"]] as const) {
    await f.save(service, "a", secret, path, mode);
    expect(await service.listModels(undefined, "a")).toEqual(["shared"]);
  }
  expect(f.requests).toHaveLength(5);
});

it("CLI --refresh updates disk for the selected source and failed refresh leaves it reusable", async () => {
  const f = await fixture("chat-completions");
  const service = await f.open();
  await f.save(service, "a");
  await f.save(service, "b");
  await service.listModels(undefined, "a");
  await service.listModels(undefined, "b");
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIO = { stdout: text => output.push(text), stderr: text => errors.push(text),
    readStdin: async () => "", question: async () => "", isTTY: false, onInterrupt: () => () => {} };
  f.setData([{ id: "fresh", context_window: 524288 }]);
  expect(await runCliWithIO(["models", "--source", "b", "--json"], service, io)).toBe(0);
  expect(f.requests).toHaveLength(2);
  output.length = 0;
  expect(await runCliWithIO(["models", "--source", "b", "--refresh", "--json"], service, io)).toBe(0);
  expect(output.join("")).toBe('["fresh"]\n');
  expect(f.requests).toHaveLength(3);
  expect(await service.getModelContextWindow!("fresh", undefined, "b")).toBe(524288);
  expect(await service.listModels(undefined, "a")).toEqual(["shared", "unknown"]);
  f.setFail(true);
  expect(await runCliWithIO(["models", "--source", "b", "--refresh"], service, io)).toBe(1);
  expect(f.requests).toHaveLength(4);
  expect(await service.listModels(undefined, "b")).toEqual(["fresh"]);
  expect(errors.join("")).not.toContain("fixture-b");
});
