import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node fetch rewrites Host; use HTTP directly to exercise DNS-rebinding protection.
function fetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Response> {
  return new Promise((done, reject) => {
    const req = request(
      url,
      { method: init.method ?? "GET", headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
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
    req.end(init.body);
  });
}
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { createHarness } from "../src/core/harness";
import { type RunEvent, runEventSchema } from "../src/shared/ipc";
import { createWebHost } from "../src/web/server";
import { image } from "./fixtures/image";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
  vi.useRealTimers();
});

async function connectEvents(
  url: string,
  auth: Record<string, string>,
  cursor = 0,
) {
  const ws = new WebSocket(
    `${url.replace("http:", "ws:")}/api/events?clientId=${auth["X-Forge-Client"]}&cursor=${cursor}`,
    { headers: auth },
  );
  cleanup.push(async () => ws.terminate());
  const received: RunEvent[] = [];
  const cursors: number[] = [];
  await new Promise<void>((done, reject) => {
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const batch = z
        .object({ cursor: z.number(), events: z.array(runEventSchema) })
        .parse(JSON.parse(raw.toString()));
      received.push(...batch.events);
      cursors.push(batch.cursor);
      ws.send(JSON.stringify({ cursor: batch.cursor }));
      done();
    });
  });
  return { ws, received, cursors };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "forge-web-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const service = await createHarness({
    stateDir: join(directory, "state"),
    providerFactory: () => ({
      listModels: async () => ["test-model"],
      complete: async (messages, _tools, options) => {
        if (
          messages.some(
            (message) =>
              message.role === "user" && message.content === "write fixture",
          ) &&
          !messages.some((message) => message.role === "tool")
        ) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "fixture-command",
                  type: "function",
                  function: {
                    name: "run_command",
                    arguments: JSON.stringify({
                      argv: [process.execPath, "--version"],
                    }),
                  },
                },
                {
                  id: "fixture-write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      path: "web-fixture.txt",
                      content: "written through Web RPC",
                    }),
                  },
                },
              ],
            },
          };
        }
        options.onText("fixture response");
        if (
          messages.some(
            (message) => message.content === "wait for cancellation",
          )
        ) {
          await new Promise<void>((done) =>
            options.signal?.addEventListener("abort", () => done(), {
              once: true,
            }),
          );
        }
        return { message: { role: "assistant", content: "fixture response" } };
      },
    }),
  });
  await service.updateSettings({
    settings: { baseUrl: "http://localhost:1234/v1", model: "test-model" },
  });
  // Host is deliberately fixed; listen(0) below keeps tests independent of port availability.
  const web = await createWebHost({
    service,
    workspace: directory,
    host: "127.0.0.1",
    port: 5173,
  });
  web.server.on("request", (req, res) => {
    void web.handle(req, res, () => {
      res.end("vite content");
    });
  });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  cleanup.push(() => web.close());
  const address = web.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const headers = {
    Host: "127.0.0.1:5173",
    Origin: web.origin,
    "Content-Type": "application/json",
  };
  async function login() {
    const response = await fetch(`${url}/api/connect`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const data = await response.json();
    return {
      ...headers,
      "X-Forge-Client": data.clientId as string,
    };
  }
  return { web, directory, url, headers, login };
}

