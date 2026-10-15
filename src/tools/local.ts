import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import type {
  FileChange,
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../shared/schemas";
import type { CheckpointStore } from "../store/checkpoints";
import { gitInspect } from "./git";
import { WorkspacePathError, createWorkspacePathGuard } from "./path-guard";

const FILE_LIMIT = 2 * 1024 * 1024;
const CACHE_LIMIT = 16 * 1024 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const RESULT_LIMIT = 128 * 1024;
const PREVIEW_LIMIT = 8192;
const ENTRY_LIMIT = 1000;
const DEPTH_LIMIT = 8;
const pathSchema = z.string().min(1).max(4096);
const textSchema = z.string().max(FILE_LIMIT);
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
    timeout_ms: z.number().int().min(1).max(120000).default(30000),
  })
  .strict()
  .readonly();
const argumentsSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("list_files"),
      path: pathSchema.default("."),
      recursive: z.boolean().default(false),
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
    })
    .strict()
    .readonly()
    .unwrap(),
  z
    .object({
      tool: z.literal("write_file"),
      path: pathSchema,
      content: textSchema,
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
  z.object({ tool: z.literal("git_status") }).strict(),
  z.object({ tool: z.literal("git_diff") }).strict(),
  z.object({ tool: z.literal("git_log") }).strict(),
  z
    .object({
      tool: z.literal("search_files"),
      query: z.string().min(1).max(1024),
      path: pathSchema.default("."),
    })
    .strict()
    .readonly()
    .unwrap(),
]);
const stringParameter = {
  type: "string",
  minLength: 1,
  maxLength: 4096,
} as const;
function definition(
  name: string,
  description: string,
  properties: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
): ToolDefinition {
  return Object.freeze({
    type: "function",
    function: Object.freeze({
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    }),
  });
}
const fileBoundaries =
  "Workspace-relative only; no symlinks or sensitive files (.env*, credentials, private keys, .ssh, .config, .git). Files at most 2 MiB. ";
