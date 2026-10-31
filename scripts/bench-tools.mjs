#!/usr/bin/env node
// Tool and process start benchmark (uses dist/, a temporary FORGE_HOME and a stub provider):
//   node scripts/bench-tools.mjs [--locks N] [--turns N] [--mcp-turns N] [--cold N] [--json]
//     [--lsp-turns N --lsp-workspace DIR --lsp-file PATH --lsp-line N --lsp-character N --lsp-server FILE]
// --locks: N fileLock acquire/release pairs, then N read_file turns (lock-heavy run path).
// --lsp-turns: N turns, each one `lsp` hover on --lsp-file; --lsp-server is the server's JS entry,
//   run with this Node and --stdio (e.g. typescript-language-server/lib/cli.mjs).
// --mcp-turns: N turns, each listing and calling the example echo MCP server.
// --cold: N process starts each of `dist/web/serve.js` (until it listens) and of a harness import;
//   the first start of each uses an empty TMPDIR, so Node's default compile cache starts cold.
import cp, { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    locks: { type: "string", default: "0" },
    "lsp-turns": { type: "string", default: "0" },
    "lsp-workspace": { type: "string" },
    "lsp-file": { type: "string" },
    "lsp-line": { type: "string", default: "1" },
    "lsp-character": { type: "string", default: "1" },
    "lsp-server": { type: "string" },
    "mcp-turns": { type: "string", default: "0" },
    cold: { type: "string", default: "0" },
    json: { type: "boolean", default: false },
  },
});
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const echoServer = fileURLToPath(
  new URL("../examples/mcp/echo-server.mjs", import.meta.url),
);

const spawns = new Map();
const originalSpawn = cp.spawn;
cp.spawn = function (command, ...rest) {
  spawns.set(command, (spawns.get(command) ?? 0) + 1);
  return originalSpawn.call(this, command, ...rest);
};
syncBuiltinESMExports();
const spawnCount = () => [...spawns.values()].reduce((a, b) => a + b, 0);

const home = await mkdtemp(join(tmpdir(), "forge-bench-tools-"));
process.env.FORGE_HOME = home;
const { createHarness } = await import(join(dist, "core/harness.js"));
const { fileLock } = await import(join(dist, "store/lock.js"));

