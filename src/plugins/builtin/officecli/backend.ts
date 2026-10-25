import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { ForgeError } from "../../../shared/errors";

/**
 * Result of one stateless OfficeCLI invocation.
 *
 * `stdout` and `stderr` share one byte budget (`maxOutputBytes`). Data past the
 * budget is drained and discarded, never buffered, and `truncated` is set.
 */
export interface OfficeCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly truncated: boolean;
}

/**
 * Stateless OfficeCLI process adapter. It never starts a resident daemon,
 * MCP server, updater, or watcher; each `execute` call is one child process.
 */
export interface OfficeCliBackend {
  execute(
    args: readonly string[],
    options: {
      readonly signal: AbortSignal;
      readonly timeoutMs: number;
      readonly maxOutputBytes?: number;
    },
  ): Promise<OfficeCliResult>;
  dispose(): Promise<void>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_ARGS = 4096;
const MAX_ARG_BYTES = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1000;
const TERMINATION_JOIN_MS = 3000;
const GROUP_POLL_MS = 25;
const CLOSE_JOIN_MS = 500;

/**
 * Only these ambient variables cross into the OfficeCLI process. Everything
 * else, including credentials, provider configuration, Node options and Forge
 * state, is deliberately omitted.
 */
const HOST_ENV_KEYS = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

interface RuntimeLayout {
  readonly root: string;
  readonly home: string;
  readonly cache: string;
  readonly config: string;
  readonly data: string;
  readonly temp: string;
  readonly env: Readonly<Record<string, string>>;
}

interface ActiveOperation {
  readonly finished: Promise<void>;
  cancel(): void;
}

type TerminationReason = "timeout" | "abort" | "dispose";

const invalid = (message: string): ForgeError =>
  new ForgeError("invalid_input", message);

const cancelled = (message: string): ForgeError =>
  new ForgeError("cancelled", message);

const missingExecutable = (): ForgeError =>
  new ForgeError(
    "tool",
    "OfficeCLI executable was not found or is not executable. Check the configured executable path and PATH.",
  );

const spawnFailure = (): ForgeError =>
  new ForgeError(
    "tool",
    "OfficeCLI process could not be started. Check the configured executable, workspace and permissions; the command was not retried.",
  );

const timeoutFailure = (timeoutMs: number): ForgeError =>
  new ForgeError(
    "tool",
    `OfficeCLI command timed out after ${timeoutMs} ms and was terminated. It was not retried; document mutations may be incomplete or uncertain.`,
  );

const cancellationFailure = (): ForgeError =>
  cancelled(
    "OfficeCLI command was cancelled and terminated. It was not retried; document mutations may be incomplete or uncertain.",
  );

const disposeFailure = (): ForgeError =>
  cancelled(
    "OfficeCLI backend is shutting down; the command was cancelled and was not replayed. Document mutations may be incomplete or uncertain.",
  );

function requirePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    value.includes("\0")
  )
    throw invalid(`${field} must be a nonempty path string.`);
  return value;
}

function validateArgs(args: readonly string[]): readonly string[] {
  if (!Array.isArray(args))
    throw invalid("OfficeCLI arguments must be an array.");
  if (args.length > MAX_ARGS)
    throw invalid(`OfficeCLI arguments exceed the ${MAX_ARGS} argument limit.`);
  let bytes = 0;
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0"))
      throw invalid("OfficeCLI arguments must be NUL-free strings.");
    bytes += Buffer.byteLength(arg, "utf8");
    if (bytes > MAX_ARG_BYTES)
      throw invalid(
        `OfficeCLI arguments exceed the ${MAX_ARG_BYTES} byte limit.`,
      );
  }
  return args;
}

