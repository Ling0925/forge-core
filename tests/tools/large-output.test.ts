import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";
import { createCheckpointStore } from "../../src/store/checkpoints";

let root: string;
let tools: LocalToolRegistry;
let context: ToolContext;
let state: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "forge-large-output-"));
  state = await mkdtemp(join(tmpdir(), "forge-large-state-"));
  tools = await createLocalToolRegistry(root, { redactValues: ["private-test-value"] });
  context = { sessionId: parseSessionId(randomUUID()), toolCallId: "test", workspace: root,
    permission: "unrestricted", signal: new AbortController().signal,
    onEvent: () => {}, approve: async () => true };
});
afterEach(async () => { await tools.dispose(); await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
function execute(name: string, args: object, ctx = context) {
  return tools.execute({ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }, ctx);
}

it("finishes a noisy command and retrieves the redacted output without rerunning it", async () => {
  const code = "process.stdout.write('a'.repeat(90000)); process.stdout.write('private-'+'test-value'); process.stderr.write('done'); require('fs').writeFileSync('finished', 'yes')";
  const result = await execute("run_command", { argv: [process.execPath, "-e", code], timeout_ms: 10000 });
  const value = JSON.parse(result.content);
  expect(result.isError).toBe(false);
  expect(value).toMatchObject({ exit_code: 0, truncated: false, preview_truncated: true });
  expect(await readFile(join(root, "finished"), "utf8")).toBe("yes");
  expect(value.stdout.length).toBeLessThan(20000);
  let offset = 0;
  let output = "";
  for (;;) {
    const page = JSON.parse((await execute("read_command_output", { id: value.output_id, offset, limit: 12000 })).content);
    output += page.content;
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  expect(output).toBe(`${"a".repeat(90000)}[REDACTED]`);
  const stderr = JSON.parse((await execute("read_command_output", { id: value.output_id, stream: "stderr" })).content);
  expect(stderr.content).toBe("done");
  const other = { ...context, sessionId: parseSessionId(randomUUID()) };
  expect((await execute("read_command_output", { id: value.output_id }, other)).isError).toBe(true);
});

it("allows sequential own edits but rejects an external change", async () => {
  await execute("write_file", { path: "a", content: "first" });
  expect((await execute("edit_file", { path: "a", old_text: "first", new_text: "second" })).isError).toBe(false);
  await writeFile(join(root, "a"), "external");
  expect((await execute("write_file", { path: "a", content: "replacement" })).isError).toBe(true);
  expect(await readFile(join(root, "a"), "utf8")).toBe("external");
});

it("keeps running when the capture quota is exhausted", async () => {
  const result = await execute("run_command", { argv: [process.execPath, "-e",
    "const fs=require('fs'); for(let i=0;i<272;i++) fs.writeSync(1, Buffer.alloc(65536, 120)); fs.writeFileSync('after-quota', 'completed')"], timeout_ms: 20000 });
  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content)).toMatchObject({ exit_code: 0, truncated: true });
  expect(await readFile(join(root, "after-quota"), "utf8")).toBe("completed");
});

it("rejects unguarded appends without modifying the target", async () => {
  await execute("write_file", { path: "a", content: "first" });
  expect((await execute("write_file", { path: "a", content: "second", append: true })).isError).toBe(true);
  expect(await readFile(join(root, "a"), "utf8")).toBe("first");
});

it("assembles a file above 2 MiB in bounded chunks and rejects duplicate appends", async () => {
  await tools.dispose();
  const checkpoints = await createCheckpointStore(root, state);
  tools = await createLocalToolRegistry(root, { checkpointStore: checkpoints });
  const chunk = "line\n".repeat(50000);
  let bytes = 0;
  for (let index = 0; index < 9; index++) {
    const result = await execute("write_file", { path: "large.txt", content: chunk, append: true, expected_bytes: bytes });
    expect(result.isError).toBe(false);
    bytes += Buffer.byteLength(chunk);
    expect(JSON.parse(result.content).size_bytes).toBe(bytes);
  }
  const duplicate = await execute("write_file", { path: "large.txt", content: chunk, append: true, expected_bytes: bytes - Buffer.byteLength(chunk) });
  expect(duplicate.isError).toBe(true);
  expect(await readFile(join(root, "large.txt"), "utf8")).toBe(chunk.repeat(9));
  expect((await execute("edit_file", { path: "large.txt", old_text: "line", new_text: "row", replace_all: true })).isError).toBe(false);
  const latest = (await checkpoints.list())[0];
  expect(latest?.state).toBe("completed");
  if (!latest) throw new Error("Missing large-file checkpoint");
  await checkpoints.restore(latest.id, { isSessionActive: async () => false });
  expect(await readFile(join(root, "large.txt"), "utf8")).toBe(chunk.repeat(9));
});
