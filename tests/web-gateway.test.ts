import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  type Server as HttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request,
} from "node:http";
import {
  type AddressInfo,
  type Server as NetServer,
  createServer as createTcpServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { createHarness } from "../src/core/harness";
import { type RunEvent, runEventSchema } from "../src/shared/ipc";
import { createWebGateway } from "../src/web/gateway";
import { createWebHost } from "../src/web/server";

const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = 5173;
const GATEWAY_AUTHORITY = `${GATEWAY_HOST}:${GATEWAY_PORT}`;
const GATEWAY_ORIGIN = `http://${GATEWAY_AUTHORITY}`;
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
});

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

function call(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string> | string[];
    body?: string | Buffer;
  } = {},
): Promise<HttpResult> {
  return new Promise((done, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          done({
            status: res.statusCode ?? 500,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function listen(server: NetServer, port: number): Promise<void> {
  return new Promise((done, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      done();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    (server as HttpServer).closeAllConnections?.();
  });
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await listen(server, 0);
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release: () => release?.() };
}

function apiHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Host: GATEWAY_AUTHORITY,
    Origin: GATEWAY_ORIGIN,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function gatewayCall(
  gateway: { port: number },
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<HttpResult> {
  return call(gateway.port, path, {
    ...options,
    headers: { Host: GATEWAY_AUTHORITY, ...(options.headers ?? {}) },
  });
}

async function rendererFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "forge-gateway-renderer-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "renderer");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    [
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'none';">`,
      `<script src="./assets/app-12345678.js"></script>`,
    ].join(""),
  );
  await writeFile(
    join(root, "assets/app-12345678.js"),
    "console.log('renderer asset');\n",
  );
  return root;
}

async function startGateway(
  coreUrl: string,
  rendererRoot: string,
): Promise<{
  gateway: Awaited<ReturnType<typeof createWebGateway>>;
  port: number;
  origin: string;
  authority: string;
}> {
  const gateway = await createWebGateway({
    host: GATEWAY_HOST,
    port: GATEWAY_PORT,
    coreUrl,
    rendererRoot,
  });
  await listen(gateway.server, 0);
  cleanup.push(() => gateway.close());
  const address = gateway.server.address();
  if (!address || typeof address === "string")
    throw new Error("The Web gateway did not expose a TCP address.");
  return {
    gateway,
    port: address.port,
    origin: gateway.origin,
    authority: GATEWAY_AUTHORITY,
  };
}

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawHeaders: readonly string[];
  readonly body: string;
}

type FakeCoreHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  recorded: RecordedRequest,
) => void | Promise<void>;

async function startFakeCore(
  handler?: FakeCoreHandler,
): Promise<{ port: number; url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const recorded: RecordedRequest = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      if (handler) {
        void Promise.resolve(handler(request, response, recorded)).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
        return;
      }
      if (recorded.url.startsWith("/preview/")) {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end("<html>preview fixture</html>");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        "X-Forge-Snapshot": "fake-revision",
      });
      response.end(
        JSON.stringify({
          authorization: recorded.rawHeaders.filter(
            (value, index) =>
              index % 2 === 0 && value.toLowerCase() === "authorization",
          ).length,
          body: recorded.body,
          host: recorded.headers.host,
          method: recorded.method,
          origin: recorded.headers.origin,
          url: recorded.url,
        }),
      );
    });
  });
  await listen(server, 0);
  cleanup.push(() => closeServer(server));
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, requests };
}

interface CoreFixture {
  readonly port: number;
  readonly url: string;
  readonly origin: string;
  readonly authority: string;
  readonly directory: string;
  readonly release: () => void;
  readonly heldRunCalls: () => number;
}

