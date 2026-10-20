import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ToolCall } from "../../src/shared/schemas";

it("routes an isolated child and its real file tools to the retained worktree without an extra approval", async () => {
  const root = await mkdtemp("/tmp/forge-worktree-runtime-");
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (args: string[]) => promisify(execFile)("git", ["-C", repo, ...args]);
  await git(["init", "-q"]);
  await writeFile(join(repo, "base.txt"), "committed\n");
  await git(["add", "base.txt"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
  await writeFile(join(repo, "base.txt"), "parent dirty\n");
  const home = join(root, "home");
  const call = (id: string, name: string, args: unknown): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let parentTurns = 0; let childTurns = 0; let approvals = 0;
  const harness = await createHarness({ stateDir: home, providerFactory: () => ({
      listModels: async () => [], complete: async (messages, _definitions, options) => {
        if (options.model === "child") {
          if (++childTurns === 1) return { message: { role: "assistant", content: "", tool_calls: [
            call("read", "read_file", { path: "base.txt" }), call("write", "write_file", { path: "child.txt", content: "child result\n" }),
          ] } };
          const read = messages.find(message => message.role === "tool" && message.tool_call_id === "read");
          expect(read?.content).toContain("committed");
          expect(read?.content).not.toContain("parent dirty");
          return { message: { role: "assistant", content: "child done" } };
        }
        if (++parentTurns === 1) return { message: { role: "assistant", content: "", tool_calls: [
          call("spawn", "spawn_agent", { task: "Write result", model: "child", isolation: "worktree" }),
        ] } };
        if (parentTurns === 2) return { message: { role: "assistant", content: "", tool_calls: [call("wait", "wait_agents", {})] } };
        return { message: { role: "assistant", content: "done" } };
      },
  }) });
  try {
    await harness.updateSettings({ settings: { baseUrl: "http://localhost:1234/v1", model: "parent" } });
    const session = await harness.createSession({ workspace: repo, title: "parent" });
    const result = await harness.run({ sessionId: session.id, prompt: "work", permission: "workspace" }, () => {}, async () => { approvals += 1; return true; }, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(approvals).toBe(0);
    const child = (await harness.listSessions()).find(item => item.parentSessionId === session.id);
    expect(child).toBeDefined();
    if (!child) throw new Error("Missing child session");
    const saved = await harness.getSession(child.id);
    expect(saved.workspace).toBe(join(`${home}-worktrees`, child.id));
    expect(saved.agentWorktree?.worktree).toBe(saved.workspace);
    expect(await readFile(join(saved.workspace, "child.txt"), "utf8")).toBe("child result\n");
    expect(await readFile(join(repo, "base.txt"), "utf8")).toBe("parent dirty\n");
    await expect(readFile(join(repo, "child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await harness.dispose(); await rm(root, { recursive: true, force: true }); }
});