const policies = `${fileBoundaries}Readonly forbids mutations and commands. `;
const writePolicies = `${fileBoundaries}Readonly forbids mutations. `;
const definitions: readonly ToolDefinition[] = Object.freeze([
  definition(
    "git_status",
    "Read-only repository status. Sensitive paths omitted; secrets redacted; no shell execution.",
    {},
    [],
  ),
  definition(
    "git_diff",
    "Read-only unstaged repository diff. Sensitive paths omitted; secrets redacted; no shell execution.",
    {},
    [],
  ),
  definition(
    "git_log",
    "Read-only recent repository log. Secrets redacted; no shell execution.",
    {},
    [],
  ),
  definition(
    "list_files",
    `${policies}List at most 1000 entries; recursive traversal at most 8 levels. Excludes dependency/build/cache directories.`,
    {
      path: { ...stringParameter, default: "." },
      recursive: { type: "boolean", default: false },
    },
    [],
  ),
  definition(
    "read_file",
    `${policies}Read UTF-8 text with 1-based line numbers, zero-based line offset, up to 200 lines and 12000 characters. Returns pagination, explicit truncation, SHA-256 version, byte size, lines returned and LRU cache hit status. A successful nonempty page authorizes write/edit of this version in this session; read again after a write or external change. Binary/oversize files rejected.`,
    {
      path: stringParameter,
      offset: { type: "integer", minimum: 0, maximum: FILE_LIMIT, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
    },
    ["path"],
  ),
  definition(
    "write_file",
    `Default tool for creating files or replacing their complete content; use edit_file for targeted changes, not run_command scripts or redirection. Overwriting requires a prior read_file of the current version in this session; new files need no read. Unchanged content is a no-op. Atomic writes use restorable checkpoints when a checkpoint store is configured. Returns bounded before/after previews; restore uses checkpoints, not previews. Fails if the parent directory does not exist (create it with make_directory). ${writePolicies}`,
    {
      path: stringParameter,
      content: { type: "string", maxLength: FILE_LIMIT },
    },
    ["path", "content"],
  ),
  definition(
    "edit_file",
    `Default tool for targeted file edits instead of shell, node/python or sed scripts. Atomically replace literal old_text (nonempty); exactly one occurrence is required unless replace_all is true. A prior read_file of the current version in this session is required; read again after each write or external change. Identical replacement is a no-op. Edits use restorable checkpoints when a checkpoint store is configured; bounded before/after previews are separate from checkpoint backups. ${writePolicies}`,
    {
      path: stringParameter,
      old_text: { type: "string", minLength: 1, maxLength: FILE_LIMIT },
      new_text: { type: "string", maxLength: FILE_LIMIT },
      replace_all: { type: "boolean", default: false },
    },
    ["path", "old_text", "new_text"],
  ),
  definition(
    "make_directory",
    `${policies}Create directories recursively without traversing symlinks. Existing directories are accepted.`,
    { path: stringParameter },
    ["path"],
  ),
  definition(
    "run_command",
    "Run builds, tests, git and package managers with explicit argv (no implicit shell; explicit shell argv allowed). For authored file content, use write_file/edit_file instead of scripts or redirection; command effects are not checkpointed. Readonly denied; workspace requests per-call approval under the host policy; unrestricted permits execution. NOT an OS sandbox: commands can access outside the workspace and network; cwd is guarded. Minimal environment without inherited credential or proxy variables; HOME is the host user's home, so commands can use local config and authentication. Timeout 30s by default, 120s maximum; combined output cap 64 KiB (overflow terminates the process group and withholds partial output); encoded result cap 128 KiB. Cancellation waits for process close.",
    {
      argv: {
        type: "array",
        minItems: 1,
        maxItems: 256,
        items: { type: "string", maxLength: 8192 },
      },
      cwd: { ...stringParameter, default: "." },
      timeout_ms: {
        type: "integer",
        minimum: 1,
        maximum: 120000,
        default: 30000,
      },
    },
    ["argv"],
  ),
  definition(
    "search_files",
    `${policies}Literal case-sensitive search, no regex/glob. At most 1000 entries, 8 levels, 100 bounded matches. Binary/oversize/sensitive files skipped.`,
    {
      query: { type: "string", minLength: 1, maxLength: 1024 },
      path: { ...stringParameter, default: "." },
    },
    ["query"],
  ),
]);

function fail(message: string): never {
  throw new ForgeError("tool", message);
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
  // Only successful, model-visible read_file calls authorize overwrites.
  // Keep receipts separate from the internal read/search cache and session-scoped.
  const readReceipts = new Map<string, string>();
  function receiptKey(sessionId: string, path: string): string {
    return JSON.stringify([sessionId, path]);
  }
  function requireRead(sessionId: string, path: string, stamp: string): void {
    if (readReceipts.get(receiptKey(sessionId, path)) !== stamp)
      fail("Read the current file with read_file in this session before writing or editing; the file may have changed since the last read.");
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
      fail("File exceeds the 2 MiB ceiling.");
    if (text.includes("\0") || containsKnown(text) || secretText(text))
      fail("Binary or sensitive content is not permitted.");
  }
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
    if (info.size > FILE_LIMIT) fail("File exceeds the 2 MiB ceiling.");
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
      if (length > FILE_LIMIT) fail("File exceeds the 2 MiB ceiling.");
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
      if (sessionId) readReceipts.delete(receiptKey(sessionId, path));
      invalidate(path);
      await checkpoint?.complete();
      return [
        {
          path: name,
          kind: before === null ? "created" : "modified",
          before: before === null ? null : before.slice(0, PREVIEW_LIMIT),
          after: text.slice(0, PREVIEW_LIMIT),
          truncated:
            (before?.length ?? 0) > PREVIEW_LIMIT ||
            text.length > PREVIEW_LIMIT,
        },
      ];
    } finally {
      await handle.close();
      if (!renamed) await unlink(temporary);
      await checkpoint?.release();
    }
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
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let truncated = false;
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
      function capture(chunks: Buffer[], chunk: Buffer): void {
        const available = Math.max(0, OUTPUT_LIMIT - bytes);
        if (available > 0) {
          const kept = Buffer.from(chunk.subarray(0, available));
          chunks.push(kept);
          bytes += kept.length;
        }
        if (chunk.length > available) {
          truncated = true;
          kill();
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
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.on("error", () => {
        spawnFailed = true;
      });
      child.on("close", (exitCode, exitSignal) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        // Descendants may have detached their output but remain in our group.
        kill();
        if (cancelled || signal.aborted) {
          reject(new ForgeError("cancelled", "Tool execution cancelled."));
          return;
        }
        let out = truncated
          ? "[Output withheld after overflow]"
          : redact(Buffer.concat(stdout).toString("utf8"));
        let err = truncated
          ? ""
          : redact(Buffer.concat(stderr).toString("utf8"));
        const encode = () =>
          result(
            {
              stdout: out,
              stderr: err,
              exit_code: exitCode,
              signal: exitSignal,
              duration_ms: Date.now() - started,
              truncated,
              timed_out: timedOut,
              spawn_failed: spawnFailed,
            },
            timedOut || truncated || spawnFailed || exitCode !== 0,
          );
        let encoded = encode();
        while (Buffer.byteLength(encoded.content, "utf8") >= RESULT_LIMIT) {
          truncated = true;
          if (out.length >= err.length)
            out = out.slice(0, Math.floor(out.length / 2));
          else err = err.slice(0, Math.floor(err.length / 2));
          encoded = encode();
        }
        resolve(encoded);
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
        args.tool === "edit_file" ||
        args.tool === "make_directory" ||
        args.tool === "run_command";
      if (mutation && context.permission === "readonly")
        fail("Readonly permission forbids this tool.");
      switch (args.tool) {
        case "read_file": {
          const file = await read(args.path, signal);
          const lines = file.text.split("\n");
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
            version: createHash("sha256").update(file.text).digest("hex"),
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
          const listing = await walk(args.path, args.recursive, signal);
          const entries: JsonValue[] = [];
          let length = 0;
          for (const entry of listing.entries) {
            length += JSON.stringify(entry).length;
            if (length > 90000) break;
            entries.push(entry);
          }
          return result({
            entries,
            truncated:
              listing.truncated || entries.length !== listing.entries.length,
          });
        }
        case "write_file":
          return await serialized(async () => {
            const changes = await commit(
              args.path,
              args.content,
              signal,
              undefined,
              call.id,
              context.sessionId,
            );
            return result(
              { written: changes.length > 0, unchanged: changes.length === 0 },
              false,
              changes,
            );
          });
        case "edit_file":
          return await serialized(async () => {
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
          const listing = await walk(args.path, true, signal);
          const matches: JsonValue[] = [];
          let truncated = listing.truncated;
          let length = 0;
          for (const entry of listing.entries) {
            check(signal);
            if (entry.kind !== "file") continue;
            let text: string;
            try {
              text = (await read(entry.path, signal)).text;
            } catch (error: unknown) {
              if (error instanceof ForgeError && error.code === "cancelled")
                throw error;
              continue;
            }
            for (const [index, line] of text.split("\n").entries()) {
              const column = line.indexOf(args.query);
              if (column < 0) continue;
              const match = {
                path: entry.path,
                line: index + 1,
                column: column + 1,
                excerpt: line.slice(Math.max(0, column - 80), column + 240),
                excerpt_truncated: line.length > 320,
              };
              length += JSON.stringify(match).length;
              if (matches.length >= 100 || length > 90000) {
                truncated = true;
                break;
              }
              matches.push(match);
            }
            if (truncated && (matches.length >= 100 || length > 90000)) break;
          }
          return result({ matches, truncated });
        }
        default: {
          const unreachable: never = args;
          return unreachable;
        }
      }
    } catch (error: unknown) {
      check(signal);
      if (error instanceof ForgeError) {
        if (error.code === "cancelled") throw error;
        return result({ error: redact(error.message) }, true);
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
      disposal = Promise.allSettled([...active]).then(() => {
        cache.clear();
        readReceipts.clear();
        cacheBytes = 0;
      });
      return disposal;
    },
  });
}
