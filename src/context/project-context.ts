import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ForgeError } from "../shared/errors";
import type { ToolDefinition } from "../shared/schemas";
import { createProtectedRootMatcher } from "../tools/protected-roots";

// Bounded limits for all context and skill discovery.
export const CONTEXT_LIMITS = Object.freeze({
  fileByteLimit: 2 * 1024 * 1024,
  instructionBodyLimit: 64 * 1024,
  pathLengthLimit: 4096,
  instructionDepthLimit: 8,
  skillIdLengthLimit: 128,
  descriptionLengthLimit: 1024,
  skillBodyLimit: 64 * 1024,
  catalogSkillLimit: 256,
  warningLimit: 64,
});

export const CONTEXT_INSTRUCTION_TOOL_NAME = "project_context" as const;
export const LOAD_SKILL_TOOL_NAME = "load_skill" as const;

export interface ContextFileSignature {
  readonly path: string;
  readonly signature: string;
}

export interface ContextFingerprint {
  readonly hash: string;
  readonly version: string;
  readonly signatures: readonly ContextFileSignature[];
}

export interface InstructionSource {
  readonly path: string;
  readonly order: number;
  readonly bytes: number;
  readonly body: string;
}

export type SkillProvenance = "workspace-forge" | "workspace-agents" | "user";

export interface SkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string | null;
  readonly sourceDirectory: string;
  readonly provenance: SkillProvenance;
}

export interface ProjectContextCatalog {
  readonly workspace: string;
  readonly instructionSources: readonly InstructionSource[];
  readonly skills: readonly SkillRecord[];
  readonly warnings: readonly string[];
  readonly counts: {
    readonly instructions: number;
    readonly skills: number;
    readonly warnings: number;
  };
}

export interface ProjectContextOptions {
  readonly protectedRoots?: readonly string[];
  readonly extraSkillDirectories?: readonly string[];
  readonly now?: () => number;
}

export type SkillReadMode = "contained" | "explicit-root" | "skill-directory";

// Node error codes that must propagate as real failures instead of being
// reinterpreted as "the entry is absent" or "the path is a symlink escape".
const REAL_IO_ERROR_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
  "EIO",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENAMETOOLONG",
  "ENOTDIR",
  "EISDIR",
]);

function isMissingError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function asRealIoError(error: unknown): Error | null {
  if (typeof error !== "object" || error === null || !("code" in error))
    return null;
  const { code } = error as { code?: unknown };
  return typeof code === "string" && REAL_IO_ERROR_CODES.has(code)
    ? (error as unknown as Error)
    : null;
}

async function lstatEntry(
  absolute: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(absolute);
  } catch (error) {
    if (isMissingError(error)) return null;
    const real = asRealIoError(error);
    if (real) throw real;
    return null;
  }
}

/**
 * Resolve the real, symlink-free location of an existing entry. Absent
 * entries return null; a symlink (or an over-long symlink chain) anywhere on
 * the path resolves to null so callers can classify it as a containment
 * violation rather than a filesystem failure.
 */
async function resolveContainedRealpath(
  absolute: string,
): Promise<string | null> {
  try {
    return await realpath(absolute);
  } catch (error) {
    if (isMissingError(error) || hasErrorCode(error, "ELOOP")) return null;
    const real = asRealIoError(error);
    if (real) throw real;
    return null;
  }
}

/**
 * Best-effort, cooperative filesystem boundary. Node exposes `O_NOFOLLOW` so
 * the final path component is opened without following a symlink, but it does
 * not expose portable `openat`/`O_DIRECTORY` directory-relative traversal, and
 * there is no atomic "open and stat" for ancestors. The read below therefore
 * refuses a replaced final component and refuses a target whose identity
 * changed across the open, but it cannot defend against an adversary with
 * arbitrary OS-level capabilities racing ancestor directories; the guarantee
 * is a cooperative one against replacement of last-known entries.
 */

/** Bounded read budget: `byteLimit` of content plus one sentinel byte. */
function readBudget(byteLimit: number): number {
  return byteLimit + 1;
}

