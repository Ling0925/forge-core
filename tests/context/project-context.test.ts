import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// A single, deterministic growth hook. It is inert unless a test arms it with
// an exact fixture path, so every other test in this file performs real,
// unmodified filesystem IO. When armed, the hook appends to the actual fixture
// on disk at the boundary immediately after the reader's stat result and just
// before it consumes content, modelling an ordinary concurrent writer. The
// real descriptor is still opened and read by the production code; only the
// fixture's on-disk bytes are changed, and nothing about descriptor IO is faked.
const readHooks = vi.hoisted(() => ({
  armedPath: null as string | null,
  growChunk: "",
  grown: false,
  // Which content boundary grew the fixture: the descriptor `open` used by the
  // bounded reader, or a pathname `readFile` as the old unbounded reader used.
  grownBy: null as string | null,
  observedLstatSizes: [] as number[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const growIfArmed = async (
    boundary: string,
    path: unknown,
  ): Promise<void> => {
    if (
      readHooks.armedPath === null ||
      readHooks.grown ||
      typeof path !== "string" ||
      path !== readHooks.armedPath
    ) {
      return;
    }
    // Append to the real file before the descriptor is opened/read.
    await original.appendFile(readHooks.armedPath, readHooks.growChunk);
    readHooks.grown = true;
    readHooks.grownBy = boundary;
  };
  return {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      const stats = await original.lstat(...args);
      const { size } = stats;
      if (
        typeof size === "number" &&
        typeof args[0] === "string" &&
        args[0] === readHooks.armedPath
      ) {
        // The reader never requests the bigint overload, so a byte size is
        // always a plain number here; narrow rather than cast.
        readHooks.observedLstatSizes.push(size);
      }
      return stats;
    },
    open: async (...args: Parameters<typeof original.open>) => {
      await growIfArmed("open", args[0]);
      return original.open(...args);
    },
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      await growIfArmed("readFile", args[0]);
      return original.readFile(...args);
    },
  };
});
import {
  CONTEXT_INSTRUCTION_TOOL_NAME,
  LOAD_SKILL_TOOL_NAME,
  createProjectContext,
  createProjectContextTool,
} from "../../src/context/project-context";
import { ForgeError } from "../../src/shared/errors";
import { parseSessionId } from "../../src/shared/schemas";
import { createSkillTool } from "../../src/tools/skills";

let workspace: string;
let outside: string;

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    id: "call-1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function makeToolContext(ws: string, signal?: AbortSignal) {
  return {
    sessionId: parseSessionId("00000000-0000-0000-0000-000000000000"),
    toolCallId: "call-1",
    workspace: ws,
    permission: "readonly" as const,
    signal: signal ?? new AbortController().signal,
    approve: async () => true,
    onEvent: () => {},
  };
}

