import { type ChildProcess, execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

interface Member {
  pid: number;
  start: string;
  state: string;
}

// Linux /proc start times identify processes independently of recycled PIDs.
async function procMembers(group: number): Promise<Member[]> {
  const entries = await readdir("/proc");
  const found: Member[] = [];
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const stat = await readFile(`/proc/${name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (Number(fields[2]) === group && fields[19])
            found.push({
              pid: Number(name),
              start: fields[19],
              state: fields[0] ?? "",
            });
        } catch {
          /* Process exited during the snapshot. */
        }
      }),
  );
  return found;
}
/**
 * Parse `ps -A -o pid= -o pgid= -o stat= -o lstart=` output. `lstart` is last
 * because it contains spaces; it plays the role of /proc's start time, so a
 * recycled PID with the same number is not mistaken for an owned member.
 */
export function parsePsMembers(output: string, group: number): Member[] {
  const found: Member[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || Number(match[2]) !== group) continue;
    const [, pid = "", , stat = "", start = ""] = match;
    // BSD/macOS stat flags start with the state letter (R, S, T, Z, ...).
    found.push({ pid: Number(pid), start, state: stat.charAt(0) });
  }
  return found;
}

// macOS/BSD have no /proc; `ps` exposes the same pid/pgid/start identity.
export function psMembers(group: number): Promise<Member[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart="],
      {
        env: { ...process.env, LC_ALL: "C" },
        timeout: 2000,
        maxBuffer: 8 << 20,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parsePsMembers(stdout, group));
      },
    );
  });
}

/** Process-group cleanup needs POSIX groups and a way to verify membership. */
export function groupCleanupSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32";
}

const members = (group: number) =>
  process.platform === "linux" ? procMembers(group) : psMembers(group);

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Referenced, bounded cleanup: never schedule a detached delayed group signal. */
export async function cleanupProcess(child: ChildProcess): Promise<void> {
  const group = child.pid;
  if (!group) return;
  if (!groupCleanupSupported()) {
    // Windows has no POSIX process groups: direct-child cleanup only.
    child.kill("SIGTERM");
    await delay(2000);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    return;
  }
  let owned = await members(group);
  if (!owned.length) return;
  const started = Date.now();
  let killed = false;
  let terminated = false;
  while (Date.now() - started < 3000) {
    const current = await members(group);
    // An original identity must still anchor ownership of this group. Once
    // absent, never signal this numeric group again (it may have been reused).
    const anchored = current.some((member) =>
      owned.some((old) => old.pid === member.pid && old.start === member.start),
    );
    if (!anchored) return;
    owned = current;
    if (!current.some((member) => member.state !== "Z" && member.state !== "X"))
      return;
    if (!terminated || (!killed && Date.now() - started >= 2000)) {
      const signal = terminated ? "SIGKILL" : "SIGTERM";
      try {
        process.kill(-group, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      if (terminated) killed = true;
      terminated = true;
    }
    await delay(20);
  }
  throw new Error("MCP process group did not terminate within 3 seconds.");
}
