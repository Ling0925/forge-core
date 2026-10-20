// Synthetic local-only benchmark. Optional argument selects a baseline checkout.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const source = resolve(process.argv[2] ?? ".");
const temporary = await mkdtemp(join(tmpdir(), "forge-store-bench-"));
try {
  const output = join(temporary, "store.mjs");
  await build({
    entryPoints: [join(source, "src/store/sessions.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { openSessionStore } = await import(pathToFileURL(output).href);
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const measure = async (work) => {
    const values = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await work();
      values.push(performance.now() - start);
    }
    return +median(values).toFixed(2);
  };
  const rows = [];
  for (const count of [1000, 5000]) {
    for (const records of [0, 8, 16, 32]) {
      const directory = join(temporary, `${count}-${records}`);
      const store = await openSessionStore(directory);
      let snapshot = await store.create({
        workspace: directory,
        title: "benchmark",
        model: "fixture",
      });
      snapshot = {
        ...snapshot,
        status: "completed",
        messages: Array.from({ length: count }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: "x".repeat(1000),
        })),
      };
      await store.save(snapshot);
      const bytes = Buffer.byteLength(JSON.stringify(snapshot));
      let current = store.incremental
        ? await store.incremental.read(snapshot.id)
        : undefined;
      const write = async (title, status = "running") => {
        snapshot = { ...snapshot, title, status };
        if (store.incremental && current) {
          const { messages, events, changes, ...metadata } = snapshot;
          current = await store.incremental.commit(snapshot.id, {
            baseRevision: current.revision,
            metadata,
            messages: { keep: messages.length, append: [] },
            events: { keep: events.length, append: [] },
            changes: { keep: changes.length, append: [] },
          });
          snapshot = current.snapshot;
        } else await store.save(snapshot);
      };
      for (let n = 0; n < records; n++) await write(`metadata ${n}`);
      const warmGetMs = await measure(() => store.get(snapshot.id));
      const coldGetMs = await measure(async () =>
        (await openSessionStore(directory)).get(snapshot.id),
      );
      let index = 0;
      const metadataWriteMs = await measure(() => write(`measured ${index++}`));
      rows.push({
        messages: count,
        journalRecords: records,
        snapshotBytes: bytes,
        warmGetMs,
        coldGetMs,
        metadataWriteMs,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        samples: 5,
        statistic: "median milliseconds",
        incremental: !!(await openSessionStore(join(temporary, "capability")))
          .incremental,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
