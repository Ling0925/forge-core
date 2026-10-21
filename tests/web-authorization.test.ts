import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createHarness } from "../src/core/harness";
import { createRuntimeHub } from "../src/host/runtime";
import { openDeviceAuthorization } from "../src/store/devices";
import { createWebHost } from "../src/web/server";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
});
function gate() {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function fixture(options: { owned?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "forge-auth-fixture-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state");
  const authorization = await openDeviceAuthorization({ directory: state });
  cleanup.push(() => authorization.close());
  const service = await createHarness({
    stateDir: state,
    providerFactory: () => ({
      listModels: async () => ["fixture"],
      complete: async (_messages, _tools, settings) => {
        settings.onText("fixture output");
        await new Promise<void>((done) => {
          if (settings.signal?.aborted) done();
          else
            settings.signal?.addEventListener("abort", () => done(), {
              once: true,
            });
        });
        return { message: { role: "assistant", content: "fixture output" } };
      },
    }),
  });
  await service.updateSettings({
    settings: { baseUrl: "http://localhost:1234/v1", model: "fixture" },
  });
  const runtime = options.owned ? undefined : createRuntimeHub(service);
  if (runtime) cleanup.push(() => runtime.dispose());
  const web = await createWebHost({
    trustedLan: false, // Explicit custom-host mode, never the normal LAN default.
    ...(runtime ? { runtime } : { service }),
    authorization,
    workspace: directory,
    host: "127.0.0.1",
    port: 5173,
  });
  cleanup.push(() => web.dispose());
  web.server.on("request", (req, res) => {
    void web.handle(req, res, () => res.end("dev source"));
  });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  const port = (web.server.address() as { port: number }).port;
  const headers = {
    Host: "127.0.0.1:5173",
    Origin: web.origin,
    "Content-Type": "application/json",
  };
  const http = (
    path: string,
    input?: unknown,
    extra: Record<string, string> = {},
  ) =>
    new Promise<Response>((done, reject) => {
      const req = request(
        `http://127.0.0.1:${port}${path}`,
        {
          method: input === undefined ? "GET" : "POST",
          headers: { ...headers, ...extra },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            done(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 500,
                headers: res.headers as Record<string, string>,
              }),
            ),
          );
        },
      );
      req.on("error", reject);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  const pair = async (name = "fixture") => {
    const invite = await authorization.createPairing(name);
    const response = await http("/api/pair", { token: invite.token });
    expect(response.status).toBe(200);
    const data = await response.json();
    const bearer = { Authorization: `Bearer ${data.credential}` };
    const connected = await http("/api/connect", {}, bearer);
    expect(connected.status).toBe(200);
    const page = await connected.json();
    return {
      ...data,
      invite,
      cookie: response.headers.get("set-cookie") ?? "",
      clientId: page.clientId as string,
      cursor: page.cursor as number,
      headers: { ...bearer, "X-Forge-Client": page.clientId as string },
    };
  };
  const socket = (
    auth: Record<string, string>,
    clientId: string,
    cursor = 0,
  ) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/events?clientId=${clientId}&cursor=${cursor}`,
      { headers: { ...headers, ...auth } },
    );
    cleanup.push(async () => {
      ws.terminate();
    });
    return ws;
  };
  const events = async (device: Awaited<ReturnType<typeof pair>>) => {
    const ws = socket(device.headers, device.clientId, device.cursor);
    const received: unknown[] = [];
    await new Promise<void>((done, reject) => {
      ws.on("error", reject);
      ws.on("message", (raw) => {
        received.push(JSON.parse(raw.toString()));
        done();
      });
    });
    return { ws, received };
  };
  const rpc = (auth: Record<string, string>, data: object) =>
    http("/api/rpc", { id: randomUUID(), ...data }, auth);
  return {
    directory,
    state,
    authorization,
    service,
    web,
    runtime: web.runtime,
    http,
    pair,
    socket,
    events,
    rpc,
  };
}

it("denies unpaired HTTP, WS, files, preview and dev source while retaining Host/Origin constraints", async () => {
  const f = await fixture();
  for (const path of [
    "/api/connect",
    "/api/rpc",
    "/api/preview",
    "/api/preview/file",
    "/api/workspaces/browse",
    "/api/pairing",
  ])
    expect((await f.http(path, {})).status, path).toBe(401);
  expect((await f.http("/preview/document?id=abc")).status).toBe(401);
  expect((await f.http("/src/renderer/main.tsx")).status).toBe(401);
  expect(
    (await f.http("/api/connect", {}, { Host: "evil.invalid" })).status,
  ).toBe(403);
  expect(
    (await f.http("/api/pair", {}, { Origin: "http://evil.invalid" })).status,
  ).toBe(403);
  expect((await f.http("/api/pair", { token: "invalid" })).status).toBe(401);
  const paired = await f.pair();
  const ws = f.socket({}, paired.clientId);
  await new Promise<void>((done, reject) => {
    ws.once("error", () => done());
    ws.once("open", () => reject(Error("unauthorized socket opened")));
  });
  expect(
    (
      await f.rpc(
        {},
        {
          method: "getPublishedFile",
          sessionId: randomUUID(),
          fileId: randomUUID(),
        },
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await f.rpc(
        {},
        {
          method: "readWorkspaceFile",
          sessionId: randomUUID(),
          path: "secret.txt",
        },
      )
    ).status,
  ).toBe(401);
  expect(
    (await f.http(`/api/connect?credential=${paired.credential}`, {})).status,
  ).toBe(401);
});

it("pairs once, persists distinct device identity and allows multiple cookie/Bearer pages without cross-device page theft", async () => {
  const f = await fixture();
  const a = await f.pair("A");
  const b = await f.pair("B");
  expect(a.cookie).toContain("HttpOnly");
  expect(a.cookie).toContain("SameSite=Strict");
  expect(a.cookie).toContain("Path=/");
  expect((await f.http("/api/pair", { token: a.invite.token })).status).toBe(
    401,
  );
  const cookie = a.cookie.split(";")[0] ?? "";
  const connected = await f.http("/api/connect", {}, { Cookie: cookie });
  expect(connected.status).toBe(200);
  const anotherPage = await connected.json();
  expect(anotherPage.clientId).not.toBe(a.clientId);
  expect(anotherPage.clientId).not.toBe(a.device.id);
  expect(JSON.stringify(anotherPage)).not.toContain(a.credential);
  expect(
    (
      await f.rpc(
        { ...b.headers, "X-Forge-Client": a.clientId },
        { method: "getSettings" },
      )
    ).status,
  ).toBe(410);
  const stolen = f.socket(b.headers, a.clientId);
  await new Promise<void>((done, reject) => {
    stolen.once("error", () => done());
    stolen.once("open", () => reject(Error("stolen page opened")));
  });
  expect(
    (await f.http("/api/connect", {}, { ...a.headers, Cookie: cookie })).status,
  ).toBe(401);
  expect(
    (await f.http("/api/connect", {}, { Cookie: `${cookie}; ${cookie}` }))
      .status,
  ).toBe(401);
  expect((await f.rpc(a.headers, { method: "getSettings" })).status).toBe(200);
});

it("protects preview documents and workspace files, preserving workspace and file traversal restrictions", async () => {
  const f = await fixture();
  const a = await f.pair();
  await writeFile(
    join(f.directory, "report.html"),
    "<h1>fixture private content</h1>",
  );
  const session = await f.service.createSession({ workspace: f.directory });
  const otherDir = join(f.directory, "other");
  await mkdir(otherDir);
  const other = await f.service.createSession({ workspace: otherDir });
  const preview = await f.http(
    "/api/preview/file",
    { path: "report.html" },
    a.headers,
  );
  expect(preview.status).toBe(200);
  const document = (await preview.json()).url;
  expect((await f.http(document)).status).toBe(401);
  const visible = await f.http(document, undefined, {
    Cookie: a.cookie.split(";")[0] ?? "",
  });
  expect(visible.status).toBe(200);
  expect(await visible.text()).toContain("fixture private content");
  expect(visible.headers.get("content-security-policy")).toContain(
    "connect-src 'none'",
  );
  expect(
    (await f.http("/api/preview/file", { path: "../private.html" }, a.headers))
      .status,
  ).not.toBe(200);
  const file = await f.rpc(a.headers, {
    method: "readWorkspaceFile",
    sessionId: session.id,
    path: "report.html",
  });
  expect(await file.json()).toMatchObject({ ok: true });
  expect(
    (
      await f.rpc(a.headers, {
        method: "readWorkspaceFile",
        sessionId: other.id,
        path: "report.html",
      })
    ).status,
  ).toBe(403);
  await f.authorization.revoke(a.device.id);
  expect(
    (
      await f.http(document, undefined, {
        Cookie: a.cookie.split(";")[0] ?? "",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.rpc(a.headers, {
        method: "readWorkspaceFile",
        sessionId: session.id,
        path: "report.html",
      })
    ).status,
  ).toBe(401);
});

it("revokes active sockets and future requests without disturbing another device or accepted core runs", async () => {
  const f = await fixture({ owned: true });
  const a = await f.pair("A");
  const b = await f.pair("B");
  const ea = await f.events(a);
  const eb = await f.events(b);
  const session = await f.service.createSession({ workspace: f.directory });
  const accepted = await f.rpc(a.headers, {
    method: "startRun",
    input: { sessionId: session.id, prompt: "wait", permission: "readonly" },
  });
  const run = await accepted.json();
  expect(run).toMatchObject({ ok: true });
  await vi.waitFor(async () =>
    expect((await f.service.getSession(session.id)).status).toBe("running"),
  );
  const closed = new Promise<void>((done) => ea.ws.once("close", () => done()));
  await f.authorization.revoke(a.device.id);
  await closed;
  expect(eb.ws.readyState).toBe(WebSocket.OPEN);
  const revokedCount = ea.received.length;
  const activeCount = eb.received.length;
  await f.rpc(b.headers, {
    method: "renameSession",
    sessionId: session.id,
    title: "still controlled",
  });
  await vi.waitFor(() =>
    expect(eb.received.length).toBeGreaterThan(activeCount),
  );
  expect(ea.received).toHaveLength(revokedCount);
  expect(
    (await f.rpc(a.headers, { method: "getSession", sessionId: session.id }))
      .status,
  ).toBe(401);
  expect(
    (await f.rpc(b.headers, { method: "getSession", sessionId: session.id }))
      .status,
  ).toBe(200);
  expect((await f.service.getSession(session.id)).status).toBe("running");
  await f.web.close();
  expect((await f.service.getSession(session.id)).status).toBe("running");
  expect(
    f.runtime.hostState().runs.some((item) => item.sessionId === session.id),
  ).toBe(true);
  const cancelled = await f.runtime.request({
    id: randomUUID(),
    method: "cancelRun",
    runId: run.result.runId,
    wait: true,
  });
  expect(cancelled.ok).toBe(true);
  expect((await f.service.getSession(session.id)).status).toBe("cancelled");
});

it("observes revocation from another local process and never restores a revoked grant after store reopen", async () => {
  const f = await fixture();
  const a = await f.pair();
  const e = await f.events(a);
  const other = await openDeviceAuthorization({ directory: f.state });
  cleanup.push(() => other.close());
  await other.revoke(a.device.id);
  expect((await f.http("/api/connect", {}, a.headers)).status).toBe(401);
  await vi.waitFor(() => expect(e.ws.readyState).toBe(WebSocket.CLOSED), {
    timeout: 2000,
  });
  await other.close();
  const reopened = await openDeviceAuthorization({ directory: f.state });
  cleanup.push(() => reopened.close());
  expect(await reopened.verify(a.credential)).toBeUndefined();
});

it("rechecks authorization after a workspace probe and does not execute a revoked mutation", async () => {
  const f = await fixture();
  const a = await f.pair();
  const session = await f.service.createSession({ workspace: f.directory });
  const entered = gate();
  const release = gate();
  const original = f.runtime.request.bind(f.runtime);
  const methods: string[] = [];
  vi.spyOn(f.runtime, "request").mockImplementation(async (input) => {
    methods.push(input.method);
    if (input.method === "getSession") {
      entered.release();
      await release.promise;
    }
    return original(input);
  });
  const pending = f.rpc(a.headers, {
    method: "renameSession",
    sessionId: session.id,
    title: "must not run",
  });
  try {
    await entered.promise;
    await f.authorization.revoke(a.device.id);
  } finally {
    release.release();
  }
  expect((await pending).status).toBe(401);
  expect(methods).not.toContain("renameSession");
  expect((await f.service.getSession(session.id)).title).not.toBe(
    "must not run",
  );
});

it("withholds a pending protected response when its device is revoked during core work", async () => {
  const f = await fixture();
  const a = await f.pair();
  const entered = gate();
  const release = gate();
  const original = f.runtime.request.bind(f.runtime);
  vi.spyOn(f.runtime, "request").mockImplementation(async (input) => {
    if (input.method === "getSettings") {
      entered.release();
      await release.promise;
    }
    return original(input);
  });
  const pending = f.rpc(a.headers, { method: "getSettings" });
  try {
    await entered.promise;
    await f.authorization.revoke(a.device.id);
  } finally {
    release.release();
  }
  const response = await pending;
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("baseUrl");
});

it("checks the authoritative grant again for event batches, not just the WS handshake", async () => {
  const f = await fixture();
  const a = await f.pair();
  const e = await f.events(a);
  const session = await f.service.createSession({ workspace: f.directory });
  const count = e.received.length;
  const check = vi
    .spyOn(f.authorization, "isAuthorized")
    .mockResolvedValue(false);
  await f.runtime.request({
    id: randomUUID(),
    method: "startRun",
    input: { sessionId: session.id, prompt: "fixture", permission: "readonly" },
  });
  // Faster than the one-second idle sweep: this must be the event-delivery gate.
  await vi.waitFor(() => expect(e.ws.readyState).toBe(WebSocket.CLOSED), {
    timeout: 500,
  });
  expect(check).toHaveBeenCalledWith(a.device.id);
  expect(e.received).toHaveLength(count);
});

it("refuses oversized pairing bodies and never accepts failed exchanges as authorization", async () => {
  const f = await fixture();
  const result = await f
    .http("/api/pair", { token: "x".repeat(2000) })
    .catch(() => undefined);
  if (result) expect(result.status).toBe(401);
  expect(await f.authorization.list()).toEqual([]);
  expect((await f.http("/api/connect", {})).status).toBe(401);
});

it("cannot finish an in-flight WS upgrade after its listener is stopped", async () => {
  const f = await fixture();
  const a = await f.pair();
  const entered = gate();
  const release = gate();
  const verify = f.authorization.verify.bind(f.authorization);
  vi.spyOn(f.authorization, "verify").mockImplementation(async (credential) => {
    entered.release();
    await release.promise;
    return verify(credential);
  });
  const ws = f.socket(a.headers, a.clientId);
  let opened = false;
  ws.once("open", () => {
    opened = true;
  });
  const rejected = new Promise<void>((done) => ws.once("error", () => done()));
  await entered.promise;
  const stopped = f.web.close();
  release.release();
  await rejected;
  await stopped;
  expect(opened).toBe(false);
});