beforeAll(async () => {
  workspace = join(tmpdir(), `ctx-test-${process.pid}-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  outside = `${workspace}-outside`;
  await mkdir(outside, { recursive: true });
  await write(
    join(workspace, "AGENTS.md"),
    "# Root instructions\nAlways run tests before committing.\n",
  );
  await write(
    join(workspace, "packages", "api", "AGENTS.md"),
    "# API subtree instructions\nUse strict TypeScript in packages/api.\n",
  );
  await write(
    join(workspace, ".forge", "skills", "test-driven-repair", "SKILL.md"),
    [
      "---",
      'name: "test-driven-repair"',
      "description: Reproduce failures with tests before fixing.",
      "version: 1.0.0",
      "---",
      "# Test-driven repair",
      "1. Reproduce the failure with a failing test.",
      "2. Fix the code.",
      "3. Confirm the test passes.",
    ].join("\n"),
  );
  await write(
    join(workspace, ".agents", "skills", "repo-review", "SKILL.md"),
    [
      "---",
      "name: repo-review",
      "description: Structured repository review for correctness and safety.",
      "---",
      "# Repository review",
      "Review diffs for correctness, tests and security regressions.",
    ].join("\n"),
  );
});

afterEach(() => {
  // Restore the inert default so no growth hook can leak into later tests.
  readHooks.armedPath = null;
  readHooks.growChunk = "";
  readHooks.grown = false;
  readHooks.grownBy = null;
  readHooks.observedLstatSizes = [];
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("project context service", () => {
  it("loads root AGENTS.md and skill metadata into system context", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const catalog = ctx.getCatalog();
    expect(catalog.counts.instructions).toBe(1);
    expect(catalog.counts.skills).toBe(2);
    const text = ctx.getSystemContext();
    expect(text).toContain("Always run tests before committing.");
    // Catalog metadata only: skill bodies must not be injected.
    expect(text).toContain("test-driven-repair");
    expect(text).not.toContain("Reproduce the failure");
    expect(ctx.getFingerprint().hash).toHaveLength(32);
    expect(ctx.getFingerprint().signatures.length).toBe(3);
    await ctx.dispose();
  });

  it("resolves nested precedence root-first for accessed subtrees", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const sources = await ctx.resolveInstructions("packages/api");
    expect(sources.map((s) => s.path)).toEqual([
      "AGENTS.md",
      join("packages", "api", "AGENTS.md"),
    ]);
    expect(sources[0]?.order).toBe(0);
    expect(sources[1]?.order).toBe(1);
    await ctx.dispose();
  });

  it("returns only root when nested AGENTS.md is missing", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const sources = await ctx.resolveInstructions("packages/unknown");
    expect(sources.length).toBe(1);
    expect(sources[0]?.path).toBe("AGENTS.md");
    await ctx.dispose();
  });

  it("rejects parent-directory escape", async () => {
    const ctx = await createProjectContext(workspace);
    await expect(ctx.resolveInstructions("../outside")).rejects.toBeInstanceOf(
      ForgeError,
    );
    await ctx.dispose();
  });

  it("refuses symlinked instruction directories safely", async () => {
    await write(join(outside, "evil", "AGENTS.md"), "# Evil instructions\n");
    const linkPath = join(workspace, "linked");
    await rm(linkPath, { force: true, recursive: true });
    await symlink(join(outside, "evil"), linkPath);
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    // Root instructions still load; symlinked subtree does not inject content.
    const sources = await ctx.resolveInstructions("linked");
    expect(sources.length).toBe(1);
    expect(sources.every((s) => !s.body.includes("Evil"))).toBe(true);
    await rm(linkPath, { force: true });
    await ctx.dispose();
  });

  it("refuses oversized instruction bodies explicitly", async () => {
    const big = join(workspace, "big");
    await write(join(big, "AGENTS.md"), "x".repeat(64 * 1024 + 1));
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const sources = await ctx.resolveInstructions("big");
    expect(sources.length).toBe(1); // root only; nested refused
    expect(ctx.getCatalog().warnings.some((w) => w.includes("oversized"))).toBe(
      true,
    );
    await rm(big, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("refuses secret-shaped instruction content", async () => {
    const secretDir = join(workspace, "secret");
    await write(join(secretDir, "AGENTS.md"), "API_KEY=abcdefghijklmnop1234\n");
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const sources = await ctx.resolveInstructions("secret");
    expect(sources.length).toBe(1);
    expect(ctx.getCatalog().warnings.some((w) => w.includes("sensitive"))).toBe(
      true,
    );
    await rm(secretDir, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("flags duplicate skill ids with first root winning", async () => {
    const dup = join(workspace, ".agents", "skills", "test-driven-repair");
    await write(
      join(dup, "SKILL.md"),
      "---\nname: test-driven-repair\ndescription: Duplicate copy.\n---\n",
    );
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const catalog = ctx.getCatalog();
    expect(catalog.counts.skills).toBe(2);
    expect(catalog.warnings.some((w) => w.includes("duplicate skill id"))).toBe(
      true,
    );
    await rm(dup, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("excludes skills with invalid metadata", async () => {
    const bad = join(workspace, ".forge", "skills", "no-meta");
    await write(join(bad, "SKILL.md"), "No frontmatter at all.\n");
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const catalog = ctx.getCatalog();
    expect(catalog.skills.some((s) => s.id === "no-meta")).toBe(false);
    expect(catalog.warnings.some((w) => w.includes("invalid metadata"))).toBe(
      true,
    );
    await rm(bad, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("lazily loads skill bodies only via loadSkill", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const catalog = ctx.getCatalog();
    for (const skill of catalog.skills) {
      expect(JSON.stringify(skill)).not.toContain("Reproduce the failure");
    }
    const loaded = await ctx.loadSkill("test-driven-repair");
    expect(loaded.body).toContain("Reproduce the failure");
    expect(loaded.sourceDirectory).toContain("test-driven-repair");
    await expect(ctx.loadSkill("missing-skill")).rejects.toBeInstanceOf(
      ForgeError,
    );
    await ctx.dispose();
  });

  it("invalidates the fingerprint when files change", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const before = ctx.getFingerprint();
    await write(
      join(workspace, "AGENTS.md"),
      "# Root instructions\nChanged content.\n",
    );
    await ctx.refresh();
    const after = ctx.getFingerprint();
    expect(after.hash).not.toBe(before.hash);
    expect(after.version).not.toBe(before.version);
    await write(
      join(workspace, "AGENTS.md"),
      "# Root instructions\nAlways run tests before committing.\n",
    );
    await ctx.dispose();
  });

  it("accepts an explicit user skill directory", async () => {
    const userDir = join(outside, "my-skills");
    const skillDir = join(userDir, "personal-notes");
    await write(
      join(skillDir, "SKILL.md"),
      "---\nname: personal-notes\ndescription: Personal note taking.\n---\n",
    );
    const ctx = await createProjectContext(workspace, {
      extraSkillDirectories: [userDir],
    });
    await ctx.refresh();
    const catalog = ctx.getCatalog();
    const skill = catalog.skills.find((s) => s.id === "personal-notes");
    expect(skill?.provenance).toBe("user");
    const loaded = await ctx.loadSkill("personal-notes");
    expect(loaded.body).toContain("Personal note taking");
    await rm(userDir, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("preserves a legitimately symlinked explicit user skill root", async () => {
    const realUser = join(outside, "dotfiles-skills");
    await write(
      join(realUser, "dotfile-skill", "SKILL.md"),
      "---\nname: dotfile-skill\ndescription: Managed via dotfiles.\n---\nBODY\n",
    );
    const linkedUser = join(outside, "linked-user-skills");
    await rm(linkedUser, { recursive: true, force: true });
    await symlink(realUser, linkedUser);
    const ctx = await createProjectContext(workspace, {
      extraSkillDirectories: [linkedUser],
    });
    await ctx.refresh();
    const skill = ctx.getCatalog().skills.find((s) => s.id === "dotfile-skill");
    expect(skill?.provenance).toBe("user");
    const loaded = await ctx.loadSkill("dotfile-skill");
    expect(loaded.body).toContain("BODY");
    await rm(linkedUser, { force: true });
    await rm(realUser, { recursive: true, force: true });
    await ctx.dispose();
  });
});

describe("context containment regressions", () => {
  it("refuses a symlinked .forge/skills root at discovery and load", async () => {
    const ws = join(tmpdir(), `ctx-symroot-${process.pid}-${Date.now()}`);
    const outsideSkills = `${ws}-outside-skills`;
    await mkdir(ws, { recursive: true });
    // .forge/skills is a symlink to an outside directory holding a skill.
    await mkdir(join(ws, ".forge"), { recursive: true });
    await mkdir(join(outsideSkills, "escaped"), { recursive: true });
    await writeFile(
      join(outsideSkills, "escaped", "SKILL.md"),
      "---\nname: escaped\ndescription: Example\n---\nOUTSIDE_A\n",
      "utf8",
    );
    await symlink(outsideSkills, join(ws, ".forge", "skills"));

    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    const catalog = ctx.getCatalog();
    expect(catalog.skills.some((s) => s.id === "escaped")).toBe(false);
    expect(catalog.warnings.some((w) => w.includes("skill root refused"))).toBe(
      true,
    );
    expect(ctx.getSystemContext()).not.toContain("OUTSIDE_A");
    await expect(ctx.loadSkill("escaped")).rejects.toBeInstanceOf(ForgeError);
    await rm(ws, { recursive: true, force: true });
    await rm(outsideSkills, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("refuses content swapped to an outside symlink after catalog discovery", async () => {
    const ws = join(tmpdir(), `ctx-swap-${process.pid}-${Date.now()}`);
    const outsideDir = `${ws}-outside-swap`;
    await mkdir(ws, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, "SKILL.md"),
      "---\nname: swapped\ndescription: Outside content\n---\nOUTSIDE_SWAP\n",
      "utf8",
    );
    const skillDir = join(ws, ".forge", "skills", "swapped");
    await write(
      join(skillDir, "SKILL.md"),
      "---\nname: swapped\ndescription: Inside content\n---\nINSIDE\n",
    );
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    expect(ctx.getCatalog().skills.some((s) => s.id === "swapped")).toBe(true);

    // Replace SKILL.md with a symlink pointing outside the workspace, without
    // refreshing the catalog.
    await rm(join(skillDir, "SKILL.md"), { force: true });
    await symlink(join(outsideDir, "SKILL.md"), join(skillDir, "SKILL.md"));
    await expect(ctx.loadSkill("swapped")).rejects.toThrow(
      /Symbolic links are refused/,
    );

    await rm(ws, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("refuses a skill directory swapped to a symlink after discovery", async () => {
    const ws = join(tmpdir(), `ctx-dirswap-${process.pid}-${Date.now()}`);
    const outsideDir = `${ws}-outside-dirswap`;
    await mkdir(ws, { recursive: true });
    await mkdir(join(outsideDir, "evil"), { recursive: true });
    await writeFile(
      join(outsideDir, "evil", "SKILL.md"),
      "---\nname: dirswapped\ndescription: Outside dir content\n---\nOUTSIDE_DIR\n",
      "utf8",
    );
    const skillDir = join(ws, ".forge", "skills", "dirswapped");
    await write(
      join(skillDir, "SKILL.md"),
      "---\nname: dirswapped\ndescription: Inside dir content\n---\nINSIDE_DIR\n",
    );
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    expect(ctx.getCatalog().skills.some((s) => s.id === "dirswapped")).toBe(
      true,
    );

    // Replace the whole skill directory with a symlink pointing outside.
    await rm(skillDir, { recursive: true, force: true });
    await symlink(join(outsideDir, "evil"), skillDir);
    await expect(ctx.loadSkill("dirswapped")).rejects.toThrow(
      /symlink|refused/i,
    );

    await rm(ws, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("invalidates the fingerprint on a skill body-only edit", async () => {
    const ws = join(tmpdir(), `ctx-bodyfp-${process.pid}-${Date.now()}`);
    await mkdir(ws, { recursive: true });
    const skillPath = join(ws, ".forge", "skills", "body-skill", "SKILL.md");
    await write(
      skillPath,
      "---\nname: body-skill\ndescription: Stable metadata\n---\nBODY_ONE\n",
    );
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    const before = ctx.getFingerprint();
    // Change only the body; frontmatter (metadata) is unchanged.
    await write(
      skillPath,
      "---\nname: body-skill\ndescription: Stable metadata\n---\nBODY_TWO\n",
    );
    await ctx.refresh();
    const after = ctx.getFingerprint();
    expect(after.hash).not.toBe(before.hash);
    expect(after.version).not.toBe(before.version);
    // Metadata is unchanged, so the catalog entry stays identical.
    expect(ctx.getCatalog().skills[0]?.description).toBe("Stable metadata");
    await rm(ws, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("canonicalizes a/../b to the single target subtree", async () => {
    const ws = join(tmpdir(), `ctx-canon-${process.pid}-${Date.now()}`);
    await mkdir(ws, { recursive: true });
    await write(join(ws, "AGENTS.md"), "# Root\nROOT_BODY\n");
    await write(join(ws, "a", "AGENTS.md"), "# A\nA_BODY\n");
    await write(join(ws, "b", "AGENTS.md"), "# B\nB_BODY\n");
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    const sources = await ctx.resolveInstructions("a/../b");
    // Only root + b apply; `a` must never leak and root must not duplicate.
    expect(sources.map((s) => s.path)).toEqual([
      "AGENTS.md",
      join("b", "AGENTS.md"),
    ]);
    const bodies = sources.map((s) => s.body);
    expect(bodies.some((b) => b.includes("A_BODY"))).toBe(false);
    expect(bodies.filter((b) => b.includes("ROOT_BODY")).length).toBe(1);
    await rm(ws, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("does not emit a symlink warning for a normal absent AGENTS.md", async () => {
    const ws = join(tmpdir(), `ctx-absent-${process.pid}-${Date.now()}`);
    await mkdir(ws, { recursive: true });
    await write(join(ws, "AGENTS.md"), "# Root\nROOT_BODY\n");
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    const sources = await ctx.resolveInstructions("packages/unknown");
    expect(sources.map((s) => s.path)).toEqual(["AGENTS.md"]);
    const warnings = ctx.getCatalog().warnings;
    expect(warnings.some((w) => w.includes("symlink"))).toBe(false);
    await rm(ws, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("emits no warning at all for an empty workspace", async () => {
    const ws = join(tmpdir(), `ctx-empty-${process.pid}-${Date.now()}`);
    await mkdir(ws, { recursive: true });
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    expect(ctx.getCatalog().warnings).toEqual([]);
    const sources = await ctx.resolveInstructions(".");
    expect(sources).toEqual([]);
    await rm(ws, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("refuses an ancestor-symlinked nested AGENTS.md path", async () => {
    const ws = join(tmpdir(), `ctx-anc-${process.pid}-${Date.now()}`);
    const outsideEvil = `${ws}-outside-anc`;
    await mkdir(ws, { recursive: true });
    await mkdir(join(outsideEvil, "sub"), { recursive: true });
    await writeFile(
      join(outsideEvil, "sub", "AGENTS.md"),
      "# Evil\nANC_EVIL\n",
      "utf8",
    );
    await write(join(ws, "AGENTS.md"), "# Root\nROOT_BODY\n");
    await symlink(join(outsideEvil, "sub"), join(ws, "deep"));
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    const sources = await ctx.resolveInstructions("deep");
    expect(sources.every((s) => !s.body.includes("ANC_EVIL"))).toBe(true);
    expect(ctx.getCatalog().warnings.some((w) => w.includes("symlink"))).toBe(
      true,
    );
    await rm(ws, { recursive: true, force: true });
    await rm(outsideEvil, { recursive: true, force: true });
    await ctx.dispose();
  });
});

describe("skill tool registry", () => {
  it("exposes project_context and load_skill read-only", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const registry = createSkillTool(ctx);
    expect(registry.definitions.map((d) => d.function.name).sort()).toEqual(
      [CONTEXT_INSTRUCTION_TOOL_NAME, LOAD_SKILL_TOOL_NAME].sort(),
    );
    const contextResult = await registry.execute(
      toolCall(CONTEXT_INSTRUCTION_TOOL_NAME, { path: "packages/api" }),
      makeToolContext(workspace),
    );
    const parsed = JSON.parse(contextResult.content) as {
      sources: { path: string }[];
      count: number;
    };
    expect(parsed.count).toBe(2);
    expect(parsed.sources[0]?.path).toBe("AGENTS.md");
    const skillResult = await registry.execute(
      toolCall(LOAD_SKILL_TOOL_NAME, { skill: "repo-review" }),
      makeToolContext(workspace),
    );
    const skillParsed = JSON.parse(skillResult.content) as { body: string };
    expect(skillParsed.body).toContain("Repository review");
    const unknown = await registry.execute(
      toolCall(LOAD_SKILL_TOOL_NAME, { skill: "nope" }),
      makeToolContext(workspace),
    );
    expect(unknown.isError).toBe(true);
    await registry.dispose();
    await ctx.dispose();
  });

  it("honors abort signals", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const registry = createSkillTool(ctx);
    const controller = new AbortController();
    controller.abort();
    await expect(
      registry.execute(
        toolCall(CONTEXT_INSTRUCTION_TOOL_NAME, { path: "." }),
        makeToolContext(workspace, controller.signal),
      ),
    ).rejects.toBeInstanceOf(ForgeError);
    await registry.dispose();
    await ctx.dispose();
  });
});

describe("tool bundle", () => {
  it("returns definitions and bound executors", async () => {
    const ctx = await createProjectContext(workspace);
    await ctx.refresh();
    const bundle = createProjectContextTool(ctx);
    expect(bundle.toolNames).toEqual([
      CONTEXT_INSTRUCTION_TOOL_NAME,
      LOAD_SKILL_TOOL_NAME,
    ]);
    const sources = await bundle.executeProjectContext(".");
    expect(sources.length).toBe(1);
    const skill = await bundle.executeLoadSkill("test-driven-repair");
    expect(skill.body).toContain("Test-driven repair");
    await ctx.dispose();
  });
});

describe("bounded descriptor reads", () => {
  it("refuses an oversized SKILL.md found at discovery, not just at stat time", async () => {
    const ws = join(tmpdir(), `ctx-oversize-${process.pid}-${Date.now()}`);
    await mkdir(ws, { recursive: true });
    // 64 KiB is the skill body ceiling; the file is a full KiB over it.
    const skillPath = join(ws, ".forge", "skills", "huge", "SKILL.md");
    await write(
      skillPath,
      `---\nname: huge\ndescription: Too big\n---\n${"A".repeat(64 * 1024 + 1024)}`,
    );
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    // Discovery must refuse the oversize body rather than reading it whole.
    const catalog = ctx.getCatalog();
    expect(catalog.skills.some((s) => s.id === "huge")).toBe(false);
    expect(catalog.warnings.some((w) => w.includes("oversized"))).toBe(true);
    // load is refused for the same reason and never returns a body.
    await expect(ctx.loadSkill("huge")).rejects.toBeInstanceOf(ForgeError);
    await rm(ws, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("refuses a bounded read that grows past the ceiling after discovery", async () => {
    const ws = join(tmpdir(), `ctx-grow-${process.pid}-${Date.now()}`);
    await mkdir(ws, { recursive: true });
    const bigDir = join(ws, "growing");
    const agentsPath = join(bigDir, "AGENTS.md");
    await write(join(ws, "AGENTS.md"), "# Root\nROOT_OK\n");
    // Small at first so the discovery-time stat accepts it.
    await write(agentsPath, "# Small\nSMALL_BODY\n");
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    // Grow the file far past the 64 KiB ceiling without refreshing the
    // catalog; the bounded descriptor read must trip the overflow sentinel.
    await writeFile(agentsPath, "B".repeat(96 * 1024), "utf8");
    const sources = await ctx.resolveInstructions("growing");
    expect(sources.map((s) => s.path)).toEqual(["AGENTS.md"]);
    expect(sources.every((s) => !s.body.includes("BBBBBBBBBB"))).toBe(true);
    expect(ctx.getCatalog().warnings.some((w) => w.includes("oversized"))).toBe(
      true,
    );
    await rm(ws, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("rejects growth that happens after the stat result and before the descriptor read", async () => {
    // This is the regression the review addendum asked for: the fixture is
    // small when the reader's lstat returns, and only then is it grown on disk,
    // immediately before the descriptor read. The previous pathname reader
    // (lstat size check followed by an unbounded whole-file read) accepted this
    // grown content past its advertised ceiling; the descriptor-bounded reader
    // must refuse it and surface an oversized warning.
    const ws = join(
      tmpdir(),
      `ctx-stat-read-race-${process.pid}-${Date.now()}`,
    );
    await mkdir(ws, { recursive: true });
    const growingDir = join(ws, "growing");
    const agentsPath = join(growingDir, "AGENTS.md");
    await write(join(ws, "AGENTS.md"), "# Root\nROOT_OK\n");
    // Initially small: any stat-based size check accepts it.
    await write(agentsPath, "# Small\nSTAT_READ_SMALL\n");
    // Distinctive marker so an accepted body is unambiguously detectable.
    const grownMarker = "GROWN_PAST_CEILING_MARKER";
    const grownBytes = 200 * 1024;
    const ctx = await createProjectContext(ws);
    await ctx.refresh();

    // Arm the narrow, fixture-scoped growth hook: the append happens on disk
    // right after the reader's stat result and just before it opens/reads.
    readHooks.armedPath = agentsPath;
    readHooks.growChunk = grownMarker + "B".repeat(grownBytes);
    readHooks.grown = false;
    readHooks.grownBy = null;
    readHooks.observedLstatSizes = [];
    try {
      const sources = await ctx.resolveInstructions("growing");
      // The stat that the reader relied on saw the fixture while it was small.
      expect(readHooks.observedLstatSizes.length).toBeGreaterThan(0);
      expect(
        readHooks.observedLstatSizes.every((size) => size <= 64 * 1024),
      ).toBe(true);
      // Growth happened on the real fixture at the descriptor boundary, not
      // before the stat: the old pathname reader would have grown here too (at
      // its unbounded `readFile`) and then accepted the excess bytes, while the
      // bounded descriptor reader refuses them.
      expect(readHooks.grown).toBe(true);
      expect(readHooks.grownBy).toBe("open");
      // Root instructions survive; the grown nested body is refused, never
      // returned, and only a warning is surfaced.
      expect(sources.map((s) => s.path)).toEqual(["AGENTS.md"]);
      expect(sources.every((s) => !s.body.includes(grownMarker))).toBe(true);
      expect(
        ctx.getCatalog().warnings.some((w) => w.includes("oversized")),
      ).toBe(true);
    } finally {
      readHooks.armedPath = null;
      readHooks.growChunk = "";
      readHooks.grown = false;
      readHooks.grownBy = null;
      readHooks.observedLstatSizes = [];
    }
    await rm(ws, { recursive: true, force: true });
    await ctx.dispose();
  });

  it("refuses a final component replaced by a symlink after discovery", async () => {
    const ws = join(tmpdir(), `ctx-final-${process.pid}-${Date.now()}`);
    const outsideDir = `${ws}-outside-final`;
    await mkdir(join(ws, ".forge", "skills", "replaced"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, "SECRET.md"),
      "---\nname: replaced\ndescription: Outside\n---\nOUTSIDE_FINAL\n",
      "utf8",
    );
    await write(
      join(ws, ".forge", "skills", "replaced", "SKILL.md"),
      "---\nname: replaced\ndescription: Inside\n---\nINSIDE_FINAL\n",
    );
    const ctx = await createProjectContext(ws);
    await ctx.refresh();
    expect(ctx.getCatalog().skills.some((s) => s.id === "replaced")).toBe(true);
    // Swap the regular SKILL.md for a symlink to outside content.
    await rm(join(ws, ".forge", "skills", "replaced", "SKILL.md"), {
      force: true,
    });
    await symlink(
      join(outsideDir, "SECRET.md"),
      join(ws, ".forge", "skills", "replaced", "SKILL.md"),
    );
    await expect(ctx.loadSkill("replaced")).rejects.toThrow(/symbolic link/i);
    expect(ctx.getSystemContext()).not.toContain("OUTSIDE_FINAL");
    await rm(ws, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await ctx.dispose();
  });
});
