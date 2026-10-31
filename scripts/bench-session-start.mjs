#!/usr/bin/env node
// Session start benchmark:
//   node scripts/bench-session-start.mjs [--sessions N] [--seed N] [--seed-messages N] [--idle MS] [--json] <workspace>...
// --seed pre-creates N existing sessions of --seed-messages messages each, like a long-used FORGE_HOME.
// --cpu-profile FILE profiles harness start and the session phases (after seeding);
// --idle-profile FILE profiles only the idle phase.
// Uses dist/ (run `pnpm build` first), a temporary FORGE_HOME and a stub provider.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sessions: { type: "string", default: "5" },
    idle: { type: "string", default: "3000" },
    json: { type: "boolean", default: false },
    seed: { type: "string", default: "0" },
    "seed-messages": { type: "string", default: "200" },
    "cpu-profile": { type: "string" },
    "idle-profile": { type: "string" },
  },
});
const sessions = Number(values.sessions);
const idleMs = Number(values.idle);
const workspaces = positionals.map((p) => resolve(p));
if (!workspaces.length) {
  console.error("usage: bench-session-start.mjs [--sessions N] <workspace>...");
  process.exit(2);
}

const home = await mkdtemp(join(tmpdir(), "forge-bench-"));
process.env.FORGE_HOME = home;
const importStart = performance.now();
const importCpu = process.cpuUsage();
const { createHarness } = await import("../dist/core/harness.js");
const imported = {
  wallMs: performance.now() - importStart,
  cpuMs: cpuMs(process.cpuUsage(importCpu)),
};