function validateOptions(options: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
}): {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
} {
  if (typeof options !== "object" || options === null)
    throw invalid("OfficeCLI execution options are required.");
  const { signal, timeoutMs, maxOutputBytes } = options;
  if (
    !signal ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function"
  )
    throw invalid("OfficeCLI execution requires an AbortSignal.");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw invalid(
      `OfficeCLI timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
    );
  if (
    maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      maxOutputBytes > MAX_OUTPUT_BYTES)
  )
    throw invalid(
      `OfficeCLI maxOutputBytes must be an integer between 1 and ${MAX_OUTPUT_BYTES}.`,
    );
  return {
    signal,
    timeoutMs,
    maxOutputBytes: maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

function hasPathSeparator(value: string): boolean {
  return (
    value.includes("/") ||
    (process.platform === "win32" && value.includes("\\"))
  );
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(
  executable: string,
  pathExt: string | undefined,
): readonly string[] {
  if (process.platform !== "win32") return [""];
  const extensions = (pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const lower = executable.toLowerCase();
  return [
    "",
    ...extensions.filter((item) => !lower.endsWith(item.toLowerCase())),
  ];
}

async function resolveExecutable(
  configured: string,
  workspace: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  if (isAbsolute(configured)) {
    if (await isExecutableFile(configured)) return configured;
    throw missingExecutable();
  }

  if (hasPathSeparator(configured)) {
    const candidate = resolve(workspace, configured);
    if (await isExecutableFile(candidate)) return candidate;
    throw missingExecutable();
  }

  const seen = new Set<string>();
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    // Empty PATH entries would imply the current directory. Skip them so
    // resolution depends only on the explicit workspace and PATH values.
    if (!entry) continue;
    const base = isAbsolute(entry) ? entry : resolve(workspace, entry);
    for (const extension of windowsExtensions(configured, env.PATHEXT)) {
      const candidate = join(base, `${configured}${extension}`);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  throw missingExecutable();
}

function privateEnvironment(
  home: string,
  cache: string,
  config: string,
  data: string,
  temp: string,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return Object.freeze({
    ...env,
    HOME: home,
    USERPROFILE: home,
    // Linux/macOS XDG special folders and Windows roaming/local app data all
    // point into this run's private tree, never the user's real profile.
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    APPDATA: config,
    LOCALAPPDATA: data,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    // Every command otherwise auto-starts a resident that defers disk writes.
    // Direct mode gives each stateless run a synchronous open/save lifecycle.
    OFFICECLI_NO_AUTO_RESIDENT: "1",
    // The documented per-invocation opt-out for the daily background update
    // check. Keep version chatter and network access out of tool output.
    OFFICECLI_SKIP_UPDATE: "1",
  });
}

async function createLayout(homeInput: string): Promise<RuntimeLayout> {
  const homeBase = resolve(homeInput);
  let root: string | undefined;
  try {
    await mkdir(homeBase, { recursive: true, mode: 0o700 });
    root = await mkdtemp(join(homeBase, "officecli-"));
    const home = join(root, "home");
    const cache = join(root, "cache");
    const config = join(root, "config");
    const data = join(root, "data");
    const temp = join(root, "tmp");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(cache, { recursive: true, mode: 0o700 }),
      mkdir(config, { recursive: true, mode: 0o700 }),
      mkdir(data, { recursive: true, mode: 0o700 }),
      mkdir(temp, { recursive: true, mode: 0o700 }),
    ]);
    return {
      root,
      home,
      cache,
      config,
      data,
      temp,
      env: privateEnvironment(home, cache, config, data, temp),
    };
  } catch (error) {
    if (root)
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      "tool",
      "Could not create the OfficeCLI private runtime directory inside the configured home.",
    );
  }
}

/** Bounded collector shared by stdout and stderr, decoded as UTF-8 at close. */
class BoundedOutput {
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private used = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  push(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (!chunk.length) return;
    const remaining = this.limit - this.used;
    if (remaining <= 0) {
      this.overflowed = true;
      return;
    }
    // Keep whole bytes only. Byte-level cutoffs can split a multibyte UTF-8
    // sequence; Buffer#toString replaces the incomplete tail, which is safe.
    const kept =
      chunk.length <= remaining
        ? chunk
        : Buffer.from(chunk.subarray(0, remaining));
    (stream === "stdout" ? this.stdoutChunks : this.stderrChunks).push(kept);
    this.used += kept.length;
    if (kept.length < chunk.length) this.overflowed = true;
  }

  get truncated(): boolean {
    return this.overflowed;
  }

  stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }

  stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the process group is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between close and the signal.
  }
}

function ownedGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * After the group leader is signaled, a descendant can ignore SIGTERM while
 * the leader exits, so `close` alone is not proof the owned group is gone.
 * Escalate to SIGKILL at the grace boundary and poll the group until it is
 * absent, bounded so a truly unkillable process cannot wedge disposal.
 */
async function waitForOwnedGroupExit(
  child: ChildProcess,
  graceMs: number,
  timeoutMs: number,
): Promise<void> {
  const pid = child.pid;
  if (process.platform === "win32" || pid === undefined) return;
  const started = Date.now();
  let escalated = false;
  for (;;) {
    if (!ownedGroupAlive(pid)) return;
    if (!escalated && Date.now() - started >= graceMs) {
      escalated = true;
      signalProcess(child, "SIGKILL");
    }
    if (Date.now() - started >= timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class Backend implements OfficeCliBackend {
  private readonly active = new Set<ActiveOperation>();
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly executablePath: string,
    private readonly workspace: string,
    private readonly layout: RuntimeLayout,
  ) {}

  async execute(
    argsInput: readonly string[],
    optionsInput: {
      readonly signal: AbortSignal;
      readonly timeoutMs: number;
      readonly maxOutputBytes?: number;
    },
  ): Promise<OfficeCliResult> {
    if (this.disposed) throw cancelled("OfficeCLI backend has been disposed.");
    const args = validateArgs(argsInput);
    const options = validateOptions(optionsInput);
    if (options.signal.aborted)
      throw cancelled("OfficeCLI command was cancelled before it started.");

    const executable = await resolveExecutable(
      this.executablePath,
      this.workspace,
      this.layout.env,
    );

    // Resolution is asynchronous, so disposal may have completed while it ran.
    // Never spawn after disposal, and never touch a deleted private directory.
    if (this.disposed) throw cancelled("OfficeCLI backend has been disposed.");
    if (options.signal.aborted)
      throw cancelled("OfficeCLI command was cancelled before it started.");

    return new Promise<OfficeCliResult>((resolvePromise, rejectPromise) => {
      const output = new BoundedOutput(options.maxOutputBytes);
      let settled = false;
      let finishedOperation = false;
      let termination: TerminationReason | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let closeSeen = false;
      let resolveClose: () => void = () => undefined;
      const closeJoined = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      let resolveFinished: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });

      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
        options.signal.removeEventListener("abort", abort);
        this.active.delete(operation);
      };

      const finishOperation = (): void => {
        if (finishedOperation) return;
        finishedOperation = true;
        cleanup();
        resolveFinished();
      };

      const fail = (error: ForgeError): void => {
        if (settled) return;
        settled = true;
        finishOperation();
        rejectPromise(error);
      };

      const succeed = (result: OfficeCliResult): void => {
        if (settled) return;
        settled = true;
        finishOperation();
        resolvePromise(result);
      };

      const terminationError = (): ForgeError => {
        if (termination === "timeout") return timeoutFailure(options.timeoutMs);
        if (termination === "dispose") return disposeFailure();
        return cancellationFailure();
      };

      let child: ChildProcess;
      // Run once per terminated operation. The group is signaled with SIGTERM
      // first, escalated to SIGKILL at the grace boundary, and then joined.
      // Crucially, this continues even if the group leader already closed: a
      // descendant that ignores SIGTERM must not survive a settled operation.
      let terminationJoin: Promise<void> | undefined;
      const terminate = (reason: TerminationReason): void => {
        if (settled || termination) return;
        termination = reason;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        signalProcess(child, "SIGTERM");
        terminationJoin = (async () => {
          await waitForOwnedGroupExit(
            child,
            TERMINATION_GRACE_MS,
            TERMINATION_JOIN_MS,
          );
          // Prefer a natural close join once the owned group is gone. Only
          // then release our pipe ends: an escaped descendant outside the
          // group could still hold them and keep close() from ever firing.
          if (!closeSeen)
            await Promise.race([closeJoined, delay(CLOSE_JOIN_MS)]);
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (!closeSeen)
            await Promise.race([closeJoined, delay(CLOSE_JOIN_MS)]);
          fail(terminationError());
        })();
      };

      const abort = (): void => terminate("abort");
      const operation: ActiveOperation = {
        finished,
        cancel: () => terminate("dispose"),
      };
      this.active.add(operation);

      try {
        child = spawn(executable, [...args], {
          cwd: this.workspace,
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: this.layout.env,
        });
      } catch {
        fail(spawnFailure());
        return;
      }

      child.stdout?.on("data", (chunk: Buffer) => output.push("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => output.push("stderr", chunk));

      child.once("error", () => {
        // A failed spawn has no process to join or reap. Runtime kill errors
        // keep the pid and are settled by close.
        if (child.pid === undefined) fail(spawnFailure());
      });

      timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();

      child.once("close", (code) => {
        closeSeen = true;
        resolveClose();
        if (termination) {
          // Settling is driven by terminate()'s join; a close that arrives
          // before the join completes must not release the operation early.
          if (!terminationJoin) {
            void Promise.resolve().then(() => fail(terminationError()));
          }
          return;
        }
        if (child.pid === undefined) {
          fail(spawnFailure());
          return;
        }
        succeed({
          stdout: output.stdout(),
          stderr: output.stderr(),
          exitCode: code,
          truncated: output.truncated,
        });
      });
    });
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const operations = [...this.active];
    for (const operation of operations) operation.cancel();
    this.disposal = (async () => {
      await Promise.all(operations.map((operation) => operation.finished));
      await rm(this.layout.root, {
        recursive: true,
        force: true,
        maxRetries: 2,
      });
    })().catch((error: unknown) => {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError(
        "tool",
        "OfficeCLI private runtime directory could not be removed.",
      );
    });
    return this.disposal;
  }
}

export async function createOfficeCliBackend(
  config: { readonly executablePath: string },
  options: { readonly home: string; readonly workspace: string },
): Promise<OfficeCliBackend> {
  if (typeof config !== "object" || config === null)
    throw invalid("OfficeCLI backend configuration is required.");
  if (typeof options !== "object" || options === null)
    throw invalid("OfficeCLI backend home and workspace are required.");
  const executablePath = requirePath(config.executablePath, "executablePath");
  const home = requirePath(options.home, "home");
  const workspace = resolve(requirePath(options.workspace, "workspace"));
  const layout = await createLayout(home);
  return new Backend(executablePath, workspace, layout);
}
