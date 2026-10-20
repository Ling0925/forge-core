import { defineTool } from "../shared/tool-definition";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { ForgeError, formatValidationError } from "../shared/errors";
import { noArgumentFields } from "../shared/tool-input";
import { createDiffPatch } from "../shared/diff";
import type {
  FileChange,
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../shared/schemas";
import type { CheckpointStore } from "../store/checkpoints";
import { gitInspect } from "./git";
import { createLineMatcher, globMatcher, pageEntries, relativeQueryPath } from "./file-query";
import { WorkspacePathError, createWorkspacePathGuard } from "./path-guard";
import { createCommandOutputStore } from "./command-output";
import { MAX_EDITABLE_FILE_BYTES as FILE_LIMIT } from "../shared/file-limits";

const CACHE_LIMIT = 16 * 1024 * 1024;
const RESULT_LIMIT = 128 * 1024;
const ENTRY_LIMIT = 1000;
const DEPTH_LIMIT = 8;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const pathSchema = z.string().min(1).max(4096);
const textSchema = z.string().max(2 * 1024 * 1024);
const commandSchema = z
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
const argumentsSchema = z.discriminatedUnion("tool", [
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
      limit: z.number().int().min(1).max(200).default(100),
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
  z.object({ tool: z.literal("read_command_output"), id: z.string().uuid(),
    stream: z.enum(["stdout", "stderr"]).default("stdout"),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(12000).default(12000),
  }).strict(),
  z.object({ tool: z.literal("git_status"), ...noArgumentFields }).strict(),
  z.object({ tool: z.literal("git_diff"), ...noArgumentFields }).strict(),
  z.object({ tool: z.literal("git_log"), ...noArgumentFields }).strict(),
  z
    .object({
      tool: z.literal("search_files"),
      query: z.string().min(1).max(1024),
      path: pathSchema.default("."),
      ...queryPageSchema,
      limit: z.number().int().min(1).max(100).default(100),
      mode: z.enum(["content", "files", "count"]).default("content"),
      case_sensitive: z.boolean().default(true),
      regex: z.boolean().default(false),
      context_lines: z.number().int().min(0).max(3).default(0),
    })
    .strict()
    .readonly()
    .unwrap(),
]);
const fileBoundaries =
  "Workspace-relative only; no symlinks or sensitive files (.env*, credentials, private keys, .ssh, .config, .git). Files at most 16 MiB; generate large files in small chunks. ";
const policies = `${fileBoundaries}Readonly forbids mutations and commands. `;
const writePolicies = `${fileBoundaries}Readonly forbids mutations. `;
const toolDescriptions: Readonly<Record<z.infer<typeof argumentsSchema>["tool"], string>> = {
  "git_status": "Read-only repository status. Sensitive paths omitted; secrets redacted; no shell execution.",
  "git_diff": "Read-only unstaged repository diff. Sensitive paths omitted; secrets redacted; no shell execution.",
  "git_log": "Read-only recent repository log. Secrets redacted; no shell execution.",
  "list_files": `${policies}List paginated entries; optional root-relative glob (*, **, ?). Bounded traversal (1000 entries, 8 levels); dependency/build/cache directories excluded. scan_truncated marks incomplete traversal, truncated remaining page results.`,
  "read_file": `${policies}Numbered UTF-8 pages with zero-based offset, SHA-256 version, byte size, inclusive end_line and cache status. Matching if_version returns unchanged:true without content or new write authority. A nonempty page authorizes write/edit in this run; own successful writes refresh that version, external changes require a new read. Binary rejected; output bounded.`,
  "write_file": `Default tool for creating files or replacing complete content. No append or expected_bytes input; use append_file for chunks and edit_file for targeted edits. Overwriting requires read_file of the current version in this run; new files need no read. Own successful writes refresh read authority. Unchanged content is a no-op. Returns size_bytes and a bounded display diff patch. Atomic writes use restorable checkpoints when a checkpoint store is configured; restore uses checkpoints, not the patch. Create missing parents with make_directory. ${writePolicies}`,
  "append_file": `Append a small chunk (prefer <=16000 characters). Pass expected_bytes from the last successful write/read, or 0 for a new file. A mismatched byte size fails without appending; never blindly replay a chunk. Existing files require read_file in this run or a successful own write. Returns size_bytes for the next chunk and a bounded display diff patch. Atomic writes use restorable checkpoints when a checkpoint store is configured; restore uses checkpoints, not the patch. Create missing parents with make_directory. ${writePolicies}`,
  "edit_file": `Default tool for targeted file edits instead of command scripts. Atomically replace literal old_text (nonempty); exactly one occurrence is required unless replace_all is true. Read the current version with read_file in this run first. Own writes refresh authority; external changes or a new run require reading again. Identical replacement is a no-op. Edits use restorable checkpoints when a checkpoint store is configured; the bounded display diff patch is separate. ${writePolicies}`,
  "make_directory": `${policies}Create directories recursively without traversing symlinks. Existing directories are accepted.`,
  "run_command": "Run builds, tests, git and package managers with explicit argv (no implicit shell). For authored files use write_file/edit_file; command effects are not checkpointed. Readonly denied; workspace requests per-call approval under the host policy. NOT an OS sandbox; cwd is guarded. Minimal environment; HOME is the host user's home. Choose and pass timeout_ms: maximum 30 minutes (1800000 ms), no default; allow enough time for builds/tests. Output never terminates a command: private logs retain up to 16 MiB/command and 128 MiB/run, then stop capture. Results show 12000 characters/stream; read_command_output pages the redacted log during this run. Encoded result cap 128 KiB. Cancellation waits for process close.",
  "read_command_output": "Read a completed command's redacted log without rerunning it. IDs belong to this session/run; logs expire at run end. Offset and limit are UTF-16 characters, not bytes. Readonly permitted.",
  "search_files": `${policies}Literal search by default; optional bounded regex, root-relative glob (*, **, ?), context and pagination. Modes return line matches, files or per-file matching-line counts in matches. Traversal capped at 1000 entries/8 levels; binary/oversize/sensitive files skipped. scan_truncated marks incomplete scan, truncated remaining page results.`,
};
const definitions: readonly ToolDefinition[] = argumentsSchema.options.map(schema => {
  const { tool, ...fields } = schema.shape;
  const name = tool.value;
  return defineTool(name, toolDescriptions[name], z.object(fields).strict(), name === "write_file" ? ["append", "expected_bytes"] : []);
});

function fail(message: string, code: "tool" | "invalid_input" = "tool"): never {
  throw new ForgeError(code, message);
}
function check(signal: AbortSignal): void {
  if (signal.aborted)
    throw new ForgeError("cancelled", "Tool execution cancelled.");
}
function sensitive(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (part) =>
        /^(?:\.env.*|\.ssh|\.config|\.git|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(
          part,
        ) ||
        /credentials/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}
function secretText(text: string): boolean {
  return (
    /^\s*-----BEGIN [A-Z ]*PRIVATE KEY-----/m.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/.test(
      text,
    ) ||
    /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*(?:[A-Za-z0-9_-]{8,}|"[A-Za-z0-9_-]{8,}"|'[A-Za-z0-9_-]{8,}')\s*$/im.test(
      text,
    )
  );
}
function signature(info: Awaited<ReturnType<typeof lstat>>): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
function result(
  value: JsonValue,
  isError = false,
  changes?: readonly FileChange[],
): ToolResult {
  return {
    content: JSON.stringify(value),
    isError,
    ...(changes === undefined ? {} : { changes }),
  };
}
function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return undefined;
}
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new ForgeError("cancelled", "Tool execution cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export interface LocalToolOptions {
  readonly protectedRoots?: readonly string[];
  readonly redactValues?: readonly string[];
  readonly checkpointStore?: CheckpointStore;
}
const optionsSchema = z
  .object({
    protectedRoots: z.array(z.string()).readonly().optional(),
    redactValues: z.array(z.string()).readonly().optional(),
    checkpointStore: z.custom<CheckpointStore>().optional(),
  })
  .strict()
  .readonly();

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
  const cache = new Map<
    string,
    Readonly<{ signature: string; text: string; bytes: number }>
  >();
  // Model-visible reads and successful own writes authorize the current version.
  // Keep receipts separate from the internal read/search cache and session-scoped.
  const readReceipts = new Map<string, string>();
  function receiptKey(sessionId: string, path: string): string {
    return JSON.stringify([sessionId, path]);
  }
  function requireRead(sessionId: string, path: string, stamp: string): void {
    const receipt = readReceipts.get(receiptKey(sessionId, path));
    if (receipt === undefined)
      fail("Read the current file with read_file in this run before writing or editing. Previous-run reads do not carry write authority. Omit if_version so content is returned.");
    if (receipt !== stamp)
      fail("File changed since read_file in this run. Read the current file again without if_version before writing or editing.");
  }
  let cacheBytes = 0;
  let disposal: Promise<void> | undefined;
  let writeTail: Promise<void> = Promise.resolve();
  function containsKnown(text: string): boolean {
    return known.some((value) => text.includes(value));
  }
  function redact(text: string): string {
    let clean = text;
    for (const value of known) clean = clean.split(value).join("[REDACTED]");
    if (secretText(clean)) return "[Sensitive output withheld]";
    return clean;
  }
  function safeText(text: string): void {
    if (Buffer.byteLength(text, "utf8") > FILE_LIMIT)
      fail("File exceeds the 16 MiB ceiling. Split it into separate files; retrying the same content cannot succeed.");
    if (text.includes("\0") || containsKnown(text) || secretText(text))
      fail("Binary or sensitive content is not permitted.");
  }
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
          sensitive(local) ||
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
  function invalidate(path: string): void {
    const entry = cache.get(path);
    if (entry) cacheBytes -= entry.bytes;
    cache.delete(path);
  }
  function remember(path: string, stamp: string, text: string): void {
    invalidate(path);
    const bytes = text.length * 2;
    while (cacheBytes + bytes > CACHE_LIMIT || cache.size >= 256) {
      const first = cache.keys().next();
      if (first.done) break;
      invalidate(first.value);
    }
    cache.set(path, { signature: stamp, text, bytes });
    cacheBytes += bytes;
  }
  function targetName(path: string): string {
    const name = relative(guard.root, path).split(sep).join("/") || ".";
    if (sensitive(name) || containsKnown(name))
      fail("Sensitive paths are not permitted.");
    return name;
  }
  async function readTarget(
    path: string,
    signal: AbortSignal,
  ): Promise<Readonly<{ text: string; cacheHit: boolean; stamp: string }>> {
    check(signal);
    targetName(path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      fail("Expected a regular non-symlink file.");
    if (info.size > FILE_LIMIT) fail("File exceeds the 16 MiB ceiling. Split it into separate files.");
    const stamp = signature(info);
    const cached = cache.get(path);
    if (cached?.signature === stamp) {
      cache.delete(path);
      cache.set(path, cached);
      return { text: cached.text, cacheHit: true, stamp };
    }
    invalidate(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || signature(opened) !== stamp)
        fail("File changed while opening; retry.");
      const buffer = Buffer.alloc(FILE_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        check(signal);
        const chunk = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (chunk.bytesRead === 0) break;
        length += chunk.bytesRead;
      }
      if (length > FILE_LIMIT) fail("File exceeds the 16 MiB ceiling. Split it into separate files.");
      if (signature(await handle.stat()) !== stamp)
        fail("File changed while reading; retry.");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        );
      } catch {
        return fail("File is not UTF-8 text.");
      }
      safeText(text);
      remember(path, stamp, text);
      return { text, cacheHit: false, stamp };
    } finally {
      await handle.close();
    }
  }
  async function read(relativePath: string, signal: AbortSignal) {
    if (sensitive(relativePath)) fail("Sensitive paths are not permitted.");
    const path = await guard.resolveRead(relativePath);
    targetName(path);
    return { path, ...(await readTarget(path, signal)) };
  }
  async function serialized<T>(action: () => Promise<T>): Promise<T> {
    const prior = writeTail;
    let release: () => void = () => undefined;
    writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
  async function commit(
    relativePath: string,
    text: string,
    signal: AbortSignal,
    expected?: string,
    toolCallId?: string,
    sessionId?: string,
  ): Promise<readonly FileChange[]> {
    safeText(text);
    if (sensitive(relativePath)) fail("Sensitive paths are not permitted.");
    const path = await guard.resolveWrite(relativePath);
    const name = targetName(path);
    const parent = dirname(path);
    const parentRelative = relative(guard.root, parent) || ".";
    await guard.resolveRead(parentRelative);
    const parentStamp = await lstat(parent);
    let before: string | null = null;
    let beforeStamp: string | undefined;
    let beforeMode: number | null = null;
    try {
      const original = await readTarget(path, signal);
      before = original.text;
      beforeStamp = original.stamp;
      beforeMode = (await lstat(path)).mode & 0o7777;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (beforeStamp !== undefined) {
      if (!sessionId) fail("Session identity is required for file writes.");
      requireRead(sessionId, path, beforeStamp);
    }
    if (expected !== undefined && expected !== beforeStamp)
      fail("File changed before editing; read_file again and retry.");
    check(signal);
    if (before === text) return [];
    // Compute on complete originals before mutation, not truncated display previews.
    // The shared generator reports budget exhaustion without inventing a rewrite.
    const patch = createDiffPatch(before ?? "", text);
    const temporary = join(parent, `.forge-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let renamed = false;
    let checkpoint: Awaited<ReturnType<CheckpointStore["begin"]>> | undefined;
    try {
      await handle.writeFile(text, "utf8");
      if (beforeMode !== null) await handle.chmod(beforeMode);
      await handle.sync();
      const written = await handle.stat();
      await handle.close();
      await guard.resolveRead(parentRelative);
      const currentParent = await lstat(parent);
      if (
        currentParent.dev !== parentStamp.dev ||
        currentParent.ino !== parentStamp.ino
      )
        fail("Parent directory changed; retry.");
      if ((await guard.resolveWrite(relativePath)) !== path)
        fail("Target changed; retry.");
      let currentStamp: string | undefined;
      try {
        currentStamp = signature(await lstat(path));
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (currentStamp !== beforeStamp)
        fail("File changed before commit; retry.");
      check(signal);
      if (options.checkpointStore) {
        if (!sessionId || !toolCallId) fail("Checkpoint identity is required.");
        checkpoint = await options.checkpointStore.begin({
          path: name,
          sessionId,
          toolCallId,
          before: before === null ? null : Buffer.from(before, "utf8"),
          beforeMode,
          after: Buffer.from(text, "utf8"),
          signal,
        });
      }
      check(signal);
      await rename(temporary, path);
      renamed = true;
      if (sessionId) {
        const current = await lstat(path);
        const key = receiptKey(sessionId, path);
        if (current.ino === written.ino && current.dev === written.dev &&
            current.size === written.size && current.mtimeMs === written.mtimeMs) {
          readReceipts.set(key, signature(current));
        } else readReceipts.delete(key);
      }
      invalidate(path);
      await checkpoint?.complete();
      return [
        {
          path: name,
          kind: before === null ? "created" : "modified",
          patch,
        },
      ];
    } finally {
      await handle.close();
      if (!renamed) await unlink(temporary);
      await checkpoint?.release();
    }
  }
  async function serializedFile<T>(path: string, sessionId: string, action: () => Promise<T>): Promise<T> {
    const resolved = await guard.resolveWrite(path);
    const key = receiptKey(sessionId, resolved);
    const admitted = readReceipts.get(key);
    return serialized(async () => {
      if (readReceipts.get(key) !== admitted)
        fail("File changed while this edit was queued; read_file again before editing.");
      return action();
    });
  }
  async function directories(
    relativePath: string,
    signal: AbortSignal,
  ): Promise<string> {
    check(signal);
    if (sensitive(relativePath)) fail("Sensitive paths are not permitted.");
    if (relativePath.includes("\\") && sep !== "\\")
      fail("Backslash paths are not supported.");
    // The guard parses the entire lexical spelling before inspecting any entry.
    // Missing parents are expected here; all other failures must precede mkdir.
    try {
      await guard.resolveRead(relativePath);
    } catch (error: unknown) {
      if (!(error instanceof WorkspacePathError) || error.code !== "MISSING")
        throw error;
    }
    const parts = relativePath.split(/[\\/]/);
    let current = ".";
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      current = `${current}/${part}`;
      check(signal);
      try {
        const existing = await guard.resolveRead(current);
        targetName(existing);
        if (!(await lstat(existing)).isDirectory())
          fail("Expected a directory.");
      } catch (error: unknown) {
        if (!(error instanceof WorkspacePathError) || error.code !== "MISSING")
          throw error;
        const destination = await guard.resolveWrite(current);
        targetName(destination);
        check(signal);
        await mkdir(destination, { mode: 0o700 });
        await guard.resolveRead(current);
      }
    }
    return targetName(await guard.resolveRead(relativePath));
  }
  async function walk(
    relativePath: string,
    recursive: boolean,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      entries: readonly Readonly<{
        path: string;
        kind: "file" | "directory";
      }>[];
      truncated: boolean;
    }>
  > {
    if (sensitive(relativePath)) fail("Sensitive paths are not permitted.");
    const start = await guard.resolveRead(relativePath);
    targetName(start);
    const entries: {
      readonly path: string;
      readonly kind: "file" | "directory";
    }[] = [];
    let truncated = false;
    let visited = 0;
    const excluded = new Set([
      "node_modules",
      ".git",
      ".build",
      "dist",
      "cache",
      ".cache",
    ]);
    async function visit(path: string, depth: number): Promise<void> {
      check(signal);
      const name = targetName(path);
      await guard.resolveRead(name);
      const info = await lstat(path);
      if (info.isFile()) {
        if (entries.length >= ENTRY_LIMIT) {
          truncated = true;
          return;
        }
        entries.push({ path: name, kind: "file" });
        return;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      const { opendir } = await import("node:fs/promises");
      const directory = await opendir(path);
      for await (const item of directory) {
        check(signal);
        visited += 1;
        if (visited > ENTRY_LIMIT || entries.length >= ENTRY_LIMIT) {
          truncated = true;
          break;
        }
        if (
          excluded.has(item.name) ||
          sensitive(item.name) ||
          containsKnown(item.name) ||
          item.isSymbolicLink()
        )
          continue;
        const child = join(path, item.name);
        if (guard.isProtected(child)) continue;
        const childName = targetName(child);
        if (item.isDirectory()) {
          entries.push({ path: childName, kind: "directory" });
          if (recursive && depth < DEPTH_LIMIT) await visit(child, depth + 1);
          else if (recursive) truncated = true;
        } else if (item.isFile())
          entries.push({ path: childName, kind: "file" });
      }
    }
    await visit(start, 0);
    return { entries, truncated };
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
    if (sensitive(args.cwd)) fail("Sensitive paths are not permitted.");
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
        try { context.onCommandStarted?.(); } catch { /* Observers cannot fail execution. */ }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        log.capture("stdout", chunk);
        try { context.onCommandOutput?.("stdout", chunk.toString("utf8")); } catch { /* Observer only. */ }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        log.capture("stderr", chunk);
        try { context.onCommandOutput?.("stderr", chunk.toString("utf8")); } catch { /* Observer only. */ }
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
          void log.discard().then(() => reject(new ForgeError("cancelled", "Tool execution cancelled.")), reject);
          return;
        }
        void log.finish().then((output) => {
          let out = output.stdout;
          let err = output.stderr;
          let previewTruncated = output.preview_truncated;
          const encode = () => result({ ...output, stdout: out, stderr: err,
            preview_truncated: previewTruncated, exit_code: exitCode, signal: exitSignal,
            duration_ms: Date.now() - started, timed_out: timedOut, spawn_failed: spawnFailed,
          }, timedOut || spawnFailed || exitCode !== 0);
          let encoded = encode();
          while (Buffer.byteLength(encoded.content, "utf8") >= RESULT_LIMIT) {
            previewTruncated = true;
            if (out.length >= err.length) out = out.slice(0, Math.floor(out.length / 2));
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
          return result(await commandOutput.read(context.sessionId, args.id, args.stream, args.offset, args.limit));
        case "read_file": {
          const file = await read(args.path, signal);
          const lines = file.text.split("\n");
          const version = createHash("sha256").update(file.text).digest("hex");
          if (args.if_version !== undefined && /^[a-f\d]{64}$/i.test(args.if_version) &&
              args.if_version.toLowerCase() === version) {
            check(signal);
            // A SHA is not proof that this session has seen a model-visible page.
            return result({
              path: targetName(file.path), version, unchanged: true,
              size_bytes: Buffer.byteLength(file.text, "utf8"), lines_returned: 0,
              offset: args.offset, end_line: null, next_offset: null,
              total_lines: lines.length, truncated: false, partial_line: false,
              cache_hit: file.cacheHit,
            });
          }
          const selected: string[] = [];
          let characters = 0;
          let index = args.offset;
          let partial = false;
          while (index < lines.length && selected.length < args.limit) {
            const line = lines[index];
            if (line === undefined) break;
            const numbered = `${index + 1}: ${line}`;
            if (characters + numbered.length > 12000) {
              if (selected.length === 0) {
                selected.push(numbered.slice(0, 12000));
                partial = true;
                index += 1;
              }
              break;
            }
            selected.push(numbered);
            characters += numbered.length + 1;
            index += 1;
          }
          check(signal);
          if (selected.length > 0) {
            const key = receiptKey(context.sessionId, file.path);
            readReceipts.delete(key);
            if (readReceipts.size >= 4096) {
              const first = readReceipts.keys().next();
              if (!first.done) readReceipts.delete(first.value);
            }
            readReceipts.set(key, file.stamp);
          }
          return result({
            path: targetName(file.path),
            content: selected.join("\n"),
            version,
            end_line: selected.length > 0 ? index : null,
            size_bytes: Buffer.byteLength(file.text, "utf8"),
            lines_returned: selected.length,
            offset: args.offset,
            next_offset: index < lines.length ? index : null,
            total_lines: lines.length,
            truncated: partial || index < lines.length,
            partial_line: partial,
            cache_hit: file.cacheHit,
          });
        }
        case "list_files": {
          const accept = globMatcher(args.glob);
          const listing = await walk(args.path, args.recursive, signal);
          const root = targetName(await guard.resolveRead(args.path));
          const filtered = listing.entries.filter(entry =>
            accept(relativeQueryPath(root, entry.path))).sort((a, b) => a.path.localeCompare(b.path));
          return result({
            ...pageEntries(filtered, args.offset, args.limit),
            scan_truncated: listing.truncated,
          });
        }
        case "append_file":
        case "write_file":
          return await serializedFile(args.path, context.sessionId, async () => {
            let content = args.content;
            if (args.tool === "append_file" || args.append) {
              if (args.expected_bytes === undefined)
                fail("Append requires expected_bytes from the last write/read (0 for a new file); do not blindly replay an append.", "invalid_input");
              let previous = "";
              try { previous = (await read(args.path, signal)).text; }
              catch (error) {
                if (!(error instanceof WorkspacePathError && error.code === "MISSING") && errorCode(error) !== "ENOENT") throw error;
              }
              if (Buffer.byteLength(previous, "utf8") !== args.expected_bytes)
                fail("Append offset differs from current file size; inspect with read_file before continuing. No content was appended.");
              content = previous + args.content;
            } else if (args.expected_bytes !== undefined) {
              fail("write_file replacement does not accept expected_bytes. Remove it, or use append_file with expected_bytes to append a chunk.", "invalid_input");
            }
            const changes = await commit(
              args.path,
              content,
              signal,
              undefined,
              call.id,
              context.sessionId,
            );
            return result(
              { written: changes.length > 0, unchanged: changes.length === 0, size_bytes: Buffer.byteLength(content, "utf8") },
              false,
              changes,
            );
          });
        case "edit_file":
          return await serializedFile(args.path, context.sessionId, async () => {
            const original = await read(args.path, signal);
            requireRead(context.sessionId, original.path, original.stamp);
            const pieces = original.text.split(args.old_text);
            const count = pieces.length - 1;
            if (count === 0) fail("old_text was not found.");
            if (!args.replace_all && count !== 1)
              fail("old_text is ambiguous; use replace_all explicitly.");
            const changes = await commit(
              args.path,
              pieces.join(args.new_text),
              signal,
              original.stamp,
              call.id,
              context.sessionId,
            );
            return result(
              {
                edited: changes.length > 0,
                unchanged: changes.length === 0,
                replacements: changes.length > 0 ? count : 0,
              },
              false,
              changes,
            );
          });
        case "make_directory":
          return await serialized(async () =>
            result({
              path: await directories(args.path, signal),
              created: true,
            }),
          );
        case "git_status":
        case "git_diff":
        case "git_log": {
          const inspection = await gitInspect(
            guard.root,
            args.tool.slice(4) as "status" | "diff" | "log",
            signal,
            known,
            options.protectedRoots,
          );
          return result({ source: "git", ...inspection });
        }
        case "run_command":
          return await command(args, context, signal);
        case "search_files": {
          const accept = globMatcher(args.glob);
          const listing = await walk(args.path, true, signal);
          const root = targetName(await guard.resolveRead(args.path));
          const candidates = listing.entries.filter(entry => entry.kind === "file" &&
            accept(relativeQueryPath(root, entry.path))).sort((a, b) => a.path.localeCompare(b.path));
          const matcher = createLineMatcher(args.query, args.regex, args.case_sensitive, signal);
          const matches: JsonValue[] = [];
          let seen = 0;
          let length = 0;
          let more = false;
          let scanTruncated = listing.truncated;
          let skippedFiles = 0;
          try {
            for (const [fileIndex, entry] of candidates.entries()) {
              check(signal);
              let text: string;
              try { text = (await read(entry.path, signal)).text; }
              catch (error: unknown) {
                if (error instanceof ForgeError && error.code === "cancelled") throw error;
                skippedFiles += 1;
                continue;
              }
              const content = args.mode === "content";
              const found = await matcher.find(text, content ? Math.max(0, args.offset - seen) : 0,
                content ? args.limit - matches.length + 1 : args.mode === "files" ? 1 : 0,
                args.mode === "files");
              const lines = content ? text.split("\n") : [];
              const values: JsonValue[] = content ? found.hits.map(({ index, column }) => {
                const line = lines[index] ?? "";
                const start = Math.max(0, column - 80);
                return {
                  path: entry.path, line: index + 1, column: column + 1,
                  excerpt: line.slice(start, column + 240),
                  excerpt_truncated: start > 0 || column + 240 < line.length,
                  ...(args.context_lines === 0 ? {} : {
                    context: lines.slice(Math.max(0, index - args.context_lines), index + args.context_lines + 1)
                      .map((value, offset) => ({ line: Math.max(0, index - args.context_lines) + offset + 1,
                        text: value.slice(0, 320), truncated: value.length > 320 })),
                  }),
                };
              }) : found.count > 0 ? [args.mode === "files" ? { path: entry.path }
                : { path: entry.path, count: found.count }] : [];
              if (content) seen += found.count;
              for (const value of values) {
                if (!content && seen++ < args.offset) continue;
                if (matches.length >= args.limit || length + JSON.stringify(value).length > 90000) {
                  more = true;
                  break;
                }
                length += JSON.stringify(value).length;
                matches.push(value);
              }
              if (more) {
                scanTruncated ||= !found.complete || fileIndex < candidates.length - 1;
                break;
              }
            }
          } finally { await matcher.dispose(); }
          return result({ matches, mode: args.mode, offset: args.offset,
            next_offset: more ? args.offset + matches.length : null,
            truncated: more, scan_truncated: scanTruncated, skipped_files: skippedFiles });
        }
        default: {
          const unreachable: never = args;
          return unreachable;
        }
      }
    } catch (error: unknown) {
      check(signal);
      if (error instanceof z.ZodError)
        return result({ code: "invalid_input", error: redact(formatValidationError(error)) }, true);
      if (error instanceof SyntaxError)
        return result({ code: "invalid_input", error: "Tool arguments must be valid JSON. Fix the JSON syntax before retrying." }, true);
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
    isConcurrencySafe: (call: ToolCall) => ["read_file", "list_files", "search_files", "read_command_output", "git_status", "git_diff", "git_log"].includes(call.function.name),
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
        cache.clear();
        readReceipts.clear();
        cacheBytes = 0;
        await commandOutput.dispose();
      });
      return disposal;
    },
  });
}
