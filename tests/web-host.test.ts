import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "node:http";

// Node fetch rewrites Host; use HTTP directly to exercise DNS-rebinding protection.
function fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((done, reject) => {
    const req = request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: res.headers as Record<string, string> })));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "../src/core/harness";
import { createWebHost } from "../src/web/server";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "forge-web-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const service = await createHarness({
    stateDir: join(directory, "state"),
    providerFactory: () => ({
      listModels: async () => ["test-model"],
      complete: async (messages, _tools, options) => {
        if (messages.some((message) => message.role === "user" && message.content === "write fixture") && !messages.some((message) => message.role === "tool")) {
          return { message: { role: "assistant", content: null, tool_calls: [{ id: "fixture-write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "web-fixture.txt", content: "written through Web RPC" }) } }] } };
        }
        options.onText("fixture response");
        return { message: { role: "assistant", content: "fixture response" } };
      },
    }),
  });
  await service.updateSettings({ settings: { baseUrl: "http://localhost:1234/v1", model: "test-model" } });
  // Host is deliberately fixed; listen(0) below keeps tests independent of port availability.
  const web = await createWebHost({ service, workspace: directory, host: "127.0.0.1", port: 5173, token: "test-passphrase" });
  web.server.on("request", (req, res) => { void web.handle(req, res, () => { res.end("vite content"); }); });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  cleanup.push(() => web.close());
  const address = web.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Host: "127.0.0.1:5173", Origin: web.origin, "Content-Type": "application/json" };
  async function login() {
    const response = await fetch(`${url}/api/connect`, { method: "POST", headers: { ...headers, Authorization: "Bearer test-passphrase" }, body: "{}" });
    expect(response.status).toBe(200);
    const data = await response.json();
    return { ...headers, Cookie: response.headers.get("set-cookie")!.split(";")[0]!, "X-Forge-Client": data.clientId as string };
  }
  return { web, directory, url, headers, login };
}

describe("Web development host", () => {
  it("protects source, API and exact host/origin; sets an HttpOnly cookie", async () => {
    const { url, headers, login } = await setup();
    expect((await fetch(url, { headers })).status).toBe(200);
    expect((await fetch(`${url}/main.tsx`, { headers })).status).toBe(401);
    expect((await fetch(`${url}/api/rpc`, { method: "POST", headers, body: "{}" })).status).toBe(401);
    expect((await fetch(url)).status).toBe(403);
    const auth = await login();
    expect((await fetch(`${url}/main.tsx`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${url}/api/rpc`, { method: "POST", headers: { ...auth, Origin: "http://evil.invalid" }, body: "{}" })).status).toBe(403);
  });

  it("uses real Harness CRUD, limits workspace and rejects duplicate effects", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    const rpc = async (data: object) => fetch(`${url}/api/rpc`, { method: "POST", headers: auth, body: JSON.stringify(data) });
    const create = { id: randomUUID(), method: "createSession", input: { workspace: directory, title: "Web test", model: "test-model" } };
    const response = await rpc(create);
    expect(response.status).toBe(200);
    const session = await response.json();
    expect(session.ok).toBe(true);
    expect(session.result.workspace).toBe(directory);
    expect((await rpc(create)).status).toBe(409);
    expect((await rpc({ ...create, id: randomUUID(), input: { workspace: tmpdir() } })).status).toBe(403);
    const list = await (await rpc({ id: randomUUID(), method: "listSessions" })).json();
    expect(list.result).toHaveLength(1);
    expect((await rpc({ id: randomUUID(), method: "chooseWorkspace" })).status).toBe(403);
    const started = await (await rpc({ id: randomUUID(), method: "startRun", input: { sessionId: session.result.id, prompt: "fixture", permission: "readonly" } })).json();
    expect(started.ok).toBe(true);
    const received: { event: { type: string; status?: string } }[] = [];
    let cursor = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const batch = await (await fetch(`${url}/api/events`, { method: "POST", headers: auth, body: JSON.stringify({ cursor }) })).json();
      received.push(...batch.events);
      cursor = batch.cursor;
      if (received.some((item) => item.event.type === "run_finished")) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(received.some((item) => item.event.type === "text_delta")).toBe(true);
    expect(received.find((item) => item.event.type === "run_finished")?.event.status).toBe("completed");
  });

  it("writes a real workspace file through the shared runtime and Web event pipe", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    const rpc = async (data: object) => (await fetch(`${url}/api/rpc`, { method: "POST", headers: auth, body: JSON.stringify(data) })).json();
    const session = await rpc({ id: randomUUID(), method: "createSession", input: { workspace: directory, model: "test-model" } });
    const started = await rpc({ id: randomUUID(), method: "startRun", input: { sessionId: session.result.id, prompt: "write fixture", permission: "workspace" } });
    expect(started.ok).toBe(true);
    let cursor = 0;
    let finished = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const batch = await (await fetch(`${url}/api/events`, { method: "POST", headers: auth, body: JSON.stringify({ cursor }) })).json();
      cursor = batch.cursor;
      for (const { event } of batch.events) {
        if (event.type === "approval_requested") await rpc({ id: randomUUID(), method: "answerApproval", runId: started.result.runId, approvalId: event.request.id, approved: true });
        if (event.type === "run_finished") { expect(event.status).toBe("completed"); finished = true; }
      }
      if (finished) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(finished).toBe(true);
    expect(await readFile(join(directory, "web-fixture.txt"), "utf8")).toBe("written through Web RPC");
  });

  it("gives a new page control and validates event cursors", async () => {
    const { url, login } = await setup();
    const oldAuth = await login();
    const auth = await login();
    const poll = (headers: Record<string, string>, cursor: number) => fetch(`${url}/api/events`, { method: "POST", headers, body: JSON.stringify({ cursor }) });
    expect((await poll(oldAuth, 0)).status).toBe(409);
    expect((await poll(auth, -1)).status).toBe(400);
    expect(await (await poll(auth, 0)).json()).toEqual({ cursor: 0, events: [] });
  });
});
