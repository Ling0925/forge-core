import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerController } from "../../src/host/controller";
import { MAX_RESPONSE_BYTES, sendFrame } from "../../src/host/frames";
import { createRuntimeHub } from "../../src/host/runtime";
import { createTransportBridge } from "../../src/shared/bridge";
import type { HarnessService } from "../../src/shared/contracts";
import {
  type RpcRequest,
  type RpcResponse,
  rpcRequestSchema,
  rpcResponseSchema,
  workerMessageSchema,
  workerRequestSchema,
} from "../../src/shared/ipc";
import {
  type BrowserRequest,
  type BrowserResponse,
  type PluginRecord,
  browserResponseSchema,
  pluginRecordSchema,
} from "../../src/shared/plugins";
import {
  type AgentEvent,
  type SessionSnapshot,
  parseSessionId,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import { createWebHost } from "../../src/web/server";

const sessionId = parseSessionId("22222222-2222-4222-8222-222222222222");
const otherSessionId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-01-01T00:00:00.000Z";
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
  vi.useRealTimers();
});

const pluginRecord: PluginRecord = pluginRecordSchema.parse({
  manifest: {
    // The official plugin id is "browser"; "agent-browser" is only its executable.
    id: "browser",
    name: "Browser",
    version: "1.0.0",
    apiVersion: 1,
    description: "Fixture plugin",
    builtin: true,
    capabilities: ["browser"],
    configSchema: {},
  },
  enabled: true,
  config: { executablePath: "agent-browser" },
  status: "configured",
  activeSessions: 0,
});

const browserStatus: BrowserRequest = { sessionId, action: "status" };

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
    title: "Plugin RPC fixture",
    workspace,
    model: "test-model",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    messages: [],
    events: [
      event({
        type: "run_finished",
        turn: 1,
        status: "completed",
        turns: 0,
        toolCalls: 0,
      }),
    ],
    changes: [],
  });
}

function responseTo(raw: unknown): RpcResponse {
  const message = workerMessageSchema.parse(raw);
  if (message.kind !== "response") throw new Error("Expected a response.");
  return message.response;
}

