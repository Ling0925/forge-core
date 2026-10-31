import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { isSensitivePath } from "../shared/content-safety";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { MAX_EDITABLE_FILE_BYTES as FILE_LIMIT } from "../shared/file-limits";
import type { ToolCall, ToolResult } from "../shared/schemas";
import type { CheckpointStore } from "../store/checkpoints";
import { createCommandOutputStore } from "./command-output";
import { gitInspect } from "./git";
import { abortable, check, errorCode, fail, result } from "./local-common";
import { createLocalFiles } from "./local-files";
import { createLocalPolicy } from "./local-policy";
import {
  RESULT_LIMIT,
  argumentGuidance,
  argumentsSchema,
  type commandSchema,
  definitions,
  optionsSchema,
} from "./local-schemas";
import { WorkspacePathError, createWorkspacePathGuard } from "./path-guard";

export interface LocalToolOptions {
  readonly protectedRoots?: readonly string[];
  readonly redactValues?: readonly string[];
  readonly checkpointStore?: CheckpointStore;
  /** Overrides the git inspection deadlines (see DEFAULT_GIT_*_TIMEOUT_MS). */
  readonly gitTimeoutMs?: number;
}
export async function createLocalToolRegistry(
  workspace: string,
  options: LocalToolOptions = {},
): Promise<LocalToolRegistry> {
  const known =
    optionsSchema
      .parse(options)
      .redactValues?.filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length) ?? [];
  const guard = await createWorkspacePathGuard(
    workspace,
    options.protectedRoots,
  );
  const shutdown = new AbortController();
  const active = new Set<Promise<ToolResult>>();
  // Model-visible reads and successful own writes authorize the current version.
  // Keep receipts separate from the internal read/search cache and session-scoped.
  const readReceipts = new Map<string, string>();
  let disposal: Promise<void> | undefined;
  const policy = createLocalPolicy({
    known,
    guard,
    readReceipts,
  });
  const { containsKnown, redact, clearCache, targetName } = policy;
  const {
    readFile,
    listFiles,
    writeFile,
    editFile,
    makeDirectory,
    searchFiles,
  } = createLocalFiles({
    options,
    guard,
    readReceipts,
    policy,
  });
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
  async function executeInner(
    call: ToolCall,
    context: ToolContext,
  ): Promise<ToolResult> {
    const signal = AbortSignal.any([context.signal, shutdown.signal]);
    try {
      check(signal);
      if (
        !definitions.some((item) => item.function.name === call.function.name)
      )
        fail("Unknown tool.");
      if (Buffer.byteLength(call.function.arguments, "utf8") > 3 * FILE_LIMIT)
        fail("Tool arguments exceed the ceiling.");
      const parsed: unknown = JSON.parse(call.function.arguments);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        "tool" in parsed
      )
        fail("Tool arguments must be an object without a tool field.");
      const args = argumentsSchema.parse({
        ...parsed,
        tool: call.function.name,
      });
      const mutation =
        args.tool === "write_file" ||
        args.tool === "append_file" ||
        args.tool === "edit_file" ||
        args.tool === "make_directory" ||
        args.tool === "run_command";
      if (mutation && context.permission === "readonly")
        fail("Readonly permission forbids this tool.");
      switch (args.tool) {
        case "read_command_output":
          return result(
            await commandOutput.read(
              context.sessionId,
              args.id,
              args.stream,
              args.offset,
              args.limit,
            ),
          );
        case "read_file":
          return await readFile(args, context, signal);
        case "list_files":
          return await listFiles(args, signal);
        case "append_file":
        case "write_file":
          return await writeFile(args, call, context, signal);
        case "edit_file":
          return await editFile(args, call, context, signal);
        case "make_directory":
          return await makeDirectory(args, signal);
        case "git_status":
        case "git_diff":
        case "git_log": {
          const inspection = await gitInspect(
            guard.root,
            args.tool.slice(4) as "status" | "diff" | "log",
            signal,
            known,
            options.protectedRoots,
            options.gitTimeoutMs === undefined
              ? {}
              : { timeoutMs: options.gitTimeoutMs },
          );
          return result({ source: "git", ...inspection });
        }
        case "run_command":
          return await command(args, context, signal);
        case "search_files":
          return await searchFiles(args, signal);
        default: {
          const unreachable: never = args;
          return unreachable;
        }
      }
    } catch (error: unknown) {
      check(signal);
      if (error instanceof z.ZodError)
        return result(
          {
            code: "invalid_input",
            error: redact(argumentGuidance(call.function.name, error)),
          },
          true,
        );
      if (error instanceof SyntaxError)
        return result(
          {
            code: "invalid_input",
            error:
              "Tool arguments must be valid JSON. Fix the JSON syntax before retrying.",
          },
          true,
        );
      if (error instanceof ForgeError) {
        if (error.code === "cancelled") throw error;
        return result({ code: error.code, error: redact(error.message) }, true);
      }
      if (error instanceof WorkspacePathError)
        return result(
          {
            error: `Workspace path rejected: ${error.code}. Missing parents must be created with make_directory.`,
          },
          true,
        );
      return result(
        {
          error:
            "Tool failed: invalid arguments or unavailable filesystem/command resource.",
        },
        true,
      );
    }
  }
  return Object.freeze({
    definitions,
    isConcurrencySafe: (call: ToolCall) =>
      [
        "read_file",
        "list_files",
        "search_files",
        "read_command_output",
        "git_status",
        "git_diff",
        "git_log",
      ].includes(call.function.name),
    execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
      const task = executeInner(call, context);
      active.add(task);
      task.then(
        () => active.delete(task),
        () => active.delete(task),
      );
      return task;
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      shutdown.abort();
      disposal = Promise.allSettled([...active]).then(async () => {
        clearCache();
        readReceipts.clear();
        await commandOutput.dispose();
      });
      return disposal;
    },
  });
}
