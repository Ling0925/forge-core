#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { WebSocket } from "ws";

// The measured modules are internal, so bundle them from src for this run.
const home = await mkdtemp(join(tmpdir(), "forge-events-"));
const root = fileURLToPath(new URL("..", import.meta.url));
// Inside the repo so bare package imports resolve from node_modules.
const bundle = join(root, "node_modules/.cache/forge-bench-events.mjs");
await build({
  stdin: {
    contents: `
      export { createRunEvents } from "./src/core/runtime-events";
      export { createRunState } from "./src/core/runtime-state";
      export { MAX_RESPONSE_BYTES, readFrames, sendFrame } from "./src/host/frames";
      export { createLocalHost } from "./src/host/local-server";
      export { createRuntimeHub } from "./src/host/runtime";
      export { createWebHost } from "./src/web/server";
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  outfile: bundle,
  logLevel: "silent",
});
const {
  createRunEvents,
  createRunState,
  MAX_RESPONSE_BYTES,
  readFrames,
  sendFrame,
  createLocalHost,
  createRuntimeHub,
  createWebHost,
} = await import(pathToFileURL(bundle).href);

const count = Number(process.argv[2] ?? 100000);
process.env.FORGE_HOME = home;
const sessionId = randomUUID();
const timestamp = new Date().toISOString();
let events;
const runtime = createRuntimeHub({
  async run(_input, sink, _approve, signal) {
    events = createRunEvents(
      createRunState(),
      sessionId,
      sink,
      () => timestamp,
    );
    await new Promise((done) =>
      signal.addEventListener("abort", done, { once: true }),
    );
  },
  async dispose() {},
});
let web;
let local;
let socket;
let ws;
try {
  web = await createWebHost({
    runtime,
    workspace: home,
    host: "127.0.0.1",
    port: 0,
  });
  web.server.on(
    "request",
    (request, response) =>
      void web.handle(request, response, () => response.end()),
  );
  await new Promise((done) => web.server.listen(0, "127.0.0.1", done));
  const address = web.server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const headers = {
    host: "127.0.0.1:0",
    origin: web.origin,
    "content-type": "application/json",
  };
  const connected = await new Promise((done, reject) => {
    const req = request(
      `${url}/api/connect`,
      { method: "POST", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => done(JSON.parse(body)));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  ws = new WebSocket(
    `${url.replace("http:", "ws:")}/api/events?clientId=${connected.clientId}&cursor=0`,
    { headers },
  );
  let webReceived = 0;
  ws.on("message", (data) => {
    webReceived += JSON.parse(data.toString()).events.length;
  });
  await once(ws, "open");
  local = await createLocalHost({
    runtime,
    socketPath: join(home, "host.sock"),
  });
  socket = createConnection(local.path);
  let localReceived = 0;
  let hello;
  const ready = new Promise((done) => {
    hello = done;
  });
  readFrames(
    socket,
    MAX_RESPONSE_BYTES,
    (message) => {
      if (message.kind === "hello") hello();
      if (message.kind === "event") localReceived++;
    },
    (error) => {
      throw error;
    },
  );
  sendFrame(socket, { kind: "hello", protocolVersion: 1 });
  await ready;
  await runtime.request({
    id: randomUUID(),
    method: "startRun",
    input: { sessionId, prompt: "benchmark" },
  });
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    events.ephemeral({ type: "text_delta", text: "x" });
    // Drain both real sockets without excluding transport work from the measurement.
    await new Promise((done) => setImmediate(done));
  }
  while (webReceived < count || localReceived < count)
    await new Promise((done) => setImmediate(done));
  const usage = process.cpuUsage(cpu);
  console.log(
    JSON.stringify({
      count,
      webReceived,
      localReceived,
      cpuMs: (usage.user + usage.system) / 1000,
      wallMs: performance.now() - start,
    }),
  );
} finally {
  socket?.destroy();
  ws?.terminate();
  await Promise.all([web?.close(), local?.close()]);
  await runtime.dispose();
  await rm(home, { recursive: true, force: true });
}
