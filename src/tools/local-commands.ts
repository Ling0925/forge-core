import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute } from "node:path";
import type { z } from "zod";
import { isSensitivePath } from "../shared/content-safety";
import type { ToolContext } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type { ToolResult } from "../shared/schemas";
import { createCommandOutputStore } from "./command-output";
import { abortable, check, errorCode, fail, result } from "./local-common";
import type { createLocalPolicy } from "./local-policy";
import {
  RESULT_LIMIT,
  type argumentsSchema,
  type commandSchema,
} from "./local-schemas";
import type { WorkspacePathGuard } from "./path-guard";

export function createLocalCommands({
  guard,
  policy,
}: {
  guard: WorkspacePathGuard;
  policy: ReturnType<typeof createLocalPolicy>;
}) {
  const { containsKnown, redact, targetName } = policy;
  const commandOutput = createCommandOutputStore(redact);
  async function commandPath(): Promise<string> {
    const defaults =
      process.platform === "win32"
        ? ["C:\\Windows\\System32"]
        : ["/usr/local/bin", "/usr/bin", "/bin"];
    const candidates = [
      ...defaults,
      dirname(process.execPath),
      ...(process.env.PATH ?? "").split(delimiter),
    ];
    const paths = new Set<string>();
    for (const candidate of candidates) {
      if (
        !isAbsolute(candidate) ||
        candidate.includes("\0") ||
        containsKnown(candidate) ||
        /[\r\n]/.test(candidate)
      )
        continue;
      try {
        const local = await realpath(candidate);
        if (
          containsKnown(local) ||
          isSensitivePath(local) ||
          (process.platform === "win32" && local.startsWith("\\\\"))
        )
          continue;
        if ((await lstat(local)).isDirectory()) paths.add(local);
      } catch {
        // An invalid or inaccessible PATH entry contributes no search directory.
      }
    }
    return [...paths].join(delimiter);
  }
  async function command(
    args: z.infer<typeof commandSchema>,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const executable = args.argv[0];
    if (!executable)
      fail("Command argv must start with a nonempty executable.");
    if (args.argv.some(containsKnown))
      fail("Sensitive command arguments are not permitted.");
    if (args.argv.reduce((total, item) => total + item.length, 0) > 7000)
      fail("Command description exceeds the approval ceiling.");
    if (isSensitivePath(args.cwd)) fail("Sensitive paths are not permitted.");
    const cwd = await guard.resolveRead(args.cwd);
    const name = targetName(cwd);
    if (!(await lstat(cwd)).isDirectory())
      fail("Command cwd must be a directory.");
    check(signal);
    if (context.permission === "workspace") {
      const request = {
        id: randomUUID(),
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        toolName: "run_command",
        description: `Execute argv ${JSON.stringify(args.argv)} in workspace cwd ${JSON.stringify(name)}. This is not an OS sandbox.`,
        command: args.argv,
      };
      context.onEvent({
        type: "approval_requested",
        sessionId: context.sessionId,
        timestamp: new Date().toISOString(),
        request,
      });
      check(signal);
      const allowed = await abortable(context.approve(request, signal), signal);
      check(signal);
      if (!allowed) return result({ error: "Command approval denied." }, true);
    }
    const path = await commandPath();
    await guard.resolveRead(name);
    if (!(await lstat(cwd)).isDirectory())
      fail("Command cwd must be a directory.");
    check(signal);
    const started = Date.now();
    const log = await commandOutput.create(context.sessionId);
    return new Promise<ToolResult>((resolve, reject) => {
      const child = spawn(executable, args.argv.slice(1), {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: path,
          HOME: homedir(),
          LANG: "C.UTF-8",
          TMPDIR: guard.root,
          TMP: guard.root,
          TEMP: guard.root,
        },
      });
      let timedOut = false;
      let cancelled = false;
      let spawnFailed = false;
      function kill(): void {
        if (child.pid === undefined) return;
        if (process.platform === "win32") {
          child.kill("SIGKILL");
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error: unknown) {
          if (errorCode(error) !== "ESRCH") spawnFailed = true;
        }
      }
      const abort = () => {
        cancelled = true;
        kill();
      };
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, args.timeout_ms);
      child.once("spawn", () => {
        try {
          context.onCommandStarted?.();
        } catch {
          /* Observers cannot fail execution. */
        }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        log.capture("stdout", chunk);
        try {
          context.onCommandOutput?.("stdout", chunk.toString("utf8"));
        } catch {
          /* Observer only. */
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        log.capture("stderr", chunk);
        try {
          context.onCommandOutput?.("stderr", chunk.toString("utf8"));
        } catch {
          /* Observer only. */
        }
      });
      child.on("error", () => {
        spawnFailed = true;
      });
      child.on("close", (exitCode, exitSignal) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        // Descendants may have detached their output but remain in our group.
        kill();
        if (cancelled || signal.aborted) {
          void log
            .discard()
            .then(
              () =>
                reject(
                  new ForgeError("cancelled", "Tool execution cancelled."),
                ),
              reject,
            );
          return;
        }
        void log.finish().then((output) => {
          let out = output.stdout;
          let err = output.stderr;
          let previewTruncated = output.preview_truncated;
          const encode = () =>
            result(
              {
                ...output,
                stdout: out,
                stderr: err,
                preview_truncated: previewTruncated,
                exit_code: exitCode,
                signal: exitSignal,
                duration_ms: Date.now() - started,
                timed_out: timedOut,
                spawn_failed: spawnFailed,
              },
              timedOut || spawnFailed || exitCode !== 0,
            );
          let encoded = encode();
          while (Buffer.byteLength(encoded.content, "utf8") >= RESULT_LIMIT) {
            previewTruncated = true;
            if (out.length >= err.length)
              out = out.slice(0, Math.floor(out.length / 2));
            else err = err.slice(0, Math.floor(err.length / 2));
            encoded = encode();
          }
          resolve(encoded);
        }, reject);
      });
      if (signal.aborted) abort();
    });
  }
  async function readCommandOutput(
    args: Extract<
      z.infer<typeof argumentsSchema>,
      { tool: "read_command_output" }
    >,
    context: ToolContext,
  ): Promise<ToolResult> {
    return result(
      await commandOutput.read(
        context.sessionId,
        args.id,
        args.stream,
        args.offset,
        args.limit,
      ),
    );
  }
  return { command, readCommandOutput, dispose: commandOutput.dispose };
}
