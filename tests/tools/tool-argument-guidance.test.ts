import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { LocalToolRegistry, ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createLocalToolRegistry } from "../../src/tools/local";

let root: string;
let registry: LocalToolRegistry;
let context: ToolContext;
beforeEach(async () => {
  const base = fileURLToPath(new URL("../../../../.forge/tmp/cross-provider-fixes/tools/", import.meta.url));
  await mkdir(base, { recursive: true });
  root = await mkdtemp(join(base, "tool-guidance-"));
  registry = await createLocalToolRegistry(root);
  context = {
    sessionId: parseSessionId(randomUUID()),
    toolCallId: "guidance",
    workspace: root,
    permission: "unrestricted",
    signal: new AbortController().signal,
    onEvent: () => {},
    approve: async () => false,
  };
});
afterEach(async () => {
  await registry.dispose();
  await rm(root, { recursive: true, force: true });
});
const execute = (name: string, args: object) =>
  registry.execute(
    { id: "guidance", type: "function", function: { name, arguments: JSON.stringify(args) } },
    context,
  );
const definition = (name: string) =>
  registry.definitions.find((tool) => tool.function.name === name);
const parameters = (name: string) => {
  const tool = definition(name);
  if (!tool) throw new Error(`Missing tool definition: ${name}`);
  return tool.function.parameters as {
    properties?: Record<string, { type?: string; description?: string; maximum?: number; minimum?: number }>;
    required?: string[];
  };
};

it("advertises the read_file page ceiling in both the tool and parameter description", () => {
  const tool = definition("read_file");
  expect(tool?.function.description).toContain("limit is 1-200 lines");
  expect(tool?.function.description).toContain("defaults to 100");
  expect(tool?.function.description).toContain("next_offset");
  const limit = parameters("read_file").properties?.limit;
  expect(limit).toMatchObject({ type: "integer", maximum: 200, minimum: 1 });
  expect(limit?.description).toContain("1-200");
  expect(limit?.description).toContain("default 100");
  // The generated contract still comes from the executable schema.
  expect(limit?.description).toContain("page instead of raising the limit");
});

it("advertises the search_files page and context ceilings in both descriptions", () => {
  const tool = definition("search_files");
  expect(tool?.function.description).toContain("limit is 1-100 per page");
  expect(tool?.function.description).toContain("context_lines is 0-3");
  const properties = parameters("search_files").properties;
  expect(properties?.limit).toMatchObject({ maximum: 100, minimum: 1 });
  expect(properties?.limit?.description).toContain("1-100");
  expect(properties?.context_lines).toMatchObject({ maximum: 3, minimum: 0 });
  expect(properties?.context_lines?.description).toContain("0-3");
  expect(properties?.context_lines?.description).toContain("default 0");
});

it("keeps tool parameters derived from the executable Zod schema", () => {
  // A schema-only field must appear in the JSON contract, proving regeneration from
  // the loader schema rather than hand-written copies.
  expect(parameters("read_file").required).toEqual(["path"]);
  expect(Object.keys(parameters("read_file").properties ?? {}).sort()).toEqual([
    "if_version",
    "limit",
    "offset",
    "path",
  ]);
  expect(Object.keys(parameters("search_files").properties ?? {}).sort()).toEqual([
    "case_sensitive",
    "context_lines",
    "glob",
    "limit",
    "mode",
    "offset",
    "path",
    "query",
    "regex",
  ]);
  expect(parameters("search_files").properties?.mode).toMatchObject({ type: "string" });
});

it("explains the read_file limit ceiling without echoing the rejected value", async () => {
  await writeFile(join(root, "a.txt"), "one\ntwo\n");
  const result = await execute("read_file", { path: "private-marker.txt", limit: 201 });
  expect(result.isError).toBe(true);
  const data = JSON.parse(result.content) as { code: string; error: string };
  expect(data.code).toBe("invalid_input");
  expect(data.error).toContain("limit: maximum 200");
  expect(data.error).toContain("1-200 lines per page");
  expect(data.error).toContain("next_offset");
  expect(result.content).not.toContain("private-marker.txt");
  // The documented ceiling is still accepted and enforced unchanged.
  expect((await execute("read_file", { path: "a.txt", limit: 200 })).isError).toBe(false);
});

it("explains the search_files limit and context_lines ceilings without echoing input", async () => {
  await writeFile(join(root, "a.txt"), "needle\ncontext\n");
  const overLimit = await execute("search_files", {
    query: "private-marker",
    limit: 101,
  });
  expect(overLimit.isError).toBe(true);
  const limitError = JSON.parse(overLimit.content) as { code: string; error: string };
  expect(limitError.code).toBe("invalid_input");
  expect(limitError.error).toContain("limit: maximum 100");
  expect(limitError.error).toContain("1-100 matches per page");
  expect(limitError.error).toContain("next_offset");
  expect(overLimit.content).not.toContain("private-marker");

  const overContext = await execute("search_files", {
    query: "private-marker",
    context_lines: 4,
  });
  expect(overContext.isError).toBe(true);
  const contextError = JSON.parse(overContext.content) as { code: string; error: string };
  expect(contextError.code).toBe("invalid_input");
  expect(contextError.error).toContain("context_lines: maximum 3");
  expect(contextError.error).toContain("0-3");
  expect(contextError.error).toContain("read_file");
  expect(overContext.content).not.toContain("private-marker");

  // Documented ceilings still work.
  expect(
    (await execute("search_files", { query: "needle", limit: 100, context_lines: 3 })).isError,
  ).toBe(false);
});

it("keeps unrelated validation errors free of paging hints", async () => {
  const result = await execute("read_file", { path: "a.txt", offset: "7" });
  expect(result.isError).toBe(true);
  const data = JSON.parse(result.content) as { code: string; error: string };
  expect(data.code).toBe("invalid_input");
  expect(data.error).toContain("offset");
  expect(data.error).not.toContain("next_offset");
});

it("does not silently clamp an out-of-range page instead of failing", async () => {
  await writeFile(join(root, "long.txt"), Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n"));
  const rejected = await execute("read_file", { path: "long.txt", limit: 500 });
  expect(rejected.isError).toBe(true);
  // No file page was returned, so nothing claims to have read 500 lines.
  expect(JSON.parse(rejected.content)).toMatchObject({ code: "invalid_input" });
  const allowed = await execute("read_file", { path: "long.txt", limit: 200 });
  expect(allowed.isError).toBe(false);
  expect(JSON.parse(allowed.content)).toMatchObject({ lines_returned: 200, truncated: true });
});