describe("Web development host", () => {
  it("accepts bounded image RPC above the old 1 MiB limit and persists it without changing summary lists", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    await connectEvents(url, auth);
    const rpc = async (data: object) => {
      const response = await fetch(`${url}/api/rpc`, { method: "POST", headers: auth, body: JSON.stringify({ id: randomUUID(), ...data }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const created = await rpc({ method: "createSession", input: { workspace: directory } });
    const bytes = Buffer.alloc(900000);
    Buffer.from(image.dataUrl.split(",")[1] ?? "", "base64").copy(bytes);
    const attachment = { name: "large.png", dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
    const started = await rpc({ method: "startRun", input: { sessionId: created.result.id, prompt: "", images: [attachment] } });
    expect(started.ok).toBe(true);
    await vi.waitFor(async () => {
      const saved = await rpc({ method: "getSession", sessionId: created.result.id });
      expect(saved.result.status).toBe("completed");
      expect(saved.result.messages).toContainEqual({ role: "user", content: "", images: [attachment] });
    });
    const listed = await rpc({ method: "listSessions" });
    expect(JSON.stringify(listed)).not.toContain("data:image/");
  });
  it("opens directly without a password or cookie while retaining host/origin and page checks", async () => {
    const { url, headers, login } = await setup();
    expect(await (await fetch(url, { headers })).text()).toBe("vite content");
    expect((await fetch(`${url}/main.tsx`, { headers })).status).toBe(200);
    expect(
      (await fetch(`${url}/api/rpc`, { method: "POST", headers, body: "{}" }))
        .status,
    ).toBe(410);
    expect((await fetch(url)).status).toBe(403);
    const auth = await login();
    expect((await fetch(`${url}/main.tsx`, { headers: auth })).status).toBe(
      200,
    );
    expect(
      (
        await fetch(`${url}/api/rpc`, {
          method: "POST",
          headers: { ...auth, Origin: "http://evil.invalid" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });

  it("uses real Harness CRUD, limits workspace and rejects duplicate effects", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    const stream = await connectEvents(url, auth);
    const rpc = async (data: object) =>
      fetch(`${url}/api/rpc`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(data),
      });
    const create = {
      id: randomUUID(),
      method: "createSession",
      input: { workspace: directory, title: "Web test", model: "test-model" },
    };
    const response = await rpc(create);
    expect(response.status).toBe(200);
    const session = await response.json();
    expect(session.ok).toBe(true);
    expect(session.result.workspace).toBe(directory);
    expect((await rpc(create)).status).toBe(409);
    expect(
      (
        await rpc({
          ...create,
          id: randomUUID(),
          input: { workspace: tmpdir() },
        })
      ).status,
    ).toBe(403);
    const list = await (
      await rpc({ id: randomUUID(), method: "listSessions" })
    ).json();
    expect(list.result).toHaveLength(1);
    expect(
      (await rpc({ id: randomUUID(), method: "chooseWorkspace" })).status,
    ).toBe(403);
    const started = await (
      await rpc({
        id: randomUUID(),
        method: "startRun",
        input: {
          sessionId: session.result.id,
          prompt: "fixture",
          permission: "readonly",
        },
      })
    ).json();
    expect(started.ok).toBe(true);
    await expect
      .poll(
        () =>
          stream.received.find((item) => item.event.type === "run_finished")
            ?.event,
      )
      .toMatchObject({ status: "completed" });
    expect(
      stream.received.some((item) => item.event.type === "text_delta"),
    ).toBe(true);
    expect(stream.cursors).toEqual(stream.cursors.map((_, index) => index));
  });

  it("writes a real workspace file through the shared runtime and Web event pipe", async () => {
    const { url, directory, login } = await setup();
    let auth = await login();
    let stream = await connectEvents(url, auth);
    const rpc = async (data: object) =>
      (
        await fetch(`${url}/api/rpc`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(data),
        })
      ).json();
    const session = await rpc({
      id: randomUUID(),
      method: "createSession",
      input: { workspace: directory, model: "test-model" },
    });
    const started = await rpc({
      id: randomUUID(),
      method: "startRun",
      input: {
        sessionId: session.result.id,
        prompt: "write fixture",
        permission: "workspace",
      },
    });
    expect(started.ok).toBe(true);
    await expect
      .poll(() =>
        stream.received.some(
          (item) => item.event.type === "approval_requested",
        ),
      )
      .toBe(true);
    const approval = stream.received.find(
      (item) => item.event.type === "approval_requested",
    )?.event;
    if (approval?.type !== "approval_requested")
      throw new Error("Missing approval");
    const handshake = await (await fetch(`${url}/api/connect`, {
      method: "POST", headers: auth, body: "{}",
    })).json();
    const recovery = z.array(runEventSchema).parse(handshake.recovery);
    expect(recovery.filter((item) => item.event.type === "approval_requested").map((item) => item.event)).toEqual([expect.objectContaining({ request: approval.request })]);
    auth = { ...auth, "X-Forge-Client": handshake.clientId };
    stream = await connectEvents(url, auth, handshake.cursor);
    await rpc({
      id: randomUUID(),
      method: "answerApproval",
      runId: started.result.runId,
      approvalId: approval.request.id,
      approved: true,
    });
    await expect
      .poll(
        () =>
          stream.received.find((item) => item.event.type === "run_finished")
            ?.event,
      )
      .toMatchObject({ status: "completed" });
    expect(
      stream.received.some((item) => item.event.type === "tool_started"),
    ).toBe(true);
    expect(
      stream.received.some((item) => item.event.type === "tool_finished"),
    ).toBe(true);
    expect(await readFile(join(directory, "web-fixture.txt"), "utf8")).toBe(
      "written through Web RPC",
    );
    const completed = await (await fetch(`${url}/api/connect`, {
      method: "POST", headers: auth, body: "{}",
    })).json();
    expect(completed.recovery).toEqual([]);
  });

  it("keeps authenticated pages independent and validates event cursors", async () => {
    const { url, login } = await setup();
    const oldAuth = await login();
    const oldStream = await connectEvents(url, oldAuth);
    const auth = await login();
    const poll = (headers: Record<string, string>, cursor: number) =>
      fetch(`${url}/api/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ cursor }),
      });
    expect((await poll(oldAuth, 0)).status).toBe(426);
    expect((await poll(auth, 0)).status).toBe(426);
    await expect(connectEvents(url, auth, -1)).rejects.toThrow();
    await expect(connectEvents(url, auth, 100)).rejects.toThrow();
    await expect(connectEvents(url, { ...auth, "X-Forge-Client": randomUUID() })).rejects.toThrow();
    const stream = await connectEvents(url, auth);
    expect(stream.cursors).toEqual([0]);
    expect(oldStream.ws.readyState).toBe(WebSocket.OPEN);
    const oldPage = await fetch(`${url}/api/rpc`, {
      method: "POST", headers: oldAuth,
      body: JSON.stringify({ id: randomUUID(), method: "getSettings" }),
    });
    expect(oldPage.status).toBe(200);
    expect((await oldPage.json()).ok).toBe(true);
    const replacement = await connectEvents(url, oldAuth);
    expect(replacement.cursors).toEqual([0]);
    expect(stream.ws.readyState).toBe(WebSocket.OPEN);
    await expect.poll(() => oldStream.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("replays a background page's missed events after another page acknowledges them", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    const background = await connectEvents(url, auth);
    const otherAuth = await login();
    const other = await connectEvents(url, otherAuth);
    const rpc = async (headers: Record<string, string>, input: object) => {
      const response = await fetch(`${url}/api/rpc`, {
        method: "POST", headers, body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.ok).toBe(true);
      return result;
    };
    const session = await rpc(auth, { id: randomUUID(), method: "createSession", input: { workspace: directory, model: "test-model" } });
    const run = await rpc(auth, { id: randomUUID(), method: "startRun", input: { sessionId: session.result.id, prompt: "wait for cancellation", permission: "readonly" } });
    for (const stream of [background, other]) {
      await expect.poll(() => stream.received.some(item => item.event.type === "text_delta")).toBe(true);
    }
    const cursor = background.cursors.at(-1);
    if (cursor === undefined) throw new Error("Missing background cursor");
    background.ws.terminate();
    await expect.poll(() => background.ws.readyState).toBe(WebSocket.CLOSED);
    await rpc(otherAuth, { id: randomUUID(), method: "cancelRun", runId: run.result.runId });
    await expect.poll(() => other.received.some(item => item.event.type === "run_finished")).toBe(true);
    const resumed = await connectEvents(url, auth, cursor);
    await expect.poll(() => resumed.received.some(item => item.event.type === "run_finished")).toBe(true);
    expect(resumed.received.some(item => item.event.type === "text_delta")).toBe(false);
    expect(other.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects unauthenticated and cross-origin WebSocket upgrades", async () => {
    const { url, headers, login } = await setup();
    await expect(connectEvents(url, headers)).rejects.toThrow();
    const auth = await login();
    await expect(
      connectEvents(url, { ...auth, Origin: "http://evil.invalid" }),
    ).rejects.toThrow();
    await expect(
      connectEvents(url, { ...auth, Host: "evil.invalid" }),
    ).rejects.toThrow();
  });

  it("closes invalid acknowledgements and preserves events queued while disconnected", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    const invalid = await connectEvents(url, auth);
    const closed = new Promise<number>((done) =>
      invalid.ws.once("close", (code) => done(code)),
    );
    invalid.ws.send(JSON.stringify({ cursor: 100 }));
    expect(await closed).toBe(1008);
    const stream = await connectEvents(url, auth);
    const rpc = async (data: object) =>
      (
        await fetch(`${url}/api/rpc`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(data),
        })
      ).json();
    const session = await rpc({
      id: randomUUID(),
      method: "createSession",
      input: { workspace: directory, model: "test-model" },
    });
    const run = await rpc({
      id: randomUUID(),
      method: "startRun",
      input: {
        sessionId: session.result.id,
        prompt: "wait for cancellation",
        permission: "readonly",
      },
    });
    await expect
      .poll(() =>
        stream.received.some((item) => item.event.type === "text_delta"),
      )
      .toBe(true);
    const cursor = stream.cursors.at(-1);
    if (cursor === undefined) throw new Error("Missing event cursor");
    stream.ws.terminate();
    await expect.poll(() => stream.ws.readyState).toBe(WebSocket.CLOSED);
    await rpc({
      id: randomUUID(),
      method: "cancelRun",
      runId: run.result.runId,
    });
    const resumed = await connectEvents(url, auth, cursor);
    await expect
      .poll(() =>
        resumed.received.some((item) => item.event.type === "run_finished"),
      )
      .toBe(true);
    expect(
      resumed.received.some((item) => item.event.type === "text_delta"),
    ).toBe(false);
  });

  it("keeps disconnected runs alive beyond the heartbeat timeout and restores control after refresh", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    const rpc = async (data: object) =>
      fetch(`${url}/api/rpc`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(data),
      });
    const session = await (
      await rpc({
        id: randomUUID(),
        method: "createSession",
        input: { workspace: directory, model: "test-model" },
      })
    ).json();
    const start = () =>
      rpc({
        id: randomUUID(),
        method: "startRun",
        input: {
          sessionId: session.result.id,
          prompt: "wait for cancellation",
          permission: "readonly",
        },
      });
    expect((await start()).status).toBe(409);
    const stream = await connectEvents(url, auth);
    const started = await (await start()).json();
    expect(started.ok).toBe(true);
    await expect
      .poll(() =>
        stream.received.some((item) => item.event.type === "text_delta"),
      )
      .toBe(true);
    stream.ws.terminate();
    await expect.poll(() => stream.ws.readyState).toBe(WebSocket.CLOSED);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 21_000);
    await expect
      .poll(
        async () => {
          const snapshot = await (
            await rpc({
              id: randomUUID(),
              method: "getSession",
              sessionId: session.result.id,
            })
          ).json();
          return snapshot.result.status;
        },
        { timeout: 3000 },
      )
      .toBe("running");
    await new Promise((done) => setTimeout(done, 1200));
    const handshake = await (await fetch(`${url}/api/connect`, {
      method: "POST", headers: auth, body: "{}",
    })).json();
    const recovery = z.array(runEventSchema).parse(handshake.recovery);
    expect(recovery.some((item) => item.runId === started.result.runId && item.event.type === "run_started")).toBe(true);
    expect(recovery.some((item) => item.event.type === "text_delta" && item.event.text === "fixture response")).toBe(true);
    const nextAuth = { ...auth, "X-Forge-Client": handshake.clientId };
    const resumed = await connectEvents(url, nextAuth, handshake.cursor);
    expect((await rpc({ id: randomUUID(), method: "getSettings" })).status).toBe(200);
    const cancelled = await fetch(`${url}/api/rpc`, {
      method: "POST", headers: nextAuth,
      body: JSON.stringify({ id: randomUUID(), method: "cancelRun", runId: started.result.runId }),
    });
    expect((await cancelled.json()).ok).toBe(true);
    await expect.poll(() => resumed.received.find((item) => item.event.type === "run_finished")?.event).toMatchObject({ status: "cancelled" });
  });

  it("serves sandboxed HTML previews for inline code and workspace files only", async () => {
    const { url, directory, login } = await setup();
    const auth = await login();
    await connectEvents(url, auth);
    const post = async (path: string, body: object, headers = auth) =>
      fetch(`${url}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const markup = "<h1 id=t>preview</h1><script>document.title='ran'</script>";
    const inline = await post("/api/preview", { html: markup });
    expect(inline.status).toBe(200);
    const inlineUrl = (await inline.json()).url as string;
    expect(inlineUrl).toMatch(/^\/preview\/document\?id=[0-9a-f]{48}$/);

    // The preview document is its own response: a strict CSP plus a frame
    // allowance that the workbench itself never grants.
    const document = await fetch(`${url}${inlineUrl}`, { headers: auth });
    expect(document.status).toBe(200);
    expect(document.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(document.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(document.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(document.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(document.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await document.text()).toBe(markup);

    // Preview documents also work without a login cookie or page connection id.
    expect((await fetch(`${url}${inlineUrl}`, { headers: { Host: auth.Host } })).status).toBe(200);
    expect((await fetch(`${url}/preview/document?id=${"0".repeat(48)}`, { headers: auth })).status).toBe(404);
    expect((await post("/api/preview", { html: "x" }, { ...auth, Origin: "http://evil.invalid" })).status).toBe(403);

    // A workspace HTML file is read through the path guard, never from outside it.
    await writeFile(join(directory, "page.html"), "<p id=file>from disk</p>");
    await writeFile(join(directory, "notes.txt"), "not html");
    const file = await post("/api/preview/file", { path: "page.html" });
    expect(file.status).toBe(200);
    const fileUrl = (await file.json()).url as string;
    expect(await (await fetch(`${url}${fileUrl}`, { headers: auth })).text()).toBe(
      "<p id=file>from disk</p>",
    );
    for (const path of ["notes.txt", "../outside.html", ".env.html", ".git/x.html"])
      expect((await post("/api/preview/file", { path })).status).toBeGreaterThanOrEqual(403);
  });
});
