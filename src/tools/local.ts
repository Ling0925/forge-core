import { z } from "zod";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import { MAX_EDITABLE_FILE_BYTES as FILE_LIMIT } from "../shared/file-limits";
import type { ToolCall, ToolResult } from "../shared/schemas";
import type { CheckpointStore } from "../store/checkpoints";
import { gitInspect } from "./git";
import { createLocalCommands } from "./local-commands";
import { check, fail, result } from "./local-common";
import { createLocalFiles } from "./local-files";
import { createLocalPolicy } from "./local-policy";
import {
  argumentGuidance,
  argumentsSchema,
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
  const { redact, clearCache } = policy;
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
  const commands = createLocalCommands({ guard, policy });
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
          return await commands.readCommandOutput(args, context);
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
          return await commands.command(args, context, signal);
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
        await commands.dispose();
      });
      return disposal;
    },
  });
}
