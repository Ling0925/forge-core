import type { ChildProcess } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

interface Member {
  pid: number;
  start: string;
  state: string;
}

// Linux /proc start times identify processes independently of recycled PIDs.
async function members(group: number): Promise<Member[]> {
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
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Referenced, bounded cleanup: never schedule a detached delayed group signal. */
export async function cleanupProcess(child: ChildProcess): Promise<void> {
  const group = child.pid;
  if (!group) return;
  if (process.platform !== "linux") {
    // Unverified platforms: direct-child cleanup only, not a tree guarantee.
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
