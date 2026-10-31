import { z } from "zod";
import { formatValidationError } from "../shared/errors";
import { MAX_EDITABLE_FILE_BYTES as FILE_LIMIT } from "../shared/file-limits";
import type { ToolDefinition } from "../shared/schemas";
import { defineTool } from "../shared/tool-definition";
import { noArgumentFields } from "../shared/tool-input";
import type { CheckpointStore } from "../store/checkpoints";

export const CACHE_LIMIT = 16 * 1024 * 1024;
export const RESULT_LIMIT = 128 * 1024;
export const ENTRY_LIMIT = 1000;
export const DEPTH_LIMIT = 8;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const pathSchema = z.string().min(1).max(4096);
const textSchema = z.string().max(2 * 1024 * 1024);
export const commandSchema = z
  .object({
    tool: z.literal("run_command"),
    argv: z
      .array(
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes("\0")),
      )
      .min(1)
      .max(256)
      .readonly(),
    cwd: pathSchema.default("."),
    timeout_ms: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS),
  })
  .strict()
  .readonly();
const queryPageSchema = {
  glob: z.string().min(1).max(1024).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
};
export const argumentsSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("list_files"),
      path: pathSchema.default("."),
      recursive: z.boolean().default(false),
      ...queryPageSchema,
      limit: z.number().int().min(1).max(ENTRY_LIMIT).default(ENTRY_LIMIT),
    })
    .strict()
    .readonly()
    .unwrap(),
  z
    .object({
      tool: z.literal("read_file"),
      path: pathSchema,
      offset: z.number().int().min(0).max(FILE_LIMIT).default(0),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .describe(
          "Line count for this page: 1-200, default 100 (e.g. limit 100 then continue from next_offset). Values above 200 are rejected; page instead of raising the limit.",
        )
        .default(100),
      if_version: z.string().max(128).optional(),
    })
    .strict()
    .readonly()
    .unwrap(),
  z
    .object({
      tool: z.literal("write_file"),
      path: pathSchema,
      content: textSchema,
      append: z.boolean().default(false),
      expected_bytes: z.number().int().min(0).max(FILE_LIMIT).optional(),
    })
    .strict()
    .readonly()
    .unwrap(),
  z
    .object({
      tool: z.literal("append_file"),
      path: pathSchema,
      content: textSchema,
      expected_bytes: z.number().int().min(0).max(FILE_LIMIT),
    })
    .strict()
    .readonly()
    .unwrap(),
  z
    .object({
      tool: z.literal("edit_file"),
      path: pathSchema,
      old_text: textSchema.min(1),
      new_text: textSchema,
      replace_all: z.boolean().default(false),
    })
    .strict()
    .readonly()
    .unwrap(),
  z
    .object({ tool: z.literal("make_directory"), path: pathSchema })
    .strict()
    .readonly()
    .unwrap(),
  commandSchema.unwrap(),
  z
    .object({
      tool: z.literal("read_command_output"),
      id: z.string().uuid(),
      stream: z.enum(["stdout", "stderr"]).default("stdout"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(12000).default(12000),
    })
    .strict(),
  z.object({ tool: z.literal("git_status"), ...noArgumentFields }).strict(),
  z.object({ tool: z.literal("git_diff"), ...noArgumentFields }).strict(),
  z.object({ tool: z.literal("git_log"), ...noArgumentFields }).strict(),
  z
    .object({
      tool: z.literal("search_files"),
      query: z.string().min(1).max(1024),
      path: pathSchema.default("."),
      ...queryPageSchema,
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .describe(
          "Matching lines/entries per page: 1-100, default 100. Values above 100 are rejected; call again with next_offset instead of raising the limit.",
        )
        .default(100),
      mode: z.enum(["content", "files", "count"]).default("content"),
      case_sensitive: z.boolean().default(true),
      regex: z.boolean().default(false),
      context_lines: z
        .number()
        .int()
        .min(0)
        .max(3)
        .describe(
          "Surrounding lines per match: 0-3, default 0 (e.g. context_lines 1 for the adjacent line). Values above 3 are rejected; read_file the match for more context.",
        )
        .default(0),
    })
    .strict()
    .readonly()
    .unwrap(),
]);
// Each description states only the boundaries that apply to that tool: read
// tools need no write-size advice or a readonly mutation note.
const pathBoundaries =
  "Workspace-relative only; no symlinks or sensitive files (.env*, credentials, private keys, .ssh, .config, .git). ";
const readPolicies = `${pathBoundaries}Files at most 16 MiB. `;
const listPolicies = pathBoundaries;
const directoryPolicies = `${pathBoundaries}Readonly forbids mutations. `;
const writePolicies = `${pathBoundaries}Files at most 16 MiB; generate large files in small chunks. Readonly forbids mutations. `;
const toolDescriptions: Readonly<
  Record<z.infer<typeof argumentsSchema>["tool"], string>