const cpuMs = (usage) => (usage.user + usage.system) / 1000;
async function procCpuMs(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
}
async function childCpuMs() {
  const stat = await readFile("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return ((Number(fields[13]) + Number(fields[14])) * 1000) / 100;
}
async function measure(fn) {
  const spawned = spawnCount();
  const children = await childCpuMs();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await fn();
  return {
    wallMs: performance.now() - start,
    cpuMs: cpuMs(process.cpuUsage(cpu)),
    childCpuMs: (await childCpuMs()) - children,
    spawns: spawnCount() - spawned,
  };
}
function summarize(samples) {
  const out = { n: samples.length, first: samples[0] };
  for (const key of Object.keys(samples[0])) {
    const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
    out[key] = {
      median: sorted[Math.floor(sorted.length / 2)],
      total: sorted.reduce((a, b) => a + b, 0),
    };
  }
  return out;
}

// Each prompt names a plan: the tool calls issued in order, then "done".
const plans = new Map();
const provider = {
  listModels: async () => ["bench"],
  complete: async (messages) => {
    let last = messages.length - 1;
    while (messages[last].role !== "user") last--;
    const steps = plans.get(messages[last].content) ?? [];
    const done = messages
      .slice(last + 1)
      .filter((m) => m.role === "tool").length;
    const next = steps[done];
    if (!next) return { message: { role: "assistant", content: "done" } };
    const [name, args] = next;
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${messages.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    };
  },
};
const toolErrors = [];
async function turn(harness, sessionId, prompt) {
  await harness.run(
    { sessionId, prompt },
    (event) => {
      if (event.type === "tool_finished" && event.result?.isError)
        toolErrors.push(event.result.content.slice(0, 300));
    },
    async () => true,
    new AbortController().signal,
  );
}
const harnessOptions = {
  stateDir: join(home, "state"),
  providerFactory: () => provider,
};
const report = { node: process.version };
const lspTurns = Number(values["lsp-turns"]);
const settings = { baseUrl: "http://127.0.0.1:9/v1", model: "bench" };
if (lspTurns)
  settings.lspServers = [
    {
      id: "bench",
      command: process.execPath,
      args: [resolve(values["lsp-server"]), "--stdio"],
      extensions: [".ts", ".tsx"],
    },
  ];
const harness = await createHarness(harnessOptions);
await harness.updateSettings({ settings });

const locks = Number(values.locks);
if (locks) {
  const dir = join(home, "locks");
  await mkdir(dir, { recursive: true });
  const samples = [];
  for (let i = 0; i < locks; i++)
    samples.push(
      await measure(async () => {
        const release = await fileLock(join(dir, "bench.lock"));
        await release();
      }),
    );
  report.fileLock = summarize(samples);
  plans.set("read", [["read_file", { path: "README.md" }]]);
  const session = await harness.createSession({ workspace: process.cwd() });
  await turn(harness, session.id, "read");
  const turns = [];
  for (let i = 0; i < locks; i++)
    turns.push(await measure(() => turn(harness, session.id, "read")));
  report.readTurn = summarize(turns);
}
if (lspTurns) {
  plans.set("lsp", [
    [
      "lsp",
      {
        operation: "hover",
        path: values["lsp-file"],
        line: Number(values["lsp-line"]),
        character: Number(values["lsp-character"]),
      },
    ],
  ]);
  const session = await harness.createSession({
    workspace: resolve(values["lsp-workspace"]),
  });
  const turns = [];
  for (let i = 0; i < lspTurns; i++)
    turns.push(await measure(() => turn(harness, session.id, "lsp")));
  report.lspTurn = summarize(turns);
}
const mcpTurns = Number(values["mcp-turns"]);
if (mcpTurns) {
  await harness.registerMcpServer({
    id: "echo",
    label: "Echo",
    command: process.execPath,
    args: [echoServer],
  });
  await harness.setMcpEnabled("echo", true);
  plans.set("mcp", [
    ["mcp_list_tools", { server: "echo" }],
    [
      "mcp_call_tool",
      {
        toolName: "mcp__echo__echo",
        arguments_json: JSON.stringify({ text: "hello" }),
      },
    ],
  ]);
  const session = await harness.createSession({ workspace: process.cwd() });
  const turns = [];
  for (let i = 0; i < mcpTurns; i++)
    turns.push(await measure(() => turn(harness, session.id, "mcp")));
  report.mcpTurn = summarize(turns);
}
const disposed = await measure(() => harness.dispose());
report.dispose = disposed;
report.toolErrors = toolErrors.slice(0, 5);
report.toolErrorCount = toolErrors.length;

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}
async function start(args, env, ready) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const begin = performance.now();
  let output = "";
  await new Promise((done, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(ready)) done();
    });
    child.once("exit", (code) =>
      reject(new Error(`exited ${code} before ready: ${output}`)),
    );
  });
  const wallMs = performance.now() - begin;
  const cpu = await procCpuMs(child.pid);
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await exited;
  return { wallMs, cpuMs: cpu };
}
const cold = Number(values.cold);
if (cold) {
  const workspace = await mkdtemp(join(tmpdir(), "forge-bench-ws-"));
  const tmp = await mkdtemp(join(tmpdir(), "forge-bench-tmp-"));
  const { NODE_COMPILE_CACHE: _, ...inherited } = process.env;
  const env = { ...inherited, FORGE_HOME: home, TMPDIR: tmp };
  const serve = [];
  for (let i = 0; i < cold; i++)
    serve.push(
      await start(
        [
          join(dist, "web/serve.js"),
          "--port",
          String(await freePort()),
          "--workspace",
          workspace,
        ],
        env,
        "Forge Web:",
      ),
    );
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp);
  const script = `const c=process.cpuUsage();const { createHarness } = await import(${JSON.stringify(join(dist, "core/harness.js"))});const h=await createHarness();await h.dispose();const u=process.cpuUsage(c);console.log("ready "+(u.user+u.system)/1000);setInterval(()=>{},1000);`;
  const harnessStart = [];
  for (let i = 0; i < cold; i++)
    harnessStart.push(
      await start(["--input-type=module", "-e", script], env, "ready"),
    );
  report.coldServe = { first: serve[0], warm: summarize(serve.slice(1)) };
  report.coldHarness = {
    first: harnessStart[0],
    warm: summarize(harnessStart.slice(1)),
  };
  await rm(workspace, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
}
await rm(home, { recursive: true, force: true });

if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  const f = (n) => (n === undefined ? "-" : n.toFixed(1));
  const row = (name, s) =>
    `${name.padEnd(26)} wall ${f(s.wallMs)}  cpu ${f(s.cpuMs)}  child ${f(s.childCpuMs)}  spawns ${s.spawns ?? "-"}`;
  const med = (s) =>
    Object.fromEntries(
      Object.entries(s)
        .filter(([, v]) => typeof v === "object" && "median" in v)
        .map(([k, v]) => [k, v.median]),
    );
  console.log(`node ${report.node}`);
  for (const key of ["fileLock", "readTurn", "lspTurn", "mcpTurn"]) {
    const s = report[key];
    if (!s) continue;
    console.log(row(`${key} first`, s.first));
    console.log(row(`${key} median (n=${s.n})`, med(s)));
  }
  console.log(row("dispose", report.dispose));
  for (const key of ["coldServe", "coldHarness"]) {
    const s = report[key];
    if (!s) continue;
    console.log(row(`${key} empty cache`, s.first));
    console.log(row(`${key} median after`, med(s.warm)));
  }
  if (report.toolErrorCount)
    console.log(`tool errors: ${report.toolErrorCount}`, report.toolErrors);
}
