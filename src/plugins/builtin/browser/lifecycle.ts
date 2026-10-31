import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError } from "../../../shared/errors";
import { type CliCommand, exists } from "./cli-layout";
import { parseToolResult, redact } from "./result";
import type { Session } from "./session";
import { requestTool } from "./tools";

const CLEANUP_TIMEOUT_MS = 12_000;

export function createLifecycle(session: Session, cli: CliCommand) {
  let disposal: Promise<void> | undefined;

  async function closeViaMcp(): Promise<void> {
    if (session.connection.isClosed) return;
    const result = await requestTool(
      session,
      "agent_browser_close",
      session.commonArgs(),
      AbortSignal.timeout(5_000),
    );
    if (parseToolResult(result).isError)
      throw new ForgeError(
        "tool",
        "agent-browser did not confirm browser close.",
      );
  }

  /** Artifacts agent-browser writes for exactly this private session. */
  function sessionArtifacts(): readonly string[] {
    const base = join(
      session.layout.socket,
      "namespaces",
      session.layout.namespace,
      "run",
    );
    return [
      join(base, `${session.layout.session}.sock`),
      join(base, `${session.layout.session}.pid`),
      join(base, `${session.layout.session}.port`),
    ];
  }

  async function daemonAlive(): Promise<boolean> {
    for (const path of sessionArtifacts()) if (await exists(path)) return true;
    return false;
  }

  /** Wait, bounded, for the daemon to remove this session's own artifacts. */
  async function daemonGone(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      if (!(await daemonAlive())) return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Close only this backend's private session through a fresh CLI process.
   * `--all` is never passed, and the session socket lives inside our private
   * directory, so this cannot address a user's real browser.
   */
  async function cleanupCli(): Promise<void> {
    const child = spawn(
      cli.command,
      [
        ...cli.prefix,
        "--session",
        session.layout.session,
        ...(session.layout.namespace
          ? ["--namespace", session.layout.namespace]
          : []),
        "close",
        "--json",
      ],
      {
        cwd: session.layout.work,
        env: session.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 4_000) stdout = `${stdout}${chunk}`.slice(0, 4_000);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4_000) stderr = `${stderr}${chunk}`.slice(0, 4_000);
    });
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    const outcome = await new Promise<{
      readonly code: number | null;
      readonly closed: boolean;
    }>((finish) => {
      const settle = (value: {
        readonly code: number | null;
        readonly closed: boolean;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(abandonTimer);
        finish(value);
      };
      const killOwnedGroup = () => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      // Wait for the kill to be confirmed by close(); never report cleanup
      // success while the process handle is still unjoined.
      const killTimer = setTimeout(() => {
        timedOut = true;
        killOwnedGroup();
      }, CLEANUP_TIMEOUT_MS);
      const abandonTimer = setTimeout(() => {
        killOwnedGroup();
        settle({ code: null, closed: false });
      }, CLEANUP_TIMEOUT_MS + 3_000);
      child.once("error", (error) => {
        spawnError = error;
        settle({ code: null, closed: true });
      });
      child.once("close", (code) => settle({ code, closed: true }));
    });
    if (!outcome.closed)
      throw new ForgeError(
        "tool",
        "agent-browser cleanup did not confirm process exit for this isolated session.",
      );
    if (spawnError)
      throw new ForgeError(
        "tool",
        `agent-browser cleanup could not start: ${redact(spawnError.message, session.secrets).slice(0, 300)}`,
      );
    // Exit code alone is not evidence: a close racing an already-exiting
    // daemon reports EOF as a failure while the session is in fact gone.
    if (timedOut) {
      if (await daemonGone(3_000)) return;
      throw new ForgeError(
        "tool",
        "agent-browser cleanup timed out and this session's daemon is still present.",
      );
    }
    // Native close can acknowledge before Chromium flushes its disposable
    // profile and removes the daemon artifacts. Confirm exit with a bounded
    // grace period instead of treating that short race as a cleanup failure.
    if (await daemonGone(3_000)) return;
    const detail = [stdout, stderr]
      .map((value) => redact(value.trim(), session.secrets).slice(0, 400))
      .filter(Boolean)
      .join(" ");
    throw new ForgeError(
      "tool",
      `agent-browser cleanup failed for this isolated session${
        detail ? `: ${detail}` : "."
      }`,
    );
  }

  /**
   * Reclaim this backend's daemon/browser. `force` skips the MCP close (used
   * after cancellation or an uncertain command, when that channel may be
   * dead) and always closes this one private session through the CLI.
   */
  async function cleanup(browser: boolean, force = false): Promise<void> {
    let failure: Error | undefined;
    let mcpClosed = false;
    if (browser) {
      if (!force) {
        try {
          await closeViaMcp();
          mcpClosed = true;
        } catch {
          // Never replay the failed page action; fall back to process cleanup.
        }
      }
      // A confirmed in-band close is sufficient evidence. Only when that close
      // was not possible (dead channel/uncertain call) or the session's daemon
      // artifacts are still present do we spawn a fresh CLI close. `--all` is
      // never used, so this can only address our own private session.
      try {
        if (!mcpClosed || !(await daemonGone(3_000))) await cleanupCli();
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new Error("agent-browser cleanup failed.");
      }
    }
    try {
      await session.connection.close();
    } catch (error) {
      failure ??=
        error instanceof Error
          ? error
          : new Error("MCP connection cleanup failed.");
    }
    // Keep the private state if the owned daemon could not be confirmed dead:
    // deleting it would remove evidence and may break a live agent-browser.
    if (!failure) {
      await rm(session.layout.root, { recursive: true, force: true }).catch(
        () => undefined,
      );
      if (session.layout.socketRoot)
        await rm(session.layout.socketRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      if (session.layout.tmpRoot)
        await rm(session.layout.tmpRoot, {
          recursive: true,
          force: true,
        }).catch(() => undefined);
    }
    if (failure)
      throw new ForgeError(
        "tool",
        `Browser cleanup failed; the private state was retained for inspection. ${redact(
          failure.message,
          session.secrets,
        )}`.slice(0, 2_000),
      );
  }

  /** Mark this backend unusable and reclaim its daemon/browser exactly once. */
  function recover(): Promise<void> {
    session.closed = true;
    disposal ??= cleanup(session.browserTouched, true);
    return disposal;
  }

  /** Returns true only when cleanup was confirmed. */
  async function reclaim(): Promise<boolean> {
    try {
      await recover();
      return true;
    } catch {
      return false;
    }
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    session.closed = true;
    disposal = cleanup(session.browserTouched && !session.browserClosed);
    return disposal;
  }

  return { reclaim, dispose };
}
