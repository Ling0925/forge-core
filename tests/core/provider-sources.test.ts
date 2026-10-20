import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createWorkerController } from "../../src/desktop/controller";
import { createTransportBridge } from "../../src/shared/bridge";

it("fetches each source's OpenAI /models with its own key without activating it", async () => {
  const requests: { url: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url!, auth: req.headers.authorization });
    if (req.url === "/bad/models") { res.writeHead(401); res.end(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: req.url === "/a/models" ? "alpha" : "beta" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing server address");
  const directory = await mkdtemp(join(tmpdir(), "forge-source-test-"));
  const service = await createHarness({ stateDir: directory });
  try {
    const base = `http://127.0.0.1:${address.port}`;
    for (const id of ["a", "b", "bad"]) await service.updateSettings({ source: { type: "save", source: { id, label: id, baseUrl: `${base}/${id}`, model: id === "a" ? "alpha" : "beta", apiMode: "chat-completions" }, apiKey: `fixture-${id}` } });
    expect(await service.listModels(undefined, "b")).toEqual(["beta"]);
    expect((await service.getSettings()).activeSourceId).toBe("a");
    expect(await service.listModels()).toEqual(["alpha"]);
    await service.updateSettings({ source: { type: "activate", id: "b" } });
    expect(await service.listModels()).toEqual(["beta"]);
    expect(requests).toEqual([
      { url: "/b/models", auth: "Bearer fixture-b" },
      { url: "/a/models", auth: "Bearer fixture-a" },
    ]);
    await expect(service.listModels(undefined, "missing")).rejects.toThrow();
    await expect(service.listModels(undefined, "bad")).rejects.toThrow();
    expect(requests.at(-1)).toEqual({ url: "/bad/models", auth: "Bearer fixture-bad" });
    expect(requests.length).toBe(3); // active/explicit source share cache; no cross-source fallback
    expect(JSON.stringify(await service.getSettings())).not.toContain("fixture-b");
    // Exercise the exact renderer -> schema/bridge -> worker -> harness route.
    let response: (value: unknown) => void = () => {};
    const controller = createWorkerController(service, message => {
      if (message.kind === 'response') response(message.response);
    });
    const bridge = createTransportBridge({
      onEvent: () => {},
      request: input => new Promise(resolve => { response = resolve; void controller.handle(input); }),
    });
    expect(await bridge.listModels('a')).toEqual(['alpha']);
    expect(requests).toHaveLength(3);
    expect(await bridge.listModels('a', true)).toEqual(['alpha']);
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)).toEqual({ url: '/a/models', auth: 'Bearer fixture-a' });
    expect((await bridge.getSettings()).activeSourceId).toBe('b');
  } finally {
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