let toolCount = 0;
const provider = {
  listModels: async () => ["bench"],
  complete: async (messages, tools) => {
    toolCount = tools.length;
    const read = tools.find((tool) => tool.function?.name === "read_file");
    if (messages.at(-1)?.role !== "user" || !read)
      return { message: { role: "assistant", content: "done" } };
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${messages.length}`,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "README.md" }),
            },
          },
        ],
      },
    };
  },
};
const harnessOptions = {
  stateDir: join(home, "state"),
  providerFactory: () => provider,
};

function cpuMs(usage) {
  return (usage.user + usage.system) / 1000;
}
async function childCpuMs() {
  const stat = await readFile("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return ((Number(fields[13]) + Number(fields[14])) * 1000) / 100;
}
const inspector = new Session();
inspector.connect();
await inspector.post("Profiler.enable");
await inspector.post("Profiler.setSamplingInterval", { interval: 200 });
async function profile(file, fn) {
  if (!file) return fn();
  await inspector.post("Profiler.start");
  try {
    return await fn();
  } finally {
    const { profile } = await inspector.post("Profiler.stop");
    await writeFile(file, JSON.stringify(profile));
  }
}
const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
async function measure(fn, monitor = true) {
  delay.reset();
  if (!monitor) delay.disable();
  const children = await childCpuMs();
  const cpu = process.cpuUsage();
  const start = performance.now();
  const value = await fn();
  const wallMs = performance.now() - start;
  if (!monitor) delay.enable();
  const sample = {
    wallMs,
    cpuMs: cpuMs(process.cpuUsage(cpu)),
    childCpuMs: (await childCpuMs()) - children,
    maxBlockMs: delay.max / 1e6,
    rssMb: process.memoryUsage().rss / 2 ** 20,
    heapMb: process.memoryUsage().heapUsed / 2 ** 20,
  };
  return { value, sample };
}
// Heap and RSS after a full GC when run with --expose-gc; peak RSS from the kernel.
function retained() {
  globalThis.gc?.();
  const memory = process.memoryUsage();
  return {
    gc: typeof globalThis.gc === "function",
    rssMb: memory.rss / 2 ** 20,
    heapMb: memory.heapUsed / 2 ** 20,
    externalMb: memory.external / 2 ** 20,
    peakRssMb: process.resourceUsage().maxRSS / 1024,
  };
}
const runSession = (harness, sessionId) =>
  harness.run(
    { sessionId, prompt: "hello" },
    () => {},
    async () => false,
    new AbortController().signal,
  );
function summarize(samples) {
  const keys = Object.keys(samples[0]);
  const out = {};
  for (const key of keys) {
    const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
    out[key] = {
      median: sorted[Math.floor(sorted.length / 2)],
      max: sorted.at(-1),
    };
  }
  return out;
}

const report = {
  node: process.version,
  sessions,
  seed: Number(values.seed),
  imported,
  workspaces: [],
};
let harness = (await measure(() => createHarness(harnessOptions))).value;
await harness.updateSettings({
  settings: { baseUrl: "http://127.0.0.1:9/v1", model: "bench" },
});
await harness.dispose();
const seed = Number(values.seed);
const seeded = new Map(workspaces.map((workspace) => [workspace, []]));
if (seed) {
  const { openSessionStore } = await import("../dist/store/sessions.js");
  const store = await openSessionStore(harnessOptions.stateDir);
  const text = "lorem ipsum dolor sit amet ".repeat(40);
  for (let i = 0; i < seed; i++) {
    const session = await store.create({
      workspace: workspaces[i % workspaces.length],
      title: `seed ${i}`,
      model: "bench",
    });
    // Real sessions start with the system message the first run inserts.
    const messages = [{ role: "system", content: text }];
    for (let m = 0; m < Number(values["seed-messages"]); m += 4) {
      const id = `seed_${m}`;
      messages.push(
        { role: "user", content: text },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: id, content: text.repeat(4) },
        { role: "assistant", content: text },
      );
    }
    await store.save({ ...session, messages });
    seeded.get(session.workspace)?.push(session.id);
  }
  // Let seeded journal records age past the store's 2 s racy-timestamp window,
  // as they would in a long-used FORGE_HOME.
  await new Promise((done) => setTimeout(done, 2100));
}
await profile(values["cpu-profile"], async () => {
  const created = await measure(() => createHarness(harnessOptions));
  harness = created.value;
  report.harnessStart = created.sample;
  for (const workspace of workspaces) {
    const ids = [];
    const fresh = [];
    const resumed = [];
    const restarted = [];
    const listed = [];
    const context = [];
    const creates = [];
    for (let i = 0; i < sessions; i++) {
      const { value, sample } = await measure(async () => {
        const create = await measure(() =>
          harness.createSession({ workspace }),
        );
        creates.push(create.sample);
        await runSession(harness, create.value.id);
        return create.value.id;
      });
      ids.push(value);
      fresh.push(sample);
    }
    for (const id of ids)
      resumed.push((await measure(() => runSession(harness, id))).sample);
    for (const id of ids) {
      listed.push((await measure(() => harness.listSessions())).sample);
      context.push((await measure(() => harness.getProjectContext(id))).sample);
    }
    await harness.dispose();
    harness = (await measure(() => createHarness(harnessOptions))).value;
    for (const id of ids)
      restarted.push((await measure(() => runSession(harness, id))).sample);
    const long = [];
    for (const id of (seeded.get(workspace) ?? []).slice(0, sessions))
      long.push((await measure(() => runSession(harness, id))).sample);
    report.workspaces.push({
      workspace,
      first: fresh[0],
      fresh: summarize(fresh),
      createSession: summarize(creates),
      resumed: summarize(resumed),
      restarted: summarize(restarted),
      ...(long.length ? { seededResume: summarize(long) } : {}),
      listSessions: summarize(listed),
      projectContext: summarize(context),
      retained: retained(),
    });
  }
});
const idle = await profile(values["idle-profile"], () =>
  measure(() => new Promise((done) => setTimeout(done, idleMs)), false),
);
report.idle = { ms: idleMs, ...idle.sample };
report.tools = toolCount;
await harness.dispose();
await rm(home, { recursive: true, force: true });

if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  const f = (n) => n.toFixed(1);
  const row = (name, s) =>
    `${name.padEnd(28)} wall ${f(s.wallMs)}  cpu ${f(s.cpuMs)}  child ${f(s.childCpuMs)}  block ${f(s.maxBlockMs)}  rss ${f(s.rssMb)}  heap ${f(s.heapMb)}`;
  const med = (s) =>
    Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.median]));
  console.log(
    `node ${report.node}, ${sessions} sessions per workspace, ${report.seed} seeded sessions, ${toolCount} tools`,
  );
  console.log(
    `import                       wall ${f(imported.wallMs)}  cpu ${f(imported.cpuMs)}`,
  );
  console.log(row("harness start", report.harnessStart));
  for (const w of report.workspaces) {
    console.log(w.workspace);
    console.log(row("  first new session", w.first));
    console.log(row("  new session (median)", med(w.fresh)));
    console.log(row("    createSession only", med(w.createSession)));
    console.log(row("  resumed run (median)", med(w.resumed)));
    console.log(row("  after restart (median)", med(w.restarted)));
    if (w.seededResume)
      console.log(row("  resume seeded (median)", med(w.seededResume)));
    console.log(row("  listSessions (median)", med(w.listSessions)));
    console.log(row("  projectContext (median)", med(w.projectContext)));
    console.log(
      `  retained${w.retained.gc ? " after gc" : ""}: rss ${f(w.retained.rssMb)}  heap ${f(w.retained.heapMb)}  external ${f(w.retained.externalMb)}  peak rss ${f(w.retained.peakRssMb)}`,
    );
  }
  console.log(row(`idle ${idleMs}ms`, report.idle));
}
