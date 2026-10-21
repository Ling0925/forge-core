import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeHub } from "../src/host/runtime";
import type { HarnessService } from "../src/shared/contracts";
import type { AgentEvent, SessionSnapshot } from "../src/shared/schemas";
import { sessionSnapshotSchema } from "../src/shared/schemas";
import { createWebHost } from "../src/web/server";

const sessionId = "22222222-2222-4222-8222-222222222222";
const otherSessionId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-01-01T00:00:00.000Z";
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
});

function post(
  url: string,
  headers: Record<string, string>,
  input: unknown,
): Promise<Response> {
  return new Promise((done, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
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
    });
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
}

function snapshot(id: string, workspace: string): SessionSnapshot {
  const event = (value: Record<string, unknown>): AgentEvent =>
    ({
      sessionId: id,
      timestamp,
      ...value,
    }) as AgentEvent;
  return sessionSnapshotSchema.parse({
    version: 1,
    id,
    title: "Web paging fixture",
    workspace,
    model: "test-model",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    messages: [
      { role: "user", content: "OLD_SECRET_PROMPT" },
      { role: "assistant", content: "OLD_SECRET_REPLY" },
      { role: "user", content: "new prompt" },
      { role: "assistant", content: "new reply" },
    ],
    events: [
      event({
        type: "run_started",
        turn: 1,
        messageIndex: 0,
        model: "test-model",
        permission: "unrestricted",
      }),
      event({
        type: "tool_started",
        turn: 1,
        call: {
          id: "old-call",
          type: "function",
          function: { name: "write_file", arguments: "{}" },
        },
      }),
      event({
        type: "tool_finished",
        turn: 1,
        toolCallId: "old-call",
        result: { content: "OLD_SECRET_TOOL", isError: false },
      }),
      event({
        type: "run_finished",
        turn: 1,
        status: "completed",
        turns: 1,
        toolCalls: 1,
      }),
      event({
        type: "run_started",
        turn: 2,
        messageIndex: 2,
        model: "test-model",
        permission: "unrestricted",
      }),
      event({
        type: "run_finished",
        turn: 2,
        status: "completed",
        turns: 1,
        toolCalls: 0,
      }),
    ],
    changes: [{ path: "old.txt", kind: "created" }],
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-web-page-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = await realpath(directory);
  const current = snapshot(sessionId, workspace);
  const foreign = snapshot(otherSessionId, "/tmp/another-workspace");
  let reads = 0;
  const service = {
    async getSession(id: string) {
      reads += 1;
      return id === otherSessionId ? foreign : current;
    },
    async dispose() {},
  } as unknown as HarnessService;
  const runtime = createRuntimeHub(service);
  cleanup.push(() => runtime.dispose());
  const web = await createWebHost({
    runtime,
    workspace,
    host: "127.0.0.1",
    port: 5173,
  });
  cleanup.push(() => web.dispose());
  web.server.on("request", (req, res) => {
    void web.handle(req, res, () => res.end("dev source"));
  });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  const port = (web.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Host: "127.0.0.1:5173",
    Origin: web.origin,
    "Content-Type": "application/json",
  };
  const connected = await post(`${base}/api/connect`, headers, {});
  expect(connected.status).toBe(200);
  const page = await connected.json();
  const auth = { ...headers, "X-Forge-Client": page.clientId as string };
  const rpc = (input: Record<string, unknown>) =>
    post(`${base}/api/rpc`, auth, {
      id: crypto.randomUUID(),
      method: "getSessionPage",
      ...input,
    });
  return { rpc, reads: () => reads };
}

describe("Web getSessionPage", () => {
  it("returns only the latest page in the response and reuses the authorized snapshot", async () => {
    const f = await fixture();
    const response = await f.rpc({ sessionId });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      method: "getSessionPage",
      result: {
        page: {
          messageOffset: 2,
          messageEnd: 4,
          totalMessages: 4,
          firstTurn: 2,
          hasMore: true,
        },
      },
    });
    expect(
      body.result.snapshot.messages.map(
        (message: { content: string }) => message.content,
      ),
    ).toEqual(["new prompt", "new reply"]);
    expect(body.result.snapshot.changes).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("OLD_SECRET");
    // One authorized snapshot read: pagination must not fetch the full session again.
    expect(f.reads()).toBe(1);
  });

  it("keeps the workspace guard for paged reads", async () => {
    const f = await fixture();
    const response = await f.rpc({ sessionId: otherSessionId });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/another workspace/i);
    expect(body.result).toBeUndefined();
  });

  it("rejects a non-boundary cursor without falling back to the full transcript", async () => {
    const f = await fixture();
    const response = await f.rpc({ sessionId, page: { from: 1 } });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.result).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("OLD_SECRET");
  });
});