describe("plugin RPC schemas", () => {
  it("rejects unknown methods, foreign fields and invalid plugin payloads", () => {
    const id = randomUUID();
    for (const raw of [
      { id, method: "listPlugins", extra: true },
      { id, method: "checkPlugin", pluginId: "Browser" },
      { id, method: "checkPlugin", pluginId: "browser", sessionId },
      { id, method: "configurePlugin", input: { pluginId: "browser" } },
      {
        id,
        method: "configurePlugin",
        input: { pluginId: "browser", unknown: true },
      },
      { id, method: "configurePlugin" },
      { id, method: "browser" },
      { id, method: "browser", sessionId, input: browserStatus },
      { id, method: "browser", input: { sessionId, action: "takeover" } },
      {
        id,
        method: "browser",
        input: { sessionId: "not-a-session", action: "status" },
      },
      {
        id,
        method: "browser",
        input: {
          sessionId,
          action: "execute",
          command: {
            action: "fill",
            selector: "#a",
            text: "x",
            url: "http://a",
          },
        },
      },
      {
        id,
        method: "browser",
        input: {
          sessionId,
          action: "execute",
          command: { action: "navigate", url: "file:///etc/passwd" },
        },
      },
    ])
      expect(rpcRequestSchema.safeParse(raw).success, JSON.stringify(raw)).toBe(
        false,
      );
  });

  it("accepts the single declared session location and bounded browser results", () => {
    expect(
      rpcRequestSchema.safeParse({
        id: randomUUID(),
        method: "browser",
        input: browserStatus,
      }).success,
    ).toBe(true);
    expect(
      rpcRequestSchema.safeParse({
        id: randomUUID(),
        method: "configurePlugin",
        input: {
          pluginId: "browser",
          enabled: true,
          config: { allowedDomains: ["example.com"] },
        },
      }).success,
    ).toBe(true);
    const base = {
      ok: true as const,
      method: "browser" as const,
      id: randomUUID(),
    };
    const image = (data: string, mimeType = "image/png") => ({
      sessionId,
      available: true,
      takeover: false,
      result: { text: "", isError: false, image: { mimeType, data } },
    });
    expect(
      rpcResponseSchema.safeParse({
        ...base,
        result: image("A".repeat(700_000)),
      }).success,
    ).toBe(true);
    expect(
      rpcResponseSchema.safeParse({
        ...base,
        result: image("A".repeat(700_001)),
      }).success,
    ).toBe(false);
    expect(
      rpcResponseSchema.safeParse({ ...base, result: image("A", "image/gif") })
        .success,
    ).toBe(false);
  });

  it("fits the maximum screenshot inside existing transport frames without widening them", () => {
    const response = {
      id: randomUUID(),
      ok: true as const,
      method: "browser" as const,
      result: {
        sessionId,
        available: true,
        takeover: true,
        result: {
          text: "",
          isError: false,
          image: { mimeType: "image/png" as const, data: "A".repeat(700_000) },
        },
      },
    };
    const message = workerMessageSchema.parse({ kind: "response", response });
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(
      MAX_RESPONSE_BYTES,
    );
    const write = vi.fn();
    const socket = {
      destroyed: false,
      writableLength: 0,
      write,
      destroy: vi.fn(),
    } as unknown as Parameters<typeof sendFrame>[0];
    // The existing per-frame bound already carries the bounded screenshot.
    expect(sendFrame(socket, message)).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    // Web RPC keeps its existing 16 MiB body limit; only the response carries
    // the image, and list/status stays metadata-only.
    expect(MAX_RESPONSE_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it("does not make plugin RPC desktop-only or model-tool only", () => {
    for (const method of ["listPlugins", "browser"] as const) {
      expect(
        workerRequestSchema.safeParse({
          id: randomUUID(),
          method,
          ...(method === "browser" ? { input: browserStatus } : {}),
        }).success,
      ).toBe(true);
    }
  });

  it("accepts plugin error responses without falling back to an unmatchable method", () => {
    for (const method of [
      "listPlugins",
      "configurePlugin",
      "checkPlugin",
      "browser",
    ] as const) {
      const error = {
        id: randomUUID(),
        ok: false as const,
        method,
        error: {
          code: "not_found" as const,
          message: "Plugins are unavailable on this host.",
          retryable: false,
        },
      };
      expect(rpcResponseSchema.safeParse(error).success, method).toBe(true);
      expect(
        workerMessageSchema.parse({ kind: "response", response: error }),
      ).toMatchObject({ kind: "response", response: { method } });
    }
  });
});

describe("plugin bridge dispatch", () => {
  it("maps each public bridge method to one RPC and returns the parsed result", async () => {
    const sent: RpcRequest[] = [];
    const results: Record<string, unknown> = {
      listPlugins: [pluginRecord],
      configurePlugin: pluginRecord,
      checkPlugin: { pluginId: "browser", status: "ready", message: "ok" },
      browser: browserResponseSchema.parse({
        sessionId,
        available: true,
        takeover: false,
      }),
    };
    const bridge = createTransportBridge({
      onEvent: () => {},
      request: async (request) => {
        sent.push(request);
        return {
          id: request.id,
          ok: true,
          method: request.method,
          result: results[request.method],
        };
      },
    });
    expect(await bridge.listPlugins()).toEqual([pluginRecord]);
    expect(
      await bridge.configurePlugin({ pluginId: "browser", enabled: false }),
    ).toEqual(pluginRecord);
    expect(await bridge.checkPlugin("browser")).toEqual({
      pluginId: "browser",
      status: "ready",
      message: "ok",
    });
    expect(await bridge.browser(browserStatus)).toEqual({
      sessionId,
      available: true,
      takeover: false,
    });
    expect(sent.map((request) => request.method)).toEqual([
      "listPlugins",
      "configurePlugin",
      "checkPlugin",
      "browser",
    ]);
    expect(sent[1]).toMatchObject({
      input: { pluginId: "browser", enabled: false },
    });
    expect(sent[2]).toMatchObject({ pluginId: "browser" });
    expect(sent[3]).toMatchObject({ input: browserStatus });
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(["id", "method"]);
  });

  it("surfaces host errors and rejects a schema-invalid browser result", async () => {
    const bridge = createTransportBridge({
      onEvent: () => {},
      request: async (request) => ({
        id: request.id,
        ok: true,
        method: request.method,
        // An oversized screenshot must fail in the shared response schema.
        result: {
          sessionId,
          available: true,
          takeover: false,
          result: {
            text: "",
            isError: false,
            image: { mimeType: "image/png", data: "A".repeat(700_001) },
          },
        },
      }),
    });
    await expect(bridge.browser(browserStatus)).rejects.toThrow(
      "Invalid host response for browser: schema_mismatch.",
    );
  });
});

describe("plugin host controller routing", () => {
  const request = (method: string, fields: object = {}): RpcRequest =>
    rpcRequestSchema.parse({ id: randomUUID(), method, ...fields });

  it("answers an unavailable plugin host with a not_found error instead of falling through", async () => {
    const service = {
      getSession: async (id: string) => snapshot(id, "/tmp"),
      dispose: async () => {},
    } as unknown as HarnessService;
    const messages: unknown[] = [];
    const controller = createWorkerController(service, (message) =>
      messages.push(message),
    );
    for (const rpc of [
      request("listPlugins"),
      request("configurePlugin", {
        input: { pluginId: "browser", enabled: true },
      }),
      request("checkPlugin", { pluginId: "browser" }),
      request("browser", { input: browserStatus }),
    ]) {
      await controller.handle(rpc);
      expect(responseTo(messages.at(-1))).toMatchObject({
        ok: false,
        method: rpc.method,
        error: { code: "not_found" },
      });
    }
  });

  it("dispatches plugin and browser routes with schema-valid results", async () => {
    const configurePlugin = vi.fn(
      async (
        input: Parameters<NonNullable<HarnessService["configurePlugin"]>>[0],
      ) => ({ ...pluginRecord, enabled: input.enabled ?? true }),
    );
    const checkPlugin = vi.fn(async () => ({
      pluginId: "browser",
      status: "ready" as const,
      message: "ok",
    }));
    const browser = vi.fn(
      async (): Promise<BrowserResponse> =>
        browserResponseSchema.parse({
          sessionId,
          available: false,
          takeover: false,
        }),
    );
    const service = {
      listPlugins: vi.fn(async () => [pluginRecord]),
      configurePlugin,
      checkPlugin,
      browser,
      getSession: async (id: string) => snapshot(id, "/tmp"),
      dispose: async () => {},
    } as unknown as HarnessService;
    const messages: unknown[] = [];
    const controller = createWorkerController(service, (message) =>
      messages.push(message),
    );
    const cases = [
      request("listPlugins"),
      request("configurePlugin", {
        input: { pluginId: "browser", enabled: true },
      }),
      request("checkPlugin", { pluginId: "browser" }),
      request("browser", { input: browserStatus }),
    ];
    for (const rpc of cases) {
      await controller.handle(rpc);
      const response = responseTo(messages.at(-1));
      expect(response).toMatchObject({ ok: true, method: rpc.method });
      expect(rpcResponseSchema.safeParse(response).success).toBe(true);
    }
    expect(configurePlugin).toHaveBeenCalledWith({
      pluginId: "browser",
      enabled: true,
    });
    expect(checkPlugin).toHaveBeenCalledWith("browser");
    expect(browser).toHaveBeenCalledWith(browserStatus);
  });
});

describe("Web browser RPC session authorization", () => {
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "forge-plugin-rpc-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const workspace = await realpath(directory);
    const current = snapshot(sessionId, workspace);
    const foreign = snapshot(otherSessionId, "/tmp/another-workspace");
    const browser = vi.fn(
      async (input: BrowserRequest): Promise<BrowserResponse> =>
        browserResponseSchema.parse({
          sessionId: input.sessionId,
          available: true,
          takeover: false,
        }),
    );
    const service = {
      getSession: async (id: string) => {
        if (id === otherSessionId) return foreign;
        if (id === sessionId) return current;
        throw new Error("Unknown session");
      },
      browser,
      dispose: async () => {},
    } as unknown as HarnessService;
    const runtime = createRuntimeHub(service);
    cleanup.push(() => runtime.dispose());
    const web = await createWebHost({
      runtime,
      workspace,
      host: "127.0.0.1",
      port: 5173,
      restrictWorkspace: true,
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
    const post = (
      path: string,
      input: unknown,
      extra: Record<string, string> = {},
    ) =>
      new Promise<{
        status: number;
        body: Record<string, unknown>;
      }>((done, reject) => {
        const req = httpRequest(
          `${base}${path}`,
          {
            method: "POST",
            headers: { ...headers, ...extra },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              done({
                status: res.statusCode ?? 500,
                body: text ? JSON.parse(text) : undefined,
              });
            });
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(input));
      });
    const connected = await post("/api/connect", {});
    expect(connected.status).toBe(200);
    const auth = { "X-Forge-Client": connected.body.clientId as string };
    const rpc = (fields: Record<string, unknown>) =>
      post("/api/rpc", { id: randomUUID(), ...fields }, auth);
    return { rpc, browser };
  }

  it("authorizes the nested browser input session before any effect", async () => {
    const f = await fixture();
    const foreign = await f.rpc({
      method: "browser",
      input: { sessionId: otherSessionId, action: "status" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.result).toBeUndefined();
    expect(f.browser).not.toHaveBeenCalled();

    const unknown = await f.rpc({
      method: "browser",
      input: {
        sessionId: "44444444-4444-4444-8444-444444444444",
        action: "takeover",
        enabled: true,
      },
    });
    expect(unknown.status).toBe(403);
    expect(f.browser).not.toHaveBeenCalled();

    const accepted = await f.rpc({
      method: "browser",
      input: { sessionId, action: "status" },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      ok: true,
      method: "browser",
      result: { sessionId, available: true },
    });
    expect(f.browser).toHaveBeenCalledWith({ sessionId, action: "status" });
  });

  it("does not accept a top-level sessionId as a substitute for the request input", async () => {
    const f = await fixture();
    const response = await f.rpc({
      method: "browser",
      sessionId,
      input: { sessionId: otherSessionId, action: "status" },
    });
    expect(response.status).toBe(400);
    expect(f.browser).not.toHaveBeenCalled();
  });
});
