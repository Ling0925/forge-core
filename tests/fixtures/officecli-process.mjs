#!/usr/bin/env node
// Fake OfficeCLI used by tests. It records exactly what the backend spawned,
// then behaves according to --mode. No real OfficeCLI is installed or needed.
import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const modeAt = args.indexOf("--mode");
const mode = modeAt >= 0 ? (args[modeAt + 1] ?? "normal") : "normal";
const bytesAt = args.indexOf("--bytes");
const bytes = bytesAt >= 0 ? Number(args[bytesAt + 1] ?? 0) : 100_000;
const cwd = process.cwd();
const recordPath = join(cwd, ".officecli-fixture.json");
const logPath = join(cwd, ".officecli-fixture.log");

const writeFully = (stream, data) =>
  new Promise((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(error) : resolve()));
  });

const ignoreTermination = () => process.on("SIGTERM", () => {});

const hang = () => {
  process.stdout.write("hanging\n");
  setInterval(() => {}, 1_000);
};

const record = (extra = {}) => ({
  pid: process.pid,
  mode,
  args,
  cwd,
  env: { ...process.env },
  ...extra,
});

if (mode === "grandchild") {
  // Descendant of the spawned leader: ignores SIGTERM and holds inherited
  // stdout (pipes are swallowed by "ignore" writers in the parent fixture).
  ignoreTermination();
  hang();
} else {
  await writeFile(recordPath, `${JSON.stringify(record())}\n`);
  await appendFile(logPath, `${JSON.stringify({ pid: process.pid, mode })}\n`);

  switch (mode) {
    case "normal":
      process.stdout.write(`fixture-ok\nargs=${JSON.stringify(args)}\n`);
      process.stderr.write("fixture-stderr\n");
      break;
    case "exit":
      await writeFully(process.stdout, "before-exit\n");
      await writeFully(process.stderr, "fixture-failure\n");
      process.exitCode = 7;
      break;
    case "truncate":
      await writeFully(process.stdout, `${"A".repeat(bytes)}\nstdout-end\n`);
      await writeFully(process.stderr, `${"B".repeat(bytes)}\nstderr-end\n`);
      // Proves the process kept running after output passed the cap.
      await writeFile(join(cwd, ".officecli-fixture-done"), "done\n");
      break;
    case "truncate-stdout":
      await writeFully(
        process.stdout,
        `ok\n${"A".repeat(bytes)}\nstdout-end\n`,
      );
      break;
    case "truncate-stderr":
      await writeFully(
        process.stderr,
        `noise\n${"B".repeat(bytes)}\nstderr-end\n`,
      );
      break;
    case "utf8":
      process.stdout.write(
        Buffer.concat([
          Buffer.from("héllo 世界 🚀\n", "utf8"),
          Buffer.from([0xff, 0xfe, 0x0a]),
        ]),
      );
      break;
    case "termination-tree": {
      // Leader exits on SIGTERM (default handling) while leaving a descendant
      // that ignores SIGTERM. The backend must still SIGKILL the group after
      // the leader's close event instead of reporting a clean join.
      const child = spawn(process.execPath, [self, "--mode", "grandchild"], {
        stdio: "ignore",
      });
      child.unref();
      await writeFile(
        recordPath,
        `${JSON.stringify(record({ childPid: child.pid }))}\n`,
      );
      hang();
      break;
    }
    case "hang":
      hang();
      break;
    default:
      process.stderr.write(`unknown fixture mode: ${mode}\n`);
      process.exitCode = 2;
  }
}