/** File identity independent of timestamps and of hardlink spelling. */
function sameFileIdentity(
  a: Stats | BigIntStats,
  b: Stats | BigIntStats,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Identity plus the size/mtime the descriptor was opened with. */
function sameFileState(
  a: Stats | BigIntStats,
  b: Stats | BigIntStats,
): boolean {
  return sameFileIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Bounded regular-file read through a single descriptor. The final component
 * is opened with `O_NOFOLLOW` (a replacement symlink is refused at open), the
 * descriptor's own stat must match the pre-open `lstat` identity, and the read
 * stops at `byteLimit + 1` bytes so a file that grows after discovery still
 * trips the overflow sentinel and is refused. The descriptor's bytes are
 * authoritative: no unbounded buffering of the path can occur.
 */
async function readBoundedDescriptorFile(
  absolutePath: string,
  byteLimit: number,
): Promise<string | null> {
  const before = await lstatEntry(absolutePath);
  if (before === null) return null;
  if (before.isSymbolicLink()) {
    throw new ContextContentError(
      "symlink",
      "Symbolic links are refused in project context.",
    );
  }
  if (!before.isFile()) {
    throw new ContextContentError(
      "symlink",
      "Non-regular files are refused in project context.",
    );
  }
  if (before.size > byteLimit) {
    throw new ContextContentError(
      "oversized",
      `File exceeds ${byteLimit} byte ceiling.`,
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new ContextContentError(
        "symlink",
        "Symbolic links are refused in project context.",
      );
    }
    if (isMissingError(error)) {
      throw new ContextContentError(
        "symlink",
        "File was replaced during read; refusing.",
      );
    }
    const real = asRealIoError(error);
    if (real) throw real;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new ContextContentError(
        "symlink",
        "Non-regular files are refused in project context.",
      );
    }
    // Refuse when the entry was replaced between lstat and open, and refuse
    // when it was replaced while the descriptor was open (a whole-file swap
    // changes the inode; a size change trips the overflow sentinel below).
    if (!sameFileIdentity(before, opened)) {
      throw new ContextContentError(
        "symlink",
        "File was replaced during read; refusing.",
      );
    }
    const budget = readBudget(byteLimit);
    const buffer = Buffer.alloc(budget);
    let length = 0;
    while (length < budget) {
      const chunk = await handle.read(buffer, length, budget - length, length);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length >= budget || length > byteLimit) {
      throw new ContextContentError(
        "oversized",
        `File exceeds ${byteLimit} byte ceiling.`,
      );
    }
    if (!sameFileState(opened, await handle.stat())) {
      throw new ContextContentError(
        "symlink",
        "File was replaced during read; refusing.",
      );
    }
    const content = buffer.subarray(0, length);
    if (content.includes(0)) {
      throw new ContextContentError("binary", "Binary content refused.");
    }
    const text = content.toString("utf8");
    if (looksSecret(text)) {
      throw new ContextContentError(
        "sensitive",
        "Secret-shaped content refused.",
      );
    }
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Bounded regular-file read that refuses links, oversize and binary content.
 * Content is read through a single descriptor opened `O_NOFOLLOW` (see
 * `readBoundedDescriptorFile`), so a symlink swapped in as the final component
 * after discovery is refused at open, a target whose identity changes is
 * refused, and growth past the ceiling trips the overflow sentinel instead of
 * reading whole. The boundary is cooperative: ancestor-directory races are out
 * of scope (see the module note above `readBoundedDescriptorFile`).
 */
async function readBoundedRegularFile(
  absolutePath: string,
  relativePath: string,
  byteLimit: number,
): Promise<string | null> {
  if (relativePath.length > CONTEXT_LIMITS.pathLengthLimit) {
    throw new ContextContentError("oversized", "Path exceeds length limit.");
  }
  if (isSensitivePath(relativePath)) {
    throw new ContextContentError("sensitive", "Sensitive file refused.");
  }
  return readBoundedDescriptorFile(absolutePath, byteLimit);
}

// ---------------------------------------------------------------------------
// Content safety: mirrors the core local tool policy classes of binary and
// secret material. Nothing here grants permissions; it only refuses data.
// ---------------------------------------------------------------------------

function isSensitivePath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some(
      (part) =>
        /^(?:\.env.*|\.ssh|\.config|\.git)$/i.test(part) ||
        /^id_(?:rsa|ed25519|ecdsa|dsa)$/i.test(part) ||
        /credentials/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}

function looksSecret(text: string): boolean {
  return (
    /^-----BEGIN [A-Z ]*PRIVATE KEY-----/m.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/.test(
      text,
    ) ||
    /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*(?:[A-Za-z0-9_-]{8,}|"[A-Za-z0-9_-]{8,}"|'[A-Za-z0-9_-]{8,}')\s*$/im.test(
      text,
    )
  );
}

export class ContextContentError extends Error {
  readonly reason: "binary" | "oversized" | "sensitive" | "symlink";
  constructor(reason: ContextContentError["reason"], message: string) {
    super(message);
    this.name = "ContextContentError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md instruction discovery
// ---------------------------------------------------------------------------

/**
 * Canonicalize a workspace-relative path to collapsed segments. `..` segments
 * are resolved textually and rejected when they would escape the workspace, so
 * `a/../b` yields the single segment `b` rather than the raw `a/../b` spelling.
 * Parent segments are handled consistently: the caller receives only real
 * ancestor segments, so a sibling subtree's instructions can never leak in.
 */
function canonicalSegments(relativePath: string): readonly string[] {
  if (relativePath.includes("\0")) {
    throw new ForgeError("invalid_input", "Path contains NUL.");
  }
  if (relativePath.length > CONTEXT_LIMITS.pathLengthLimit) {
    throw new ForgeError("invalid_input", "Path exceeds length limit.");
  }
  const parts = relativePath
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length === 0) {
        throw new ForgeError(
          "invalid_input",
          "Path escapes workspace; parent search is not permitted.",
        );
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  if (stack.length > CONTEXT_LIMITS.instructionDepthLimit) {
    throw new ForgeError("invalid_input", "Path exceeds depth limit.");
  }
  return stack;
}

/** Instruction chain for a canonical segment list; root is `"."`. */
function instructionChain(segments: readonly string[]): readonly string[] {
  const chain: string[] = [];
  for (let i = 0; i <= segments.length; i += 1) {
    chain.push(segments.slice(0, i).join(sep) || ".");
  }
  return chain;
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter parsing (bounded YAML-lite: name/description/version)
// ---------------------------------------------------------------------------

export function parseFrontmatter(text: string): {
  name: string | null;
  description: string | null;
  version: string | null;
  body: string;
} {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { name: null, description: null, version: null, body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { name: null, description: null, version: null, body: "" };
  }
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  let name: string | null = null;
  let description: string | null = null;
  let version: string | null = null;
  for (const line of header.split("\n").slice(0, 20)) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, "").trim();
    if (
      key === "name" &&
      value.length > 0 &&
      value.length <= CONTEXT_LIMITS.skillIdLengthLimit
    ) {
      name = value;
    } else if (
      key === "description" &&
      value.length > 0 &&
      value.length <= CONTEXT_LIMITS.descriptionLengthLimit
    ) {
      description = value;
    } else if (key === "version" && value.length > 0 && value.length <= 32) {
      version = value;
    }
  }
  return { name, description, version, body };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function hashSignature(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

// True when `target` is inside (or equal to) `root`; rejects escapes.
function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface ProjectContextService {
  readonly workspace: string;
  refresh(): Promise<void>;
  getSystemContext(): string;
  getCatalog(): ProjectContextCatalog;
  getFingerprint(): ContextFingerprint;
  loadSkill(
    id: string,
    signal?: AbortSignal,
  ): Promise<SkillRecord & { body: string }>;
  resolveInstructions(
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<readonly InstructionSource[]>;
  dispose(): Promise<void>;
}

export async function createProjectContext(
  workspace: string,
  options: ProjectContextOptions = {},
): Promise<ProjectContextService> {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new ForgeError("invalid_input", "Workspace must be a nonempty path.");
  }
  const isProtected = await createProtectedRootMatcher(options.protectedRoots);
  const root = resolve(workspace);
  const rootInfo = await lstat(root).catch(() => {
    throw new ForgeError("invalid_input", "Workspace is not accessible.");
  });
  if (!rootInfo.isDirectory()) {
    throw new ForgeError("invalid_input", "Workspace must be a directory.");
  }

  // Explicit user-owned skill directories: absolute paths only, credential
  // stores refused. They are the only places outside the workspace we read.
  // Each root is pre-resolved at creation so a symlink ancestor that already
  // escapes the caller-declared directory is rejected before any read, while a
  // legitimately symlinked (e.g. dotfile-managed) user root is preserved.
  const userSkillDirectoryCandidates = (options.extraSkillDirectories ?? [])
    .filter((dir) => isAbsolute(dir) && !dir.includes("\0"))
    .map((dir) => resolve(dir))
    .filter(
      (dir) =>
        !dir
          .split(/[\\/]/)
          .some(
            (part) =>
              /^(?:\.ssh|\.config|credentials)$/i.test(part) ||
              /\.(?:pem|key|p12|pfx)$/i.test(part),
          ),
    );
  const userSkillDirectories: {
    declared: string;
    resolved: string;
  }[] = [];
  const preflightWarnings: string[] = [];
  for (const declared of userSkillDirectoryCandidates) {
    const resolved = await resolveContainedRealpath(declared);
    if (resolved === null) {
      // Absent roots are simply empty; only present-but-escaping roots warn.
      const info = await lstatEntry(declared);
      if (info !== null) {
        pushWarning(
          preflightWarnings,
          `user skill root refused (containment): ${declared}`,
        );
      }
      continue;
    }
    if (isProtected(declared) || isProtected(resolved)) continue;
    userSkillDirectories.push({ declared, resolved });
  }

  let cachedInstructions: readonly InstructionSource[] = [];
  let cachedSkills: readonly SkillRecord[] = [];
  let cachedSkillSignatures: readonly {
    record: SkillRecord;
    signature: string;
  }[] = [];
  let cachedSkillBases: Map<string, string> = new Map();
  let cachedWarnings: readonly string[] = [];
  let cachedSystemContext = "";
  let cachedFingerprint: ContextFingerprint = {
    hash: "",
    version: "",
    signatures: [],
  };
  let disposed = false;
  const versionClock = options.now ?? Date.now;
  let lastTick = 0;

  function check(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ForgeError("cancelled", "Context operation cancelled.");
    }
  }

  function pushWarning(sink: string[], warning: string): void {
    if (sink.length >= CONTEXT_LIMITS.warningLimit) return;
    sink.push(warning);
  }

  // ---------------------------------------------------------------------
  // Containment policy: every read path is resolved through symlink-free
  // realpath and must stay inside its declared root. For workspace instruction
  // roots the resolved path must also equal the lexical path, so a symlinked
  // ancestor (e.g. `.forge/skills` or a linked subtree) is refused rather than
  // read through. Explicit user skill roots may themselves be symlinks, so
  // only containment (resolved-inside-declared) is required for them.
  // ---------------------------------------------------------------------
  function resolveWithinRoot(declaredRoot: string, candidate: string): boolean {
    return insideRoot(declaredRoot, candidate);
  }

  async function resolveContainedFile(
    declaredRoot: string,
    candidate: string,
    mode: SkillReadMode,
  ): Promise<{ absolute: string; resolved: string }> {
    if (isProtected(candidate) || !resolveWithinRoot(declaredRoot, candidate)) {
      throw new ContextContentError(
        "symlink",
        "Symbolic link escape refused in project context.",
      );
    }
    const resolved = await resolveContainedRealpath(candidate);
    if (
      resolved === null ||
      isProtected(resolved) ||
      !insideRoot(declaredRoot, resolved)
    ) {
      throw new ContextContentError(
        "symlink",
        "Symbolic link escape refused in project context.",
      );
    }
    if (mode === "contained" && resolved !== candidate) {
      throw new ContextContentError(
        "symlink",
        "Symbolic link escape refused in project context.",
      );
    }
    return { absolute: candidate, resolved };
  }

  async function loadInstructionFile(
    segment: string,
    sink: string[],
  ): Promise<InstructionSource | null> {
    const relPath = segment === "." ? "AGENTS.md" : `${segment}${sep}AGENTS.md`;
    const absolutePath = join(root, relPath);
    if (isProtected(absolutePath)) return null;
    try {
      // Absence is normal for a subtree: check before applying containment so a
      // missing AGENTS.md never produces a misleading symlink warning.
      const info = await lstatEntry(absolutePath);
      if (info === null) return null;
      // A symlinked ancestor directory would let content escape the workspace
      // through read-through; require the resolved path to stay inside root and
      // to match the lexical path, then read bounded regular content. The read
      // targets the resolved location, so a symlinked final component (already
      // refused above) cannot redirect the open either.
      const contained = await resolveContainedFile(
        root,
        absolutePath,
        "contained",
      );
      const text = await readBoundedRegularFile(
        contained.resolved,
        relPath,
        CONTEXT_LIMITS.instructionBodyLimit,
      );
      if (text === null) return null;
      return {
        path: relPath,
        order: 0,
        bytes: Buffer.byteLength(text, "utf8"),
        body: text,
      };
    } catch (error) {
      if (error instanceof ContextContentError) {
        pushWarning(sink, `instruction ${error.reason}: ${relPath}`);
      }
      return null;
    }
  }

  async function discoverSkills(): Promise<{
    records: SkillRecord[];
    signed: { record: SkillRecord; signature: string }[];
    warnings: string[];
    resolvedBases: Map<string, string>;
  }> {
    const resolvedBases = new Map<string, string>();
    const workspaceRoots: readonly {
      declared: string;
      provenance: SkillProvenance;
    }[] = [
      {
        declared: join(root, ".forge", "skills"),
        provenance: "workspace-forge",
      },
      {
        declared: join(root, ".agents", "skills"),
        provenance: "workspace-agents",
      },
    ];
    const records: SkillRecord[] = [];
    const signed: { record: SkillRecord; signature: string }[] = [];
    const warnings: string[] = [...preflightWarnings];
    const seen = new Set<string>();

    const collectRoot = async (
      declaredRoot: string,
      provenance: SkillProvenance,
      layout: "workspace" | "user",
    ): Promise<void> => {
      if (isProtected(declaredRoot)) return;
      const rootInfo = await lstatEntry(declaredRoot);
      if (rootInfo === null) return;
      // Workspace skill roots must be real directories reached without following
      // a symlink; `.forge/skills` swapped for a link is refused. Explicitly
      // configured user roots may legitimately be symlinks and are allowed.
      if (rootInfo.isSymbolicLink()) {
        if (layout === "workspace") {
          warnings.push(
            `skill root refused (symlink): ${relative(root, declaredRoot) || "."}`,
          );
          return;
        }
      } else if (!rootInfo.isDirectory()) {
        return;
      }
      // Containment base: workspace roots must resolve to themselves; explicitly
      // configured user roots may be symlinks and are contained by their own
      // resolved (real) location.
      const resolvedRoot = await resolveContainedRealpath(declaredRoot);
      if (resolvedRoot === null) {
        warnings.push(
          `skill root refused (symlink): ${relative(root, declaredRoot) || "."}`,
        );
        return;
      }
      if (layout === "workspace" && resolvedRoot !== declaredRoot) {
        warnings.push(
          `skill root refused (symlink): ${relative(root, declaredRoot) || "."}`,
        );
        return;
      }
      if (isProtected(resolvedRoot)) return;
      const base = layout === "workspace" ? declaredRoot : resolvedRoot;
      let entries: Dirent[];
      try {
        entries = await readdir(base, { withFileTypes: true });
      } catch (error) {
        const real = asRealIoError(error);
        if (real) throw real;
        return;
      }
      for (const item of entries) {
        if (records.length >= CONTEXT_LIMITS.catalogSkillLimit) {
          warnings.push("Skill catalog limit reached; further skills ignored.");
          return;
        }
        if (!item.isDirectory() || item.isSymbolicLink()) continue;
        const skillDir = join(base, item.name);
        const displayDirectory =
          layout === "workspace"
            ? relative(root, skillDir) || item.name
            : skillDir;
        let text: string | null;
        try {
          const containedDir = await resolveContainedFile(
            base,
            skillDir,
            layout === "workspace" ? "contained" : "skill-directory",
          );
          text = await readBoundedRegularFile(
            join(containedDir.resolved, "SKILL.md"),
            join(displayDirectory, "SKILL.md"),
            CONTEXT_LIMITS.skillBodyLimit,
          );
        } catch (error) {
          if (error instanceof ContextContentError) {
            warnings.push(`skill ${error.reason}: ${item.name}`);
          } else {
            warnings.push(`skill missing SKILL.md: ${item.name}`);
          }
          continue;
        }
        if (text === null) {
          warnings.push(`skill missing SKILL.md: ${item.name}`);
          continue;
        }
        // Cover bounded actual content: a body-only edit changes this signature
        // even though the prompt only sees metadata until load_skill runs.
        const signature = hashSignature(
          `${provenance}:${displayDirectory}:${Buffer.byteLength(text, "utf8")}:${text}`,
        );
        const parsed = parseFrontmatter(text);
        const id = parsed.name ?? item.name;
        if (!id || id.length > CONTEXT_LIMITS.skillIdLengthLimit) {
          warnings.push(`skill invalid metadata (missing name): ${item.name}`);
          continue;
        }
        if (!parsed.description) {
          warnings.push(
            `skill invalid metadata (missing description): ${item.name}`,
          );
          continue;
        }
        if (seen.has(id)) {
          warnings.push(
            `duplicate skill id ignored: ${id} (from ${provenance})`,
          );
          continue;
        }
        seen.add(id);
        const record: SkillRecord = {
          id,
          name: parsed.name ?? id,
          description: parsed.description,
          version: parsed.version,
          sourceDirectory: displayDirectory,
          provenance,
        };
        records.push(record);
        signed.push({ record, signature });
        resolvedBases.set(id, base);
      }
    };

    for (const entry of workspaceRoots) {
      await collectRoot(entry.declared, entry.provenance, "workspace");
    }
    for (const dir of userSkillDirectories) {
      await collectRoot(dir.declared, "user", "user");
    }
    return { records, signed, warnings, resolvedBases };
  }

  function buildSystemContext(
    instructions: readonly InstructionSource[],
    skills: readonly SkillRecord[],
    warnings: readonly string[],
  ): string {
    const sections: string[] = [];
    if (instructions.length > 0) {
      sections.push("# Project instructions");
      for (const source of instructions) {
        sections.push(`## Source: ${source.path}\n${source.body.trim()}`);
      }
    }
    if (skills.length > 0) {
      sections.push(
        [
          "# Available skills",
          ...skills.map(
            (skill) =>
              `- id: ${skill.id} | name: ${skill.name} | version: ${skill.version ?? "-"} | ${skill.description}`,
          ),
          "Load a skill with the load_skill tool before relying on it.",
        ].join("\n"),
      );
    }
    if (warnings.length > 0) {
      sections.push(
        [
          "# Context warnings",
          ...warnings.slice(0, CONTEXT_LIMITS.warningLimit),
        ].join("\n"),
      );
    }
    return sections.join("\n\n");
  }

  const service: ProjectContextService = {
    workspace: root,
    async refresh(): Promise<void> {
      check();
      if (disposed) {
        throw new ForgeError("internal", "Context service disposed.");
      }
      const collectedWarnings: string[] = [];
      const rootInstruction = await loadInstructionFile(".", collectedWarnings);
      cachedInstructions = rootInstruction ? [rootInstruction] : [];
      const { records, signed, warnings, resolvedBases } =
        await discoverSkills();
      cachedSkills = Object.freeze(records);
      cachedSkillSignatures = signed;
      cachedSkillBases = resolvedBases;
      for (const warning of warnings) pushWarning(collectedWarnings, warning);
      cachedWarnings = Object.freeze(
        collectedWarnings.slice(0, CONTEXT_LIMITS.warningLimit),
      );
      cachedSystemContext = buildSystemContext(
        cachedInstructions,
        cachedSkills,
        cachedWarnings,
      );
      const signatureEntries: ContextFileSignature[] = [];
      for (const source of cachedInstructions) {
        signatureEntries.push({
          path: source.path,
          signature: hashSignature(
            `${source.path}:${source.bytes}:${source.body}`,
          ),
        });
      }
      // Skill signatures cover bounded actual SKILL.md content, so a body-only
      // edit invalidates the fingerprint even though the catalog exposes only
      // metadata until load_skill is called.
      for (const { record, signature } of cachedSkillSignatures) {
        signatureEntries.push({
          path: `skill:${record.id}`,
          signature,
        });
      }
      const tick = versionClock();
      lastTick = tick > lastTick ? tick : lastTick + 1;
      cachedFingerprint = {
        hash: hashSignature(JSON.stringify(signatureEntries)),
        version: `${lastTick}`,
        signatures: Object.freeze(signatureEntries),
      };
    },
    getSystemContext(): string {
      return cachedSystemContext;
    },
    getCatalog(): ProjectContextCatalog {
      return {
        workspace: root,
        instructionSources: cachedInstructions,
        skills: cachedSkills,
        warnings: cachedWarnings,
        counts: {
          instructions: cachedInstructions.length,
          skills: cachedSkills.length,
          warnings: cachedWarnings.length,
        },
      };
    },
    getFingerprint(): ContextFingerprint {
      return cachedFingerprint;
    },
    async resolveInstructions(
      relativePath: string,
      signal?: AbortSignal,
    ): Promise<readonly InstructionSource[]> {
      check(signal);
      const normalized = canonicalSegments(relativePath);
      const chain = instructionChain(normalized);
      const sources: InstructionSource[] = [];
      const sink = [...cachedWarnings];
      let order = 0;
      for (const segment of chain) {
        check(signal);
        const loaded = await loadInstructionFile(segment, sink);
        if (loaded) {
          sources.push({ ...loaded, order });
          order += 1;
        }
      }
      cachedWarnings = Object.freeze(
        sink.slice(0, CONTEXT_LIMITS.warningLimit),
      );
      return Object.freeze(sources);
    },
    async loadSkill(id: string, signal?: AbortSignal) {
      check(signal);
      const record = cachedSkills.find((skill) => skill.id === id);
      if (!record) {
        throw new ForgeError("invalid_input", `Unknown skill: ${id}`);
      }
      // Re-enforce containment at load time: a skill directory replaced by a
      // symlink after catalog discovery must not read outside content.
      const base = cachedSkillBases.get(id);
      if (base === undefined) {
        throw new ForgeError("internal", `Skill base missing: ${id}`);
      }
      const skillDirectory =
        record.provenance === "user"
          ? record.sourceDirectory
          : join(root, record.sourceDirectory);
      const containedDir = await resolveContainedFile(
        base,
        skillDirectory,
        record.provenance === "user" ? "skill-directory" : "contained",
      );
      const body = await readBoundedRegularFile(
        join(containedDir.resolved, "SKILL.md"),
        join(record.sourceDirectory, "SKILL.md"),
        CONTEXT_LIMITS.skillBodyLimit,
      );
      if (body === null) {
        throw new ForgeError(
          "not_found",
          `Skill file is no longer available: ${id}`,
        );
      }
      return { ...record, body };
    },
    async dispose(): Promise<void> {
      disposed = true;
      cachedInstructions = [];
      cachedSkills = [];
      cachedSkillSignatures = [];
      cachedSystemContext = "";
      cachedWarnings = [];
    },
  };
  return service;
}

// ---------------------------------------------------------------------------
// Tool definitions and argument schemas (composed by host/combined registry)
// ---------------------------------------------------------------------------

export const contextInstructionDefinition: ToolDefinition = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: CONTEXT_INSTRUCTION_TOOL_NAME,
    description:
      "Load AGENTS.md project instructions applying to a workspace-relative path. Returns root and nested instruction sources in precedence order (outermost first, most-specific last). Read-only; never executes project commands.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        path: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: CONTEXT_LIMITS.pathLengthLimit,
          default: ".",
        }),
      }),
      required: Object.freeze([]),
      additionalProperties: false,
    }),
  }),
});

