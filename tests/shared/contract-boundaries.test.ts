import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { createProjectContext } from "../../src/context";
import type { createAgentWorktreeService } from "../../src/core/agent-worktrees";
import type { createRuntimeHub } from "../../src/host/runtime";
import type { createMcpService } from "../../src/mcp/registry";
import type { AgentWorktreeService } from "../../src/shared/agent-worktrees";
import {
  type CheckpointService,
  checkpointDtoSchema,
  checkpointMetadataSchema,
} from "../../src/shared/checkpoints";
import * as ipc from "../../src/shared/ipc";
import {
  type McpService,
  mcpHealthDtoSchema,
  mcpRecordDtoSchema,
  mcpRegisterDtoSchema,
} from "../../src/shared/mcp";
import {
  type ProjectContextService,
  projectContextDtoSchema,
} from "../../src/shared/project-context";
import type { RuntimeHost } from "../../src/shared/runtime-host";
import type { createCheckpointStore } from "../../src/store/checkpoints";

const root = resolve(import.meta.dirname, "../..");
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sources(resolve(directory, entry.name))
          : Promise.resolve(
              entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
                ? [resolve(directory, entry.name)]
                : [],
            ),
      ),
    )
  ).flat();
}
function imports(source: string): string[] {
  const tree = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      result.push(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) result.push(argument.text);
      else result.push("<dynamic module path>");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return result;
}

describe("neutral contract ownership", () => {
  it("keeps all shared imports, including type-only references, inside the contract layer", async () => {
    const shared = resolve(root, "src/shared");
    for (const file of await sources(shared))
      for (const dependency of imports(await readFile(file, "utf8"))) {
        const allowed = dependency.startsWith(".")
          ? resolve(dirname(file), dependency).startsWith(`${shared}/`)
          : ["zod", "zod-to-json-schema"].includes(dependency);
        expect(allowed, `${file}: ${dependency}`).toBe(true);
      }
  });

  it("bundles the public transport contract for browsers without host implementations", async () => {
    const result = await build({
      entryPoints: [resolve(root, "src/shared/ipc.ts")],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(1);
    expect(
      inputs.filter(
        (file) => file.startsWith("src/") && !file.startsWith("src/shared/"),
      ),
    ).toEqual([]);
  });

  it("keeps host ownership independent of desktop adapters", async () => {
    for (const folder of ["host", "web", "cli"])
      for (const file of await sources(resolve(root, "src", folder))) {
        expect(
          imports(await readFile(file, "utf8")).filter((path) =>
            /(?:^|\/)desktop(?:\/|$)/.test(path),
          ),
          file,
        ).toEqual([]);
      }
    const neutral = await import("../../src/host/runtime");
    const desktop = await import("../../src/desktop/runtime");
    expect(desktop.createRuntimeHub).toBe(neutral.createRuntimeHub);
  });

  it("reexports the same validation objects instead of copying DTO schemas", () => {
    expect(ipc.projectContextDtoSchema).toBe(projectContextDtoSchema);
    expect(ipc.mcpRegisterDtoSchema).toBe(mcpRegisterDtoSchema);
    expect(ipc.mcpRecordDtoSchema).toBe(mcpRecordDtoSchema);
    expect(ipc.mcpHealthDtoSchema).toBe(mcpHealthDtoSchema);
    expect(ipc.checkpointDtoSchema).toBe(checkpointDtoSchema);
    expect(checkpointDtoSchema.unwrap()).toBe(checkpointMetadataSchema);
  });

  it("preserves the pre-move transport schema fields and validation constraints", () => {
    // Captured from f9cf6f5 before the move; no changed limits, required fields,
    // optionality, enum values or additionalProperties behavior is intended.
    const expected = {
      checkpointDtoSchema:
        "7df50a39603f03e27fcf2b29c1b391906ba8cd19e73dacf87f2eee66b4dab7a1",
      mcpHealthDtoSchema:
        "625517bc1b89f7362d8df667bb104fed7a062e864e8f9539f7c586d6f10345a5",
      mcpRecordDtoSchema:
        "06d51cc7e42c85ad6368c7a141828b62b96a128a8edb620f2a3ad76b4d4e0b0a",
      mcpRegisterDtoSchema:
        "8bbd08d1c5a4b717be64e1627bbe5d624f3c040d2e8fdcd1762389c16f3033c7",
      projectContextDtoSchema:
        "21ed2b8b5d7abb49490b53c467d08fecdc90f339be1cff0d52f822967c742efb",
    };
    for (const [name, hash] of Object.entries(expected)) {
      const schema = {
        projectContextDtoSchema,
        mcpRegisterDtoSchema,
        mcpRecordDtoSchema,
        mcpHealthDtoSchema,
        checkpointDtoSchema,
      }[name as keyof typeof expected];
      expect(
        createHash("sha256")
          .update(JSON.stringify(zodToJsonSchema(schema)))
          .digest("hex"),
        name,
      ).toBe(hash);
    }
  });

  it("makes implementation factories explicitly satisfy neutral service ports", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof createProjectContext>>
    >().toEqualTypeOf<ProjectContextService>();
    expectTypeOf<
      Awaited<ReturnType<typeof createMcpService>>
    >().toEqualTypeOf<McpService>();
    expectTypeOf<
      ReturnType<typeof createAgentWorktreeService>
    >().toEqualTypeOf<AgentWorktreeService>();
    expectTypeOf<
      Awaited<ReturnType<typeof createCheckpointStore>>
    >().toMatchTypeOf<CheckpointService>();
    expectTypeOf<
      ReturnType<typeof createRuntimeHub>
    >().toEqualTypeOf<RuntimeHost>();
  });
});
