import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import { createRuntimeHub } from "../../src/host/runtime";
import type { ModelProvider } from "../../src/shared/contracts";
import { rpcResponseSchema } from "../../src/shared/ipc";
import type { BrowserRequest } from "../../src/shared/plugins";
import { collectPublishedFiles } from "../../src/shared/published-files";
import type { SessionSnapshot } from "../../src/shared/schemas";
import { createWebHost } from "../../src/web/server";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Opt-in: requires the pinned optional agent-browser package and an installed
// Chrome/Chromium. All website, Core and browser state is fixture-owned; no real provider is called.
it.runIf(process.env.FORGE_BROWSER_SMOKE === "1")(
  "shares a real browser across agent tools, authenticated preview/takeover and published attachments",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-browser-live-"));
    const state = join(root, "state");
    const abort = new AbortController();
    const opened = deferred();
    const releaseModel = deferred();
    let service: Awaited<ReturnType<typeof createHarness>> | undefined;
    let runtime: ReturnType<typeof createRuntimeHub> | undefined;
    let web: Awaited<ReturnType<typeof createWebHost>> | undefined;
    let run: Promise<SessionSnapshot> | undefined;
    const site = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><h1>Forge browser fixture</h1>
      <label>Name <input id="name"></label><button id="go">Greet</button><p id="result">Ready</p>
      <script>document.querySelector('#go').onclick=()=>document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value;</script>
      </body></html>`);
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    const target = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    let step = 0;
    const toolMessage = (name: string, args: object = {}) => ({
      message: {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: randomUUID(),
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    });
    const provider: ModelProvider = {
      listModels: async () => ["fixture"],
      complete: async (messages) => {
        switch (step++) {
          case 0:
            return toolMessage("browser_navigate", { url: target });
          case 1: {
            const last = JSON.parse(
              messages.findLast((message) => message.role === "tool")
                ?.content ?? "{}",
            );
            if (last.isError)
              throw new Error(`Fixture navigation failed: ${last.content}`);
            opened.resolve();
            await releaseModel.promise;
            return toolMessage("browser_read");
          }
          case 2:
            expect(
              messages.findLast((message) => message.role === "tool")?.content,
            ).toContain("Hello Human");
            return toolMessage("browser_screenshot");
          default:
            return {
              message: {
                role: "assistant",
                content: "Shared browser and screenshot verified.",
              },
            };
        }
      },
    };
    try {
      const browserExecutablePath =
        process.env.FORGE_BROWSER_EXECUTABLE ||
        (await import("playwright")).chromium.executablePath();
      service = await createHarness({
        stateDir: state,
        providerFactory: () => provider,
      });
      await service.updateSettings({
        settings: { model: "fixture", baseUrl: "http://fixture.invalid" },
      });
      await service.configurePlugin!({
        pluginId: "browser",
        enabled: true,
        config: { allowedDomains: ["127.0.0.1"], browserExecutablePath },
      });
      const health = await service.checkPlugin!("browser");
      expect(health, health.message).toMatchObject({ status: "ready" });
      const session = await service.createSession({
        workspace: root,
        title: "Browser live fixture",
      });
      runtime = createRuntimeHub(service);
      web = await createWebHost({
        runtime,
        workspace: root,
        host: "127.0.0.1",
        port: 5173,
        restrictWorkspace: true,
      });
      const currentWeb = web;
      web.server.on("request", (request, response) => {
        void currentWeb.handle(request, response, () =>
          response.end("fixture"),
        );
      });
      await new Promise<void>((resolve) =>
        web!.server.listen(0, "127.0.0.1", resolve),
      );
      const base = `http://127.0.0.1:${(web.server.address() as { port: number }).port}`;
      const post = (path: string, body: unknown, clientId?: string) =>
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          const request = httpRequest(
            `${base}${path}`,
            {
              method: "POST",
              headers: {
                Host: "127.0.0.1:5173",
                Origin: currentWeb.origin,
                "Content-Type": "application/json",
                ...(clientId ? { "X-Forge-Client": clientId } : {}),
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk: Buffer) => chunks.push(chunk));
              response.on("end", () => {
                try {
                  resolve({
                    status: response.statusCode ?? 500,
                    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          request.setTimeout(20000, () =>
            request.destroy(new Error("Fixture RPC timeout")),
          );
          request.on("error", reject);
          request.end(JSON.stringify(body));
        });
      const connected = await post("/api/connect", {});
      expect(connected.status).toBe(200);
      const clientId = (connected.body as { clientId: string }).clientId;
      const requestBrowser = async (input: BrowserRequest) => {
        const response = await post(
          "/api/rpc",
          { id: randomUUID(), method: "browser", input },
          clientId,
        );
        expect(response.status).toBe(200);
        const parsed = rpcResponseSchema.parse(response.body);
        if (!parsed.ok || parsed.method !== "browser")
          throw new Error(JSON.stringify(parsed));
        return parsed.result;
      };
      expect(
        await requestBrowser({ sessionId: session.id, action: "status" }),
      ).toMatchObject({ available: false });
      run = service.run(
        {
          sessionId: session.id,
          prompt: "Open the fixture and wait for human control",
          permission: "unrestricted",
        },
        () => {},
        async () => false,
        abort.signal,
      );
      await Promise.race([
        opened.promise,
        run.then((result) => {
          throw new Error(`Run ended before browser control: ${result.status}`);
        }),
      ]);
      expect(
        await requestBrowser({ sessionId: session.id, action: "status" }),
      ).toMatchObject({ available: true });
      const denied = await post(
        "/api/rpc",
        {
          id: randomUUID(),
          method: "browser",
          input: {
            sessionId: session.id,
            action: "execute",
            command: { action: "click", selector: "#go" },
          },
        },
        clientId,
      );
      expect(denied.body).toMatchObject({ ok: false, error: { code: "tool" } });
      await requestBrowser({
        sessionId: session.id,
        action: "takeover",
        enabled: true,
      });
      expect(
        (
          await requestBrowser({
            sessionId: session.id,
            action: "execute",
            command: { action: "fill", selector: "#name", text: "Human" },
          })
        ).result?.isError,
      ).toBe(false);
      expect(
        (
          await requestBrowser({
            sessionId: session.id,
            action: "execute",
            command: { action: "click", selector: "#go" },
          })
        ).result?.isError,
      ).toBe(false);
      const preview = await requestBrowser({
        sessionId: session.id,
        action: "execute",
        command: { action: "screenshot" },
      });
      expect(preview.takeover).toBe(true);
      expect(preview.result?.image?.data.length).toBeGreaterThan(100);
      expect(preview.result?.image?.data.length).toBeLessThanOrEqual(700000);
      await requestBrowser({
        sessionId: session.id,
        action: "takeover",
        enabled: false,
      });
      releaseModel.resolve();
      const result = await run;
      expect(result.status).toBe("completed");
      const files = collectPublishedFiles(result.messages);
      expect(files).toHaveLength(1);
      const attachment = await service.getPublishedFile!(
        session.id,
        files[0]!.id,
      );
      expect(attachment.file.previewKind).toBe("image");
      expect(Buffer.from(attachment.base64, "base64").length).toBe(
        attachment.file.size,
      );
      expect(
        await requestBrowser({ sessionId: session.id, action: "status" }),
      ).toMatchObject({ available: false, takeover: false });
      expect((await service.listPlugins!())[0]).toMatchObject({
        status: "configured",
        activeSessions: 0,
      });
      expect(await readdir(join(state, "browser-plugin"))).toEqual([]);
      expect(
        (await readdir(state)).some((name) => name === "plugins.json"),
      ).toBe(true);
    } finally {
      abort.abort();
      releaseModel.resolve();
      await run?.catch(() => undefined);
      await web?.dispose();
      await runtime?.dispose();
      await service?.dispose();
      await new Promise<void>((resolve, reject) => {
        site.close((error) => (error ? reject(error) : resolve()));
        site.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
