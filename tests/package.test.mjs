import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Core declares no application dependency and builds only its own sources", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const metadata = JSON.parse(await readFile(new URL("../dist/build-meta.json", import.meta.url), "utf8"));
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.devDependencies })) {
    assert(!/^(react(?:-.*)?|ink|electron(?:-.*)?|@forge\/(cli|web-ui))$/.test(dependency), dependency);
  }
  for (const path of Object.keys(metadata.inputs)) {
    assert(path.startsWith("src/"), path);
    assert(!/^src\/(cli|renderer|desktop)\//.test(path), path);
  }
});

test("production sources and artifacts no longer expose the legacy Playwright browser", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const metadata = JSON.parse(await readFile(new URL("../dist/build-meta.json", import.meta.url), "utf8"));
  assert(!("playwright" in pkg.dependencies));
  assert(!("playwright" in pkg.optionalDependencies));
  assert(!("src/tools/browser.ts" in metadata.inputs));
  for (const output of Object.values(metadata.outputs))
    for (const dependency of output.imports)
      assert(!/^playwright(?:-core)?(?:\/|$)/.test(dependency.path), dependency.path);
  await assert.rejects(readFile(new URL("../dist/tools/browser.js", import.meta.url)), { code: "ENOENT" });
});

test("built shared subpaths bundle for browsers without the runtime", async () => {
  const result = await build({
    stdin: { contents: 'export * from "@forge/core/shared/ipc"; export * from "@forge/core/shared/bridge"; export * from "@forge/core/shared/harness-adaptation";', resolveDir: root },
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, logLevel: "silent",
  });
  const text = result.outputFiles.map(file => file.text).join("\n");
  assert(!text.includes("node:fs"));
  assert(!text.includes("createHarness"));
  const ipc = await import("@forge/core/shared/ipc");
  const project = await import("@forge/core/shared/project-context");
  assert.equal(ipc.projectContextDtoSchema, project.projectContextDtoSchema);
});

test("packaged runtime executes an offline turn and persists the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-package-turn-"));
  let service;
  try {
    const { createHarness } = await import("@forge/core");
    service = await createHarness({
      stateDir: join(directory, "state"),
      providerFactory: () => ({
        listModels: async () => ["fixture"],
        complete: async (_messages, _tools, options) => {
          options.onText("packaged core works");
          return { message: { role: "assistant", content: "packaged core works" } };
        },
      }),
      toolFactory: () => ({ definitions: [], execute: async () => { throw new Error("Unexpected tool"); }, dispose: async () => {} }),
    });
    await service.updateSettings({ settings: { baseUrl: "http://127.0.0.1:1/v1", model: "fixture", apiMode: "chat-completions" } });
    const session = await service.createSession({ workspace: directory, title: "Package fixture" });
    const result = await service.run({ sessionId: session.id, prompt: "hello", permission: "readonly" }, () => {}, async () => false, new AbortController().signal);
    assert.equal(result.status, "completed");
    assert.equal(result.messages.at(-1).content, "packaged core works");
    assert.equal((await service.getSession(session.id)).messages.at(-1).content, "packaged core works");
  } finally {
    await service?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless entry serves RPC without renderer files or real user state", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-package-server-"));
  let child;
  let closed;
  try {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(root, "dist/web/serve.js"), "--port", String(port), "--workspace", directory], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, FORGE_HOME: join(directory, "state") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let output = "";
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    child.stdout.on("data", chunk => {
      output = (output + chunk.toString()).slice(-8192);
      if (output.includes(origin)) ready();
    });
    child.stderr.on("data", chunk => { output = (output + chunk.toString()).slice(-8192); });
    let timer;
    try {
      await Promise.race([
        started,
        closed.then(() => { throw new Error(`Core exited before listening: ${output}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Core startup timed out: ${output}`)), 10000); }),
      ]);
    } finally { clearTimeout(timer); }
    const connect = await fetch(`${origin}/api/connect`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000),
    });
    assert.equal(connect.status, 200);
    const { clientId } = await connect.json();
    assert.equal(typeof clientId, "string");
    const response = await fetch(`${origin}/api/rpc`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Forge-Client": clientId },
      body: JSON.stringify({ id: randomUUID(), method: "listSessions" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.result, []);
    assert.equal((await fetch(origin, { signal: AbortSignal.timeout(5000) })).status, 404);
  } finally {
    if (child && closed) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await closed; } finally { clearTimeout(force); }
    }
    await rm(directory, { recursive: true, force: true });
  }
});
