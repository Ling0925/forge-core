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

const members = (group: number) =>
  process.platform === "linux" ? procMembers(group) : psMembers(group);

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createProcessGroup(child: ChildProcess) {
  let owned: Member[] | undefined;
  let pending = Promise.resolve();
  return (signal: NodeJS.Signals | 0): Promise<boolean> => {
    const work = pending.then(async () => {
      const group = child.pid;
      if (!group) return false;
      const previous = owned ?? (await members(group));
      const current = await members(group);
      // Retain ownership across signals only while a start-time identity survives.
      const anchored = current.some((member) =>
        previous.some(
          (old) => old.pid === member.pid && old.start === member.start,
        ),
      );
      owned = anchored ? current : [];
      if (!owned.some((member) => member.state !== "Z" && member.state !== "X"))
        return false;
      if (signal !== 0) {
        try {
          process.kill(-group, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            owned = [];
            return false;
          }
          throw error;
        }
      }
      return true;
    });
    pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  };
}

/** Referenced, bounded cleanup: never schedule a detached delayed group signal. */
export async function cleanupProcess(child: ChildProcess): Promise<void> {
  const group = child.pid;
  if (!group) return;
  const signalProcess = createProcessGroup(child);
  if (!(await signalProcess(0))) return;
  const started = Date.now();
  let killed = false;
  let terminated = false;
  while (Date.now() - started < 3000) {
    if (!terminated || (!killed && Date.now() - started >= 2000)) {
      const signal = terminated ? "SIGKILL" : "SIGTERM";
      if (!(await signalProcess(signal))) return;
      if (terminated) killed = true;
      terminated = true;
    } else if (!(await signalProcess(0))) return;
    await delay(20);
  }
  throw new Error("MCP process group did not terminate within 3 seconds.");
}