> = {
  git_status:
    "Read-only repository status for the workspace root. Sensitive paths omitted; secrets redacted; no shell execution. Outside a Git work tree: repository:false with a note. A nested workspace is rejected; run from the repository root.",
  git_diff:
    "Read-only unstaged repository diff for the workspace root. Sensitive paths omitted; secrets redacted; no shell execution. Outside a Git work tree: repository:false with a note. A nested workspace is rejected; run from the repository root.",
  git_log:
    "Read-only recent repository log for the workspace root. Secrets redacted; no shell execution. Outside a Git work tree: repository:false with a note. A nested workspace is rejected; run from the repository root; a repository with no commits yet returns an empty log.",
  list_files: `${listPolicies}List paginated entries; optional root-relative glob (*, **, ?). Bounded traversal (1000 entries, 8 levels); dependency/build/cache directories excluded. scan_truncated: incomplete traversal; truncated: more pages.`,
  read_file: `${readPolicies}Numbered UTF-8 pages with zero-based offset, SHA-256 version, byte size, inclusive end_line and cache status. Use offset with limit, where limit is 1-200 lines and defaults to 100; limit above 200 is rejected; continue from next_offset. Matching if_version returns unchanged:true without content or new write authority. A nonempty page authorizes write/edit in this run; own successful writes refresh that version, external changes require a new read. Binary rejected; output bounded.`,
  write_file: `Default tool for creating files or replacing complete content. No append or expected_bytes input; use append_file for chunks and edit_file for targeted edits. Overwriting requires read_file of the current version in this run; new files need no read. Own successful writes refresh read authority. Unchanged content is a no-op. Returns size_bytes and a bounded display diff patch. Atomic writes use restorable checkpoints when a checkpoint store is configured; restore uses checkpoints, not the patch. Create missing parents with make_directory. ${writePolicies}`,
  append_file: `Append a small chunk (prefer <=16000 characters). Pass expected_bytes from the last successful write/read, or 0 for a new file. A mismatched byte size fails without appending; never blindly replay a chunk. Existing files require read_file in this run or a successful own write. Returns size_bytes for the next chunk and a bounded display diff patch. Atomic writes use restorable checkpoints when a checkpoint store is configured; restore uses checkpoints, not the patch. Create missing parents with make_directory. ${writePolicies}`,
  edit_file: `Default tool for targeted file edits instead of command scripts. Atomically replace literal old_text (nonempty); exactly one occurrence is required unless replace_all is true. Authority is a nonempty read_file page of this file in this run (never with if_version); your own successful writes refresh it. Any other change invalidates it (your own builds, formatters, codegen or git; other agents; checkpoint restores; new runs); read_file again first. A file-changed failure is deterministic: never retry the same call, read the current content and re-apply the edit to what it now says. Identical replacement is a no-op. Edits use restorable checkpoints when a checkpoint store is configured; the bounded display diff patch is separate. ${writePolicies}`,
  make_directory: `${directoryPolicies}Create directories recursively without traversing symlinks. Existing directories are accepted.`,
  run_command:
    "Run builds, tests, git and package managers with explicit argv (no implicit shell). For authored files use write_file/edit_file; command effects are not checkpointed. Readonly denied; workspace requests per-call approval under the host policy. NOT an OS sandbox; cwd is guarded. Minimal environment; HOME is the host user's home. Choose and pass timeout_ms: maximum 30 minutes (1800000 ms), no default; allow enough time for builds/tests. Output never terminates a command: private logs retain up to 16 MiB/command and 128 MiB/run, then stop capture. Results show 12000 characters/stream; read_command_output pages the redacted log during this run. Encoded result cap 128 KiB. Cancellation waits for process close.",
  read_command_output:
    "Read a completed command's redacted log without rerunning it. IDs belong to this session/run; logs expire at run end. Offset and limit are UTF-16 characters, not bytes. Readonly permitted.",
  search_files: `${readPolicies}Literal search by default; optional bounded regex, root-relative glob (*, **, ?), context and pagination. Modes return line matches, files or per-file matching-line counts in matches. limit is 1-100 per page (default 100; above 100 is rejected, continue with next_offset) and context_lines is 0-3 (default 0; above 3 is rejected, use read_file for more context). Traversal capped at 1000 entries/8 levels; binary/oversize/sensitive files skipped. scan_truncated: incomplete scan; truncated: more pages.`,
};
export const definitions: readonly ToolDefinition[] =
  argumentsSchema.options.map((schema) => {
    const { tool, ...fields } = schema.shape;
    const name = tool.value;
    return defineTool(
      name,
      toolDescriptions[name],
      z.object(fields).strict(),
      name === "write_file" ? ["append", "expected_bytes"] : [],
    );
  });

/**
 * Declared paging ceilings stay enforced; only the explanation becomes actionable so a
 * rejected call states the accepted range and the supported way to see more.
 */
const pagingGuidance: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  read_file: {
    limit:
      "read_file limit accepts 1-200 lines per page (default 100); it is rejected rather than clamped, so keep it in range and continue from next_offset to see more.",
  },
  search_files: {
    limit:
      "search_files limit accepts 1-100 matches per page (default 100); it is rejected rather than clamped, so keep it in range and continue with next_offset.",
    context_lines:
      "search_files context_lines accepts 0-3 (default 0); it is rejected rather than clamped, so use a smaller value and read_file the match for more surrounding text.",
  },
};
/** Bounded, authored guidance; never echoes argument values. */
export function argumentGuidance(name: string, error: z.ZodError): string {
  const message = formatValidationError(error);
  const guidance = pagingGuidance[name];
  if (!guidance) return message;
  const hints = new Set<string>();
  for (const issue of error.issues.slice(0, 8)) {
    const field = issue.path.find(
      (part): part is string => typeof part === "string",
    );
    const hint = field === undefined ? undefined : guidance[field];
    if (hint) hints.add(hint);
  }
  return hints.size === 0 ? message : `${message} ${[...hints].join(" ")}`;
}

export const optionsSchema = z
  .object({
    protectedRoots: z.array(z.string()).readonly().optional(),
    redactValues: z.array(z.string()).readonly().optional(),
    checkpointStore: z.custom<CheckpointStore>().optional(),
    gitTimeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .readonly();