async function startCoreFixture(): Promise<CoreFixture> {
  const directory = await mkdtemp(join(tmpdir(), "forge-gateway-core-"));
  const state = join(directory, "state");
  const gate = deferred();
  let heldRunCalls = 0;
  const service = await createHarness({
    stateDir: state,
    providerFactory: () => ({
      listModels: async () => ["gateway-model"],
      complete: async (messages, _tools, options) => {
        if (
          messages.some(
            (message) =>
              message.role === "user" &&
              message.content === "hold for gateway restart",
          )
        ) {
          heldRunCalls += 1;
          options.onText("core continues");
          await new Promise<void>((done) => {
            if (options.signal?.aborted) {
              done();
              return;
            }
            options.signal?.addEventListener("abort", () => done(), {
              once: true,
            });
            void gate.promise.then(() => done());
          });
          return {
            message: {
              role: "assistant",
              content: "finished after gateway close",
            },
          };
        }
        return { message: { role: "assistant", content: "fixture reply" } };
      },
    }),
  });
  await service.updateSettings({
    settings: { baseUrl: "http://localhost:1234/v1", model: "gateway-model" },
  });

  let port = await freePort();
  let core: Awaited<ReturnType<typeof createWebHost>> | undefined;
  for (let attempt = 0; attempt < 3 && core === undefined; attempt += 1) {
    const candidate = await createWebHost({
      service,
      workspace: directory,
      host: GATEWAY_HOST,
      port,
    });
    candidate.server.on("request", (request, response) => {
      void candidate
        .handle(request, response, () => {
          response.writeHead(404, { "Content-Type": "text/plain" });
          response.end("Not found");
        })
        .catch(() => response.destroy());
    });
    try {
      await listen(candidate.server, port);
      core = candidate;
    } catch {
      await candidate.dispose();
      port = await freePort();
    }
  }
  if (!core) throw new Error("Could not bind the Core fixture listener.");
  cleanup.push(async () => {
    gate.release();
    await core.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    port,
    url: core.origin,
    origin: core.origin,
    authority: `${GATEWAY_HOST}:${port}`,
    directory,
    release: gate.release,
    heldRunCalls: () => heldRunCalls,
  };
}

interface EventStream {
  readonly ws: WebSocket;
  readonly received: RunEvent[];
  readonly cursors: number[];
}

async function connectEvents(
  gateway: { port: number; origin: string; authority: string },
  auth: Record<string, string>,
  cursor = 0,
  override: { host?: string; origin?: string } = {},
): Promise<EventStream> {
  const clientId = auth["X-Forge-Client"] ?? "";
  const ws = new WebSocket(
    `ws://127.0.0.1:${gateway.port}/api/events?clientId=${encodeURIComponent(clientId)}&cursor=${cursor}`,
    {
      headers: {
        ...auth,
        Host: override.host ?? gateway.authority,
        Origin: override.origin ?? gateway.origin,
      },
    },
  );
  cleanup.push(async () => ws.terminate());
  const received: RunEvent[] = [];
  const cursors: number[] = [];
  let opened = false;
  await new Promise<void>((done, reject) => {
    ws.once("error", reject);
    ws.once("close", (code) => {
      if (!opened) reject(new Error(`The event socket closed with ${code}.`));
    });
    ws.on("message", (raw) => {
      const batch = z
        .object({
          cursor: z.number(),
          events: z.array(runEventSchema),
        })
        .parse(JSON.parse(raw.toString()));
      received.push(...batch.events);
      cursors.push(batch.cursor);
      ws.send(JSON.stringify({ cursor: batch.cursor }));
      opened = true;
      done();
    });
  });
  return { ws, received, cursors };
}

describe("Web gateway", () => {
  it("serves renderer CSP from its own origin and never proxies static misses", async () => {
    const rendererRoot = await rendererFixture();
    const unusedCore = await freePort();
    const gateway = await startGateway(
      `http://127.0.0.1:${unusedCore}`,
      rendererRoot,
    );
    const index = await gatewayCall(gateway, "/");
    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(index.headers["x-frame-options"]).toBe("DENY");
    expect(index.headers["x-content-type-options"]).toBe("nosniff");
    expect(index.headers["referrer-policy"]).toBe("no-referrer");
    const html = index.body.toString("utf8");
    expect(html).toContain("connect-src 'self' ws://127.0.0.1:5173;");
    expect(html).toContain('src="/assets/app-12345678.js"');

    const asset = await gatewayCall(gateway, "/assets/app-12345678.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(asset.body.toString("utf8")).toContain("renderer asset");

    // The Core URL was never bound. A miss must be a local 404, not a 502.
    const missing = await gatewayCall(gateway, "/private-source.ts");
    expect(missing.status).toBe(404);
    expect(missing.body.toString("utf8")).toBe("Not found");
  });

  it("rejects unsafe core URLs and invalid gateway endpoints", async () => {
    const rendererRoot = await rendererFixture();
    const unsafe = [
      "https://127.0.0.1:5174",
      "http://localhost:5174",
      "http://10.0.0.1:5174",
      "http://0.0.0.0:5174",
      "http://user:pass@127.0.0.1:5174",
      "http://127.0.0.1:5174/api",
      "http://127.0.0.1:5174/a/..",
      "http://127.0.0.1:5174/",
      "http://127.1:5174",
      "http://127.0.0.1:05174",
      "http://0177.0.0.1:5174",
      "http://127.0.0.1:5174?query=1",
      "http://127.0.0.1:5174#fragment",
      "http://127.0.0.1",
      "http://127.0.0.1:80",
    ];
    for (const coreUrl of unsafe) {
      await expect(
        createWebGateway({
          host: GATEWAY_HOST,
          port: GATEWAY_PORT,
          coreUrl,
          rendererRoot,
        }),
      ).rejects.toThrow();
    }
    await expect(
      createWebGateway({
        host: GATEWAY_HOST,
        port: GATEWAY_PORT,
        coreUrl: GATEWAY_ORIGIN,
        rendererRoot,
      }),
    ).rejects.toThrow(/own origin/);
    for (const endpoint of [
      { host: "0.0.0.0", port: GATEWAY_PORT },
      { host: "localhost", port: GATEWAY_PORT },
      { host: GATEWAY_HOST, port: 80 },
    ]) {
      await expect(
        createWebGateway({
          ...endpoint,
          coreUrl: "http://127.0.0.2:5174",
          rendererRoot,
        }),
      ).rejects.toThrow();
    }

    const loopbackVariant = await createWebGateway({
      host: GATEWAY_HOST,
      port: GATEWAY_PORT,
      coreUrl: "http://127.0.0.2:5174",
      rendererRoot,
    });
    await loopbackVariant.close();
  });

  it("validates external Host and Origin before rewriting them for Core", async () => {
    const rendererRoot = await rendererFixture();
    const core = await startFakeCore();
    const gateway = await startGateway(core.url, rendererRoot);
    const ok = await gatewayCall(gateway, "/api/echo?x=1", {
      method: "POST",
      headers: apiHeaders({ Authorization: "Bearer one" }),
      body: '{"hello":"world"}',
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.toString("utf8"))).toMatchObject({
      authorization: 1,
      body: '{"hello":"world"}',
      host: `127.0.0.1:${core.port}`,
      method: "POST",
      origin: `http://127.0.0.1:${core.port}`,
      url: "/api/echo?x=1",
    });
    expect(core.requests).toHaveLength(1);

    const duplicate = await call(gateway.port, "/api/echo", {
      method: "POST",
      headers: [
        "Host",
        GATEWAY_AUTHORITY,
        "Origin",
        GATEWAY_ORIGIN,
        "Content-Type",
        "application/json",
        "Authorization",
        "Bearer one",
        "Authorization",
        "Bearer two",
      ],
      body: "{}",
    });
    expect(duplicate.status).toBe(200);
    expect(JSON.parse(duplicate.body.toString("utf8")).authorization).toBe(2);

    const invalidHost = await gatewayCall(gateway, "/api/echo", {
      method: "POST",
      headers: apiHeaders({ Host: "evil.invalid" }),
      body: "{}",
    });
    expect(invalidHost.status).toBe(403);
    const invalidOrigin = await gatewayCall(gateway, "/api/echo", {
      method: "POST",
      headers: apiHeaders({ Origin: "http://evil.invalid" }),
      body: "{}",
    });
    expect(invalidOrigin.status).toBe(403);
    const missingOrigin = await gatewayCall(gateway, "/api/echo", {
      method: "POST",
      headers: { Host: GATEWAY_AUTHORITY, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingOrigin.status).toBe(403);
    const absoluteTarget = await call(
      gateway.port,
      "http://evil.invalid/api/echo",
      {
        method: "POST",
        headers: apiHeaders(),
        body: "{}",
      },
    );
    expect([400, 403]).toContain(absoluteTarget.status);
    expect(core.requests).toHaveLength(2);

    const preview = await gatewayCall(gateway, "/preview/document?id=fixture", {
      headers: { Origin: GATEWAY_ORIGIN },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers["content-security-policy"]).toBe(
      "default-src 'none'",
    );
    expect(core.requests.at(-1)?.url).toBe("/preview/document?id=fixture");
    expect(core.requests.at(-1)?.headers.host).toBe(`127.0.0.1:${core.port}`);
    expect(core.requests.at(-1)?.headers.origin).toBe(
      `http://127.0.0.1:${core.port}`,
    );

    // The whole /preview URI space is forwarded, not just /preview/document.
    const previewOther = await gatewayCall(gateway, "/preview/other", {
      headers: { Host: GATEWAY_AUTHORITY },
    });
    expect(previewOther.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/preview/other");
    expect(core.requests.at(-1)?.headers.origin).toBeUndefined();
    const previewWrongOrigin = await gatewayCall(gateway, "/preview/other", {
      headers: { Origin: "http://evil.invalid" },
    });
    expect(previewWrongOrigin.status).toBe(403);

    const before = core.requests.length;
    const missing = await gatewayCall(gateway, "/not-an-api");
    expect(missing.status).toBe(404);
    expect(core.requests).toHaveLength(before);
  });

  it("does not retry HTTP errors or transport failures", async () => {
    const rendererRoot = await rendererFixture();
    const attempts = { fail: 0, reset: 0 };
    const core = await startFakeCore((_request, response, recorded) => {
      if (recorded.url === "/api/fail") {
        attempts.fail += 1;
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end('{"error":"fixture failure"}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const gateway = await startGateway(core.url, rendererRoot);
    const failed = await gatewayCall(gateway, "/api/fail", {
      method: "POST",
      headers: apiHeaders(),
      body: "{}",
    });
    expect(failed.status).toBe(500);
    expect(failed.body.toString("utf8")).toBe('{"error":"fixture failure"}');
    expect(attempts.fail).toBe(1);
    const failedAgain = await gatewayCall(gateway, "/api/fail", {
      method: "POST",
      headers: apiHeaders(),
      body: "{}",
    });
    expect(failedAgain.status).toBe(500);
    expect(attempts.fail).toBe(2);

    const resetCore = createTcpServer((socket) => {
      attempts.reset += 1;
      socket.destroy();
    });
    await listen(resetCore, 0);
    cleanup.push(() => closeServer(resetCore));
    const resetPort = (resetCore.address() as AddressInfo).port;
    const resetGateway = await startGateway(
      `http://127.0.0.1:${resetPort}`,
      rendererRoot,
    );
    const reset = await gatewayCall(resetGateway, "/api/rpc", {
      method: "POST",
      headers: apiHeaders(),
      body: "{}",
    });
    expect(reset.status).toBe(502);
    expect(reset.body.toString("utf8")).toContain("Core service unavailable");
    expect(attempts.reset).toBe(1);
  });

  it(
    "destroys a WebSocket handshake that is still waiting on Core",
    { timeout: 10_000 },
    async () => {
      const rendererRoot = await rendererFixture();
      const coreSockets = new Set<Duplex>();
      const reachedCore = deferred();
      const core = createServer();
      core.on("upgrade", (_request, socket) => {
        coreSockets.add(socket);
        socket.once("close", () => coreSockets.delete(socket));
        reachedCore.release();
      });
      await listen(core, 0);
      cleanup.push(async () => {
        for (const socket of coreSockets) socket.destroy();
        await closeServer(core);
      });
      const corePort = (core.address() as AddressInfo).port;
      const gateway = await startGateway(
        `http://127.0.0.1:${corePort}`,
        rendererRoot,
      );
      const pending = connectEvents(gateway, {
        "X-Forge-Client": randomUUID(),
      }).then(
        () => "opened",
        (error: unknown) => error,
      );
      await reachedCore.promise;
      // The browser socket is in Node's upgraded-connection set, but the Core
      // handshake has not produced a 101 and no tunnel exists yet.
      await expect(gateway.gateway.close()).resolves.toBeUndefined();
      expect(await pending).toBeInstanceOf(Error);
    },
  );

  it(
    "streams a 67 MiB chunked response without buffering or truncation",
    { timeout: 30_000 },
    async () => {
      const rendererRoot = await rendererFixture();
      const total = 67 * 1024 * 1024;
      const chunk = Buffer.alloc(256 * 1024);
      for (let index = 0; index < chunk.length; index += 1)
        chunk[index] = index % 251;
      const expectedHash = createHash("sha256");
      for (let sent = 0; sent < total; sent += chunk.length)
        expectedHash.update(
          chunk.subarray(0, Math.min(chunk.length, total - sent)),
        );
      const gate = deferred();
      let restStarted = false;
      const core = await startFakeCore((_request, response, recorded) => {
        if (recorded.url !== "/api/rpc") {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          "X-Forge-Snapshot": "fixture-67mb",
        });
        response.write(chunk);
        void gate.promise.then(() => {
          restStarted = true;
          let sent = chunk.length;
          const pump = (): void => {
            while (sent < total) {
              const size = Math.min(chunk.length, total - sent);
              sent += size;
              if (!response.write(chunk.subarray(0, size))) {
                response.once("drain", pump);
                return;
              }
            }
            response.end();
          };
          pump();
        });
      });
      const gateway = await startGateway(core.url, rendererRoot);
      // If the assertion fails before the first byte arrives, cleanup still
      // releases the fixture writer.
      cleanup.push(async () => gate.release());
      const result = await new Promise<{
        bytes: number;
        firstBeforeRest: boolean;
        hash: string;
        headers: IncomingHttpHeaders;
      }>((done, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: gateway.port,
            path: "/api/rpc",
            method: "POST",
            headers: apiHeaders(),
          },
          (response) => {
            let bytes = 0;
            let first = true;
            let firstBeforeRest = false;
            const hash = createHash("sha256");
            response.on("data", (data: Buffer) => {
              if (first) {
                first = false;
                firstBeforeRest = !restStarted;
                gate.release();
              }
              bytes += data.length;
              hash.update(data);
            });
            response.on("end", () =>
              done({
                bytes,
                firstBeforeRest,
                hash: hash.digest("hex"),
                headers: response.headers,
              }),
            );
            response.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end('{"id":"fixture","method":"getPublishedFile"}');
      });
      expect(result.firstBeforeRest).toBe(true);
      expect(result.bytes).toBe(total);
      expect(result.hash).toBe(expectedHash.digest("hex"));
      expect(result.headers["content-type"]).toBe("application/json");
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.headers["x-forge-snapshot"]).toBe("fixture-67mb");
      expect(result.headers["content-length"]).toBeUndefined();
      expect(result.headers["transfer-encoding"]).toBe("chunked");
    },
  );

  it("proxies real Core API requests while Core keeps its CSRF checks", async () => {
    const rendererRoot = await rendererFixture();
    const core = await startCoreFixture();
    const gateway = await startGateway(core.url, rendererRoot);
    const connected = await gatewayCall(gateway, "/api/connect", {
      method: "POST",
      headers: apiHeaders(),
      body: "{}",
    });
    expect(connected.status).toBe(200);
    const page = JSON.parse(connected.body.toString("utf8")) as {
      clientId: string;
    };
    const auth = apiHeaders({ "X-Forge-Client": page.clientId });
    const create = await gatewayCall(gateway, "/api/rpc", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        id: randomUUID(),
        method: "createSession",
        input: { workspace: core.directory, model: "gateway-model" },
      }),
    });
    expect(create.status).toBe(200);
    const created = JSON.parse(create.body.toString("utf8")) as {
      ok: boolean;
      result: { id: string };
    };
    expect(created.ok).toBe(true);
    const session = await gatewayCall(gateway, "/api/rpc", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        id: randomUUID(),
        method: "getSession",
        sessionId: created.result.id,
      }),
    });
    expect(session.status).toBe(200);
    expect(session.headers["x-forge-snapshot"]).toBeTruthy();

    // The gateway must not turn a bad content type or method into a trusted
    // request: Core still receives and rejects them.
    const wrongType = await gatewayCall(gateway, "/api/rpc", {
      method: "POST",
      headers: apiHeaders({
        "Content-Type": "text/plain",
        "X-Forge-Client": page.clientId,
      }),
      body: "{}",
    });
    expect(wrongType.status).toBe(403);
    const wrongMethod = await gatewayCall(gateway, "/api/connect", {
      headers: apiHeaders({ "X-Forge-Client": page.clientId }),
    });
    expect(wrongMethod.status).toBe(403);

    // Direct Core access remains protected by its own checks.
    const directWrongOrigin = await call(core.port, "/api/rpc", {
      method: "POST",
      headers: {
        Host: core.authority,
        Origin: "http://evil.invalid",
        "Content-Type": "application/json",
        "X-Forge-Client": page.clientId,
      },
      body: "{}",
    });
    expect(directWrongOrigin.status).toBe(403);
  });

  it(
    "keeps the WS cursor across reconnects and lets a Core run survive gateway shutdown",
    { timeout: 30_000 },
    async () => {
      const rendererRoot = await rendererFixture();
      const core = await startCoreFixture();
      let gateway = await startGateway(core.url, rendererRoot);
      const connected = await gatewayCall(gateway, "/api/connect", {
        method: "POST",
        headers: apiHeaders(),
        body: "{}",
      });
      expect(connected.status).toBe(200);
      const page = JSON.parse(connected.body.toString("utf8")) as {
        clientId: string;
      };
      const auth = apiHeaders({ "X-Forge-Client": page.clientId });
      const rpc = async (body: object): Promise<unknown> => {
        const response = await gatewayCall(gateway, "/api/rpc", {
          method: "POST",
          headers: auth,
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        const parsed = JSON.parse(response.body.toString("utf8")) as {
          ok: boolean;
          result: unknown;
        };
        expect(parsed.ok).toBe(true);
        return parsed.result;
      };
      const session = (await rpc({
        id: randomUUID(),
        method: "createSession",
        input: { workspace: core.directory, model: "gateway-model" },
      })) as { id: string };
      const stream = await connectEvents(gateway, auth);
      const started = (await rpc({
        id: randomUUID(),
        method: "startRun",
        input: {
          sessionId: session.id,
          prompt: "hold for gateway restart",
          permission: "readonly",
        },
      })) as { runId: string };
      expect(started.runId).toBeTruthy();
      await expect
        .poll(
          () =>
            stream.received.find((item) => item.event.type === "text_delta")
              ?.event,
        )
        .toBeTruthy();
      const cursor = stream.cursors.at(-1);
      if (cursor === undefined) throw new Error("Missing event cursor");
      stream.ws.terminate();
      await expect.poll(() => stream.ws.readyState).toBe(WebSocket.CLOSED);
      const resumed = await connectEvents(gateway, auth, cursor);
      expect(resumed.cursors[0]).toBeGreaterThanOrEqual(cursor);
      expect(
        resumed.received.some((item) => item.event.type === "text_delta"),
      ).toBe(false);

      // Closing the Web process only drops connections. The held provider turn
      // is still owned by Core and completes while no gateway is listening.
      await gateway.gateway.close();
      await gateway.gateway.close();
      await expect.poll(() => resumed.ws.readyState).toBe(WebSocket.CLOSED);
      core.release();
      const readSession = async (): Promise<{
        status: number;
        body: { ok?: boolean; result?: { status?: string } };
      }> => {
        const response = await call(core.port, "/api/rpc", {
          method: "POST",
          headers: {
            ...auth,
            Host: core.authority,
            Origin: core.origin,
          },
          body: JSON.stringify({
            id: randomUUID(),
            method: "getSession",
            sessionId: session.id,
          }),
        });
        return {
          status: response.status,
          body: JSON.parse(response.body.toString("utf8")) as {
            ok?: boolean;
            result?: { status?: string };
          },
        };
      };
      await expect
        .poll(async () => (await readSession()).body.result?.status)
        .toBe("completed");
      expect(core.heldRunCalls()).toBe(1);
      expect((await readSession()).status).toBe(200);

      gateway = await startGateway(core.url, rendererRoot);
      const replayed = await connectEvents(gateway, auth, cursor);
      await expect
        .poll(
          () =>
            replayed.received.find((item) => item.event.type === "run_finished")
              ?.event,
        )
        .toMatchObject({ status: "completed" });
      expect(
        replayed.received.some((item) => item.event.type === "text_delta"),
      ).toBe(false);
    },
  );

  it("relays the Core WebSocket close code and rejects bad WS origins locally", async () => {
    const rendererRoot = await rendererFixture();
    const core = await startCoreFixture();
    const gateway = await startGateway(core.url, rendererRoot);
    const connected = await gatewayCall(gateway, "/api/connect", {
      method: "POST",
      headers: apiHeaders(),
      body: "{}",
    });
    const page = JSON.parse(connected.body.toString("utf8")) as {
      clientId: string;
    };
    const auth = apiHeaders({ "X-Forge-Client": page.clientId });
    const stream = await connectEvents(gateway, auth);
    const closed = new Promise<number>((done) =>
      stream.ws.once("close", (code) => done(code)),
    );
    stream.ws.send(JSON.stringify({ cursor: 100 }));
    expect(await closed).toBe(1008);

    await expect(
      connectEvents(gateway, { ...auth, "X-Forge-Client": randomUUID() }, 0, {
        origin: "http://evil.invalid",
      }),
    ).rejects.toThrow();
    await expect(
      connectEvents(gateway, { ...auth, "X-Forge-Client": randomUUID() }, 0, {
        host: "evil.invalid",
      }),
    ).rejects.toThrow();
  });
});


it("forwards version headers and allows only the read-only version GET without Origin", async () => {
  const core = await startFakeCore((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "X-Forge-Core-Build": "running-build",
      "X-Forge-Core-Disk-Build": "disk-build", "X-Forge-Core-Restart-Required": "true" });
    response.end('{"restartRequired":"true"}');
  });
  const gateway = await startGateway(core.url, await rendererFixture());
  const version = await gatewayCall(gateway, "/api/version");
  expect(version.status).toBe(200);
  expect(version.headers["x-forge-core-build"]).toBe("running-build");
  expect(version.headers["x-forge-core-disk-build"]).toBe("disk-build");
  expect(version.headers["x-forge-core-restart-required"]).toBe("true");
  expect((await gatewayCall(gateway, "/api/version", { headers: { Origin: "http://foreign.invalid" } })).status).toBe(403);
  expect((await gatewayCall(gateway, "/api/version", { method: "POST" })).status).toBe(403);
  expect((await gatewayCall(gateway, "/api/rpc")).status).toBe(403);
  expect((await gatewayCall(gateway, "/api/version", { headers: { Host: "foreign.invalid" } })).status).toBe(403);
  expect(core.requests).toHaveLength(1);
});
