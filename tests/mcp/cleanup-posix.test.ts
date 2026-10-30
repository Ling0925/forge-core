import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  cleanupProcess,
  groupCleanupSupported,
  parsePsMembers,
  psMembers,
} from "../../src/mcp/cleanup";

describe("POSIX process-group cleanup", () => {
  it("uses group signalling on every POSIX platform, not only Linux", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const)
      expect(groupCleanupSupported(platform)).toBe(true);
    expect(groupCleanupSupported("win32")).toBe(false);
  });

  it("parses BSD/macOS ps output with lstart identities", () => {
    const output = [
      "  101   100 Ss   Fri Oct 30 02:59:00 2026",
      "  102   100 S+   Fri Oct 30 02:59:01 2026",
      "  103   100 Z    Fri Oct 30 02:59:02 2026",
      "  200   200 R    Fri Oct 30 02:59:03 2026",
      "garbage",
    ].join("\n");
    expect(parsePsMembers(output, 100)).toEqual([
      { pid: 101, start: "Fri Oct 30 02:59:00 2026", state: "S" },
      { pid: 102, start: "Fri Oct 30 02:59:01 2026", state: "S" },
      { pid: 103, start: "Fri Oct 30 02:59:02 2026", state: "Z" },
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "finds and terminates a whole detached group through ps",
    async () => {
      const child = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], {
        detached: true,
        stdio: "ignore",
      });
      const group = child.pid;
      if (!group) throw new Error("spawn failed");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await psMembers(group)).length).toBeGreaterThanOrEqual(3);
      await cleanupProcess(child);
      const alive = (await psMembers(group)).filter(
        (member) => member.state !== "Z",
      );
      expect(alive).toEqual([]);
    },
  );
});
