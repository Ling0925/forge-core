import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";

describe("bounded native file queries", () => {
  let root: string;
  let tools: LocalToolRegistry;
  let context: ToolContext;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-query-"));
    tools = await createLocalToolRegistry(root);
    context = { sessionId: parseSessionId(randomUUID()), toolCallId: "query", workspace: root,
      permission: "readonly", signal: new AbortController().signal, onEvent: () => {}, approve: async () => false };
    await mkdir(join(root, "src/nested"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "before\nNeedle one\nneedle two\na.b\naXb\nafter");
    await writeFile(join(root, "src/nested/b.ts"), "Needle three");
    await writeFile(join(root, "src/c.txt"), "Needle four");
  });
  afterEach(async () => { await tools.dispose(); await rm(root, { recursive: true, force: true }); });
  async function run(name: string, args: Record<string, unknown>) {
    const result = await tools.execute({ id: "query", type: "function",
      function: { name, arguments: JSON.stringify(args) } }, context);
    return { ...result, data: JSON.parse(result.content) };
  }
  it("filters root-relative *, ** and ? and pages deterministically", async () => {
    const first = (await run("list_files", { path: "src", recursive: true, glob: "**/?.ts", limit: 1 })).data;
    expect(first).toMatchObject({ entries: [{ path: "src/a.ts" }], offset: 0,
      next_offset: 1, truncated: true, scan_truncated: false });
    const last = (await run("list_files", { path: "./src/", recursive: true, glob: "**/?.ts", offset: 1, limit: 1 })).data;
    expect(last).toMatchObject({ entries: [{ path: "src/nested/b.ts" }], next_offset: null, truncated: false });
    expect((await run("list_files", { path: "src", recursive: true, glob: "*.ts" })).data.entries)
      .toEqual([{ path: "src/a.ts", kind: "file" }]);
    expect((await run("list_files", { glob: "../*" })).isError).toBe(true);
  });
  it("keeps literal case-sensitive default and old match shape", async () => {
    const literal = (await run("search_files", { path: "src", query: "a.b" })).data;
    expect(literal.matches).toEqual([{ path: "src/a.ts", line: 4, column: 1, excerpt: "a.b", excerpt_truncated: false }]);
    const sensitive = (await run("search_files", { path: "src", query: "needle" })).data;
    expect(sensitive.matches).toHaveLength(1);
    const regex = await run("search_files", { path: "src", query: "a.b", regex: true, glob: "*.ts" });
    expect(regex.isError).toBe(false);
    expect(regex.data.matches).toHaveLength(2);
  });
  it("supports case folding, context, content pages, files and counts", async () => {
    const first = (await run("search_files", { path: "src", query: "needle", case_sensitive: false,
      glob: "**/*.ts", context_lines: 1, limit: 1 })).data;
    expect(first).toMatchObject({ next_offset: 1, truncated: true, matches: [{ line: 2,
      context: [{ line: 1, text: "before" }, { line: 2, text: "Needle one" }, { line: 3, text: "needle two" }] }] });
    const next = (await run("search_files", { path: "src", query: "needle", case_sensitive: false,
      glob: "**/*.ts", offset: 1, limit: 2 })).data;
    expect(next.matches.map((match: { line: number }) => match.line)).toEqual([3, 1]);
    expect(next).toMatchObject({ next_offset: null, truncated: false, scan_truncated: false });
    const files = (await run("search_files", { query: "Needle", mode: "files", glob: "**/*.ts", offset: 1 })).data;
    expect(files.matches).toEqual([{ path: "src/nested/b.ts" }]);
    const counts = (await run("search_files", { query: "needle", case_sensitive: false, mode: "count", glob: "**/*.ts" })).data;
    expect(counts.matches).toEqual([{ path: "src/a.ts", count: 2 }, { path: "src/nested/b.ts", count: 1 }]);
  });
  it("rejects invalid and high-complexity regex within a deadline", async () => {
    for (const query of ["[", "(a+)+$", "(?=a)"]) {
      const result = await run("search_files", { query, regex: true });
      expect(result.isError).toBe(true);
      expect(result.data.error).toMatch(/regex/i);
    }
    await writeFile(join(root, "slow.txt"), `${"a".repeat(40000)}!`);
    const start = Date.now();
    const result = await run("search_files", { path: "slow.txt", query: "a+a+a+a+a+$", regex: true });
    expect(result.isError).toBe(true);
    expect(Date.now() - start).toBeLessThan(2500);
  });
  it("retains exclusions, byte ceiling, symlink policy and readonly", async () => {
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "large.txt"), "Needle".repeat(400000));
    await writeFile(join(root, ".env.local"), "Needle");
    await symlink(join(root, "src/a.ts"), join(root, "link.txt"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules/x.ts"), "Needle");
    const result = (await run("search_files", { query: "Needle", mode: "files" })).data;
    expect(result.matches).toEqual([{ path: "src/a.ts" }, { path: "src/c.txt" }, { path: "src/nested/b.ts" }]);
    expect(result.skipped_files).toBe(2);
    expect((await run("read_file", { path: "link.txt" })).isError).toBe(true);
    expect((await run("run_command", { argv: ["true"] })).isError).toBe(true);
  });
  it("separates incomplete traversal from page truncation", async () => {
    let path = root;
    for (let depth = 0; depth < 10; depth += 1) { path = join(path, "deep"); await mkdir(path); }
    await writeFile(join(path, "hidden.txt"), "Needle");
    const result = (await run("list_files", { recursive: true, glob: "**/*.missing" })).data;
    expect(result).toMatchObject({ entries: [], truncated: false, scan_truncated: true, next_offset: null });
  });
  it("executes real regex after esbuild bundling, including keepNames helpers", async () => {
    const bundled = await build({ entryPoints: ["src/tools/file-query.ts"], bundle: true,
      platform: "node", target: "node22", format: "esm", keepNames: true, write: false });
    const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? "").toString("base64")}`);
    const matcher = module.createLineMatcher("a.b", true, true, new AbortController().signal);
    try {
      expect(await matcher.find("a.b\naXb\nnone", 0, 10)).toEqual({
        hits: [{ index: 0, column: 0 }, { index: 1, column: 0 }], count: 2, complete: true,
      });
    } finally { await matcher.dispose(); }
  });
  it("calls command hooks only after spawn and isolates observer errors", async () => {
    let started = 0;
    const streams: string[] = [];
    context = { ...context, permission: "unrestricted", onCommandStarted: () => { started += 1; throw new Error("observer"); },
      onCommandOutput: (stream, text) => { streams.push(`${stream}:${text}`); throw new Error("observer"); } };
    expect((await run("run_command", { argv: [process.execPath, "-e", "process.stdout.write('out');process.stderr.write('err')"] })).isError).toBe(false);
    expect(started).toBe(1);
    expect(streams).toEqual(expect.arrayContaining(["stdout:out", "stderr:err"]));
    expect((await run("run_command", { argv: ["/forge-no-such-executable"] })).isError).toBe(true);
    expect(started).toBe(1);
  });
});