export const loadSkillDefinition: ToolDefinition = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: LOAD_SKILL_TOOL_NAME,
    description:
      "Load a skill package body by id. Returns bounded SKILL.md content and the source directory. Skill files are instructions only and never grant permissions.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        skill: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: CONTEXT_LIMITS.skillIdLengthLimit,
        }),
      }),
      required: Object.freeze(["skill"]),
      additionalProperties: false,
    }),
  }),
});

export const contextPathArgumentsSchema = z
  .object({
    tool: z.literal(CONTEXT_INSTRUCTION_TOOL_NAME),
    path: z.string().min(1).max(CONTEXT_LIMITS.pathLengthLimit).default("."),
  })
  .strict()
  .readonly();
export const loadSkillArgumentsSchema = z
  .object({
    tool: z.literal(LOAD_SKILL_TOOL_NAME),
    skill: z.string().min(1).max(CONTEXT_LIMITS.skillIdLengthLimit),
  })
  .strict()
  .readonly();

export interface ProjectContextToolBundle {
  readonly definitions: readonly ToolDefinition[];
  readonly toolNames: readonly [
    typeof CONTEXT_INSTRUCTION_TOOL_NAME,
    typeof LOAD_SKILL_TOOL_NAME,
  ];
  readonly executeProjectContext: ProjectContextService["resolveInstructions"];
  readonly executeLoadSkill: ProjectContextService["loadSkill"];
}

export function createProjectContextTool(
  context: ProjectContextService,
): ProjectContextToolBundle {
  return {
    definitions: Object.freeze([
      contextInstructionDefinition,
      loadSkillDefinition,
    ]),
    toolNames: [CONTEXT_INSTRUCTION_TOOL_NAME, LOAD_SKILL_TOOL_NAME],
    executeProjectContext: (relativePath, signal) =>
      context.resolveInstructions(relativePath, signal),
    executeLoadSkill: (skill, signal) => context.loadSkill(skill, signal),
  };
}
