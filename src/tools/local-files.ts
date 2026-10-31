import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { z } from "zod";
import { isSensitivePath } from "../shared/content-safety";
import type { ToolContext } from "../shared/contracts";
import { createDiffPatch } from "../shared/diff";
import { ForgeError } from "../shared/errors";
import type {
  FileChange,
  JsonValue,
  ToolCall,
  ToolResult,
} from "../shared/schemas";
import type { CheckpointStore } from "../store/checkpoints";
import {
  createLineMatcher,
  globMatcher,
  pageEntries,
  relativeQueryPath,
} from "./file-query";
import { check, errorCode, fail, result, signature } from "./local-common";
import type { createLocalPolicy } from "./local-policy";
import {
  DEPTH_LIMIT,
  ENTRY_LIMIT,
  type argumentsSchema,
} from "./local-schemas";
import { WorkspacePathError, type WorkspacePathGuard } from "./path-guard";

export function createLocalFiles({
  options,
  guard,
  readReceipts,
  policy,
}: {
  options: { checkpointStore?: CheckpointStore };
  guard: WorkspacePathGuard;
  readReceipts: Map<string, string>;
  policy: ReturnType<typeof createLocalPolicy>;
}) {
  const {
    receiptKey,
    requireRead,
    containsKnown,
    safeText,
    invalidate,
    targetName,
    readTarget,
    read,
  } = policy;
  let writeTail: Promise<void> = Promise.resolve();
  async function serialized<T>(action: () => Promise<T>): Promise<T> {
    const prior = writeTail;
    let release: () => void = () => undefined;
    writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }
  async function commit(
    relativePath: string,
    text: string,
    signal: AbortSignal,
    expected?: string,
    toolCallId?: string,
    sessionId?: string,
  ): Promise<readonly FileChange[]> {
    safeText(text);
    if (isSensitivePath(relativePath))
      fail("Sensitive paths are not permitted.");
    const path = await guard.resolveWrite(relativePath);
    const name = targetName(path);
    const parent = dirname(path);
    const parentRelative = relative(guard.root, parent) || ".";
    await guard.resolveRead(parentRelative);
    const parentStamp = await lstat(parent);
    let before: string | null = null;
    let beforeStamp: string | undefined;
    let beforeMode: number | null = null;
    try {
      const original = await readTarget(path, signal);
      before = original.text;
      beforeStamp = original.stamp;
      beforeMode = (await lstat(path)).mode & 0o7777;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (beforeStamp !== undefined) {
      if (!sessionId) fail("Session identity is required for file writes.");
      requireRead(sessionId, path, beforeStamp);
    }
    if (expected !== undefined && expected !== beforeStamp)
      fail("File changed before editing; read_file again and retry.");
    check(signal);
    if (before === text) return [];
    // Compute on complete originals before mutation, not truncated display previews.
    // The shared generator reports budget exhaustion without inventing a rewrite.
    const patch = createDiffPatch(before ?? "", text);
    const temporary = join(parent, `.forge-${randomUUID()}.tmp`);
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    let renamed = false;
    let checkpoint: Awaited<ReturnType<CheckpointStore["begin"]>> | undefined;
    try {
      await handle.writeFile(text, "utf8");
      if (beforeMode !== null) await handle.chmod(beforeMode);
      await handle.sync();
      const written = await handle.stat();
      await handle.close();
      await guard.resolveRead(parentRelative);
      const currentParent = await lstat(parent);
      if (
        currentParent.dev !== parentStamp.dev ||
        currentParent.ino !== parentStamp.ino
      )
        fail("Parent directory changed; retry.");
      if ((await guard.resolveWrite(relativePath)) !== path)
        fail("Target changed; retry.");
      let currentStamp: string | undefined;
      try {
        currentStamp = signature(await lstat(path));
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (currentStamp !== beforeStamp)
        fail("File changed before commit; retry.");
      check(signal);
      if (options.checkpointStore) {
        if (!sessionId || !toolCallId) fail("Checkpoint identity is required.");
        checkpoint = await options.checkpointStore.begin({
          path: name,
          sessionId,
          toolCallId,
          before: before === null ? null : Buffer.from(before, "utf8"),
          beforeMode,
          after: Buffer.from(text, "utf8"),
          signal,
        });
      }
      check(signal);
      await rename(temporary, path);
      renamed = true;
      if (sessionId) {
        const current = await lstat(path);
        const key = receiptKey(sessionId, path);
        if (
          current.ino === written.ino &&
          current.dev === written.dev &&
          current.size === written.size &&
          current.mtimeMs === written.mtimeMs
        ) {
          readReceipts.set(key, signature(current));
        } else readReceipts.delete(key);
      }
      invalidate(path);
      await checkpoint?.complete();
      return [
        {
          path: name,
          kind: before === null ? "created" : "modified",
          patch,
        },
      ];
    } finally {
      await handle.close();
      if (!renamed) await unlink(temporary);
      await checkpoint?.release();
    }
  }
  async function serializedFile<T>(
    path: string,
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const resolved = await guard.resolveWrite(path);
    const key = receiptKey(sessionId, resolved);
    const admitted = readReceipts.get(key);
    return serialized(async () => {
      if (readReceipts.get(key) !== admitted)
        fail(
          "File changed while this edit was queued; read_file again before editing.",
        );
      return action();
    });
  }
  async function directories(
    relativePath: string,
    signal: AbortSignal,
  ): Promise<string> {
    check(signal);
    if (isSensitivePath(relativePath))
      fail("Sensitive paths are not permitted.");
    if (relativePath.includes("\\") && sep !== "\\")
      fail("Backslash paths are not supported.");
    // The guard parses the entire lexical spelling before inspecting any entry.
    // Missing parents are expected here; all other failures must precede mkdir.
    try {
      await guard.resolveRead(relativePath);
    } catch (error: unknown) {
      if (!(error instanceof WorkspacePathError) || error.code !== "MISSING")
        throw error;
    }
    const parts = relativePath.split(/[\\/]/);
    let current = ".";
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      current = `${current}/${part}`;
      check(signal);
      try {
        const existing = await guard.resolveRead(current);
        targetName(existing);
        if (!(await lstat(existing)).isDirectory())
          fail("Expected a directory.");
      } catch (error: unknown) {
        if (!(error instanceof WorkspacePathError) || error.code !== "MISSING")
          throw error;
        const destination = await guard.resolveWrite(current);
        targetName(destination);
        check(signal);
        await mkdir(destination, { mode: 0o700 });
        await guard.resolveRead(current);
      }
    }
    return targetName(await guard.resolveRead(relativePath));
  }
  async function walk(
    relativePath: string,
    recursive: boolean,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      entries: readonly Readonly<{
        path: string;
        kind: "file" | "directory";
      }>[];
      truncated: boolean;
    }>
  > {
    if (isSensitivePath(relativePath))
      fail("Sensitive paths are not permitted.");
    const start = await guard.resolveRead(relativePath);
    targetName(start);
    const entries: {
      readonly path: string;
      readonly kind: "file" | "directory";
    }[] = [];
    let truncated = false;
    let visited = 0;
    const excluded = new Set([
      "node_modules",
      ".git",
      ".build",
      "dist",
      "cache",
      ".cache",
    ]);
    async function visit(path: string, depth: number): Promise<void> {
      check(signal);
      const name = targetName(path);
      await guard.resolveRead(name);
      const info = await lstat(path);
      if (info.isFile()) {
        if (entries.length >= ENTRY_LIMIT) {
          truncated = true;
          return;
        }
        entries.push({ path: name, kind: "file" });
        return;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      const { opendir } = await import("node:fs/promises");
      const directory = await opendir(path);
      for await (const item of directory) {
        check(signal);
        visited += 1;
        if (visited > ENTRY_LIMIT || entries.length >= ENTRY_LIMIT) {
          truncated = true;
          break;
        }
        if (
          excluded.has(item.name) ||
          isSensitivePath(item.name) ||
          containsKnown(item.name) ||
          item.isSymbolicLink()
        )
          continue;
        const child = join(path, item.name);
        if (guard.isProtected(child)) continue;
        const childName = targetName(child);
        if (item.isDirectory()) {
          entries.push({ path: childName, kind: "directory" });
          if (recursive && depth < DEPTH_LIMIT) await visit(child, depth + 1);
          else if (recursive) truncated = true;
        } else if (item.isFile())
          entries.push({ path: childName, kind: "file" });
      }
    }
    await visit(start, 0);
    return { entries, truncated };
  }
  async function readFile(
    args: Extract<z.infer<typeof argumentsSchema>, { tool: "read_file" }>,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const file = await read(args.path, signal);
    const lines = file.text.split("\n");
    const version = createHash("sha256").update(file.text).digest("hex");
    if (
      args.if_version !== undefined &&
      /^[a-f\d]{64}$/i.test(args.if_version) &&
      args.if_version.toLowerCase() === version
    ) {
      check(signal);
      // A SHA is not proof that this session has seen a model-visible page.
      return result({
        path: targetName(file.path),
        version,
        unchanged: true,
        size_bytes: Buffer.byteLength(file.text, "utf8"),
        lines_returned: 0,
        offset: args.offset,
        end_line: null,
        next_offset: null,
        total_lines: lines.length,
        truncated: false,
        partial_line: false,
        cache_hit: file.cacheHit,
      });
    }
    const selected: string[] = [];
    let characters = 0;
    let index = args.offset;
    let partial = false;
    while (index < lines.length && selected.length < args.limit) {
      const line = lines[index];
      if (line === undefined) break;
      const numbered = `${index + 1}: ${line}`;
      if (characters + numbered.length > 12000) {
        if (selected.length === 0) {
          selected.push(numbered.slice(0, 12000));
          partial = true;
          index += 1;
        }
        break;
      }
      selected.push(numbered);
      characters += numbered.length + 1;
      index += 1;
    }
    check(signal);
    if (selected.length > 0) {
      const key = receiptKey(context.sessionId, file.path);
      readReceipts.delete(key);
      if (readReceipts.size >= 4096) {
        const first = readReceipts.keys().next();
        if (!first.done) readReceipts.delete(first.value);
      }
      readReceipts.set(key, file.stamp);
    }
    return result({
      path: targetName(file.path),
      content: selected.join("\n"),
      version,
      end_line: selected.length > 0 ? index : null,
      size_bytes: Buffer.byteLength(file.text, "utf8"),
      lines_returned: selected.length,
      offset: args.offset,
      next_offset: index < lines.length ? index : null,
      total_lines: lines.length,
      truncated: partial || index < lines.length,
      partial_line: partial,
      cache_hit: file.cacheHit,
    });
  }
  async function listFiles(
    args: Extract<z.infer<typeof argumentsSchema>, { tool: "list_files" }>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const accept = globMatcher(args.glob);
    const listing = await walk(args.path, args.recursive, signal);
    const root = targetName(await guard.resolveRead(args.path));
    const filtered = listing.entries
      .filter((entry) => accept(relativeQueryPath(root, entry.path)))
      .sort((a, b) => a.path.localeCompare(b.path));
    return result({
      ...pageEntries(filtered, args.offset, args.limit),
      scan_truncated: listing.truncated,
    });
  }
  async function writeFile(
    args: Extract<
      z.infer<typeof argumentsSchema>,
      { tool: "write_file" | "append_file" }
    >,
    call: ToolCall,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    return await serializedFile(args.path, context.sessionId, async () => {
      let content = args.content;
      if (args.tool === "append_file" || args.append) {
        if (args.expected_bytes === undefined)
          fail(
            "Append requires expected_bytes from the last write/read (0 for a new file); do not blindly replay an append.",
            "invalid_input",
          );
        let previous = "";
        try {
          previous = (await read(args.path, signal)).text;
        } catch (error) {
          if (
            !(
              error instanceof WorkspacePathError && error.code === "MISSING"
            ) &&
            errorCode(error) !== "ENOENT"
          )
            throw error;
        }
        if (Buffer.byteLength(previous, "utf8") !== args.expected_bytes)
          fail(
            "Append offset differs from current file size; inspect with read_file before continuing. No content was appended.",
          );
        content = previous + args.content;
      } else if (args.expected_bytes !== undefined) {
        fail(
          "write_file replacement does not accept expected_bytes. Remove it, or use append_file with expected_bytes to append a chunk.",
          "invalid_input",
        );
      }
      const changes = await commit(
        args.path,
        content,
        signal,
        undefined,
        call.id,
        context.sessionId,
      );
      return result(
        {
          written: changes.length > 0,
          unchanged: changes.length === 0,
          size_bytes: Buffer.byteLength(content, "utf8"),
        },
        false,
        changes,
      );
    });
  }
  async function editFile(
    args: Extract<z.infer<typeof argumentsSchema>, { tool: "edit_file" }>,
    call: ToolCall,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    return await serializedFile(args.path, context.sessionId, async () => {
      const original = await read(args.path, signal);
      requireRead(context.sessionId, original.path, original.stamp);
      const pieces = original.text.split(args.old_text);
      const count = pieces.length - 1;
      if (count === 0) fail("old_text was not found.");
      if (!args.replace_all && count !== 1)
        fail("old_text is ambiguous; use replace_all explicitly.");
      const changes = await commit(
        args.path,
        pieces.join(args.new_text),
        signal,
        original.stamp,
        call.id,
        context.sessionId,
      );
      return result(
        {
          edited: changes.length > 0,
          unchanged: changes.length === 0,
          replacements: changes.length > 0 ? count : 0,
        },
        false,
        changes,
      );
    });
  }
  async function makeDirectory(
    args: Extract<z.infer<typeof argumentsSchema>, { tool: "make_directory" }>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    return await serialized(async () =>
      result({
        path: await directories(args.path, signal),
        created: true,
      }),
    );
  }
  async function searchFiles(
    args: Extract<z.infer<typeof argumentsSchema>, { tool: "search_files" }>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const accept = globMatcher(args.glob);
    const listing = await walk(args.path, true, signal);
    const root = targetName(await guard.resolveRead(args.path));
    const candidates = listing.entries
      .filter(
        (entry) =>
          entry.kind === "file" && accept(relativeQueryPath(root, entry.path)),
      )
      .sort((a, b) => a.path.localeCompare(b.path));
    const matcher = createLineMatcher(
      args.query,
      args.regex,
      args.case_sensitive,
      signal,
    );
    const matches: JsonValue[] = [];
    let seen = 0;
    let length = 0;
    let more = false;
    let scanTruncated = listing.truncated;
    let skippedFiles = 0;
    try {
      for (const [fileIndex, entry] of candidates.entries()) {
        check(signal);
        let text: string;
        try {
          text = (await read(entry.path, signal)).text;
        } catch (error: unknown) {
          if (error instanceof ForgeError && error.code === "cancelled")
            throw error;
          skippedFiles += 1;
          continue;
        }
        const content = args.mode === "content";
        const found = await matcher.find(
          text,
          content ? Math.max(0, args.offset - seen) : 0,
          content
            ? args.limit - matches.length + 1
            : args.mode === "files"
              ? 1
              : 0,
          args.mode === "files",
        );
        const lines = content ? text.split("\n") : [];
        const values: JsonValue[] = content
          ? found.hits.map(({ index, column }) => {
              const line = lines[index] ?? "";
              const start = Math.max(0, column - 80);
              return {
                path: entry.path,
                line: index + 1,
                column: column + 1,
                excerpt: line.slice(start, column + 240),
                excerpt_truncated: start > 0 || column + 240 < line.length,
                ...(args.context_lines === 0
                  ? {}
                  : {
                      context: lines
                        .slice(
                          Math.max(0, index - args.context_lines),
                          index + args.context_lines + 1,
                        )
                        .map((value, offset) => ({
                          line:
                            Math.max(0, index - args.context_lines) +
                            offset +
                            1,
                          text: value.slice(0, 320),
                          truncated: value.length > 320,
                        })),
                    }),
              };
            })
          : found.count > 0
            ? [
                args.mode === "files"
                  ? { path: entry.path }
                  : { path: entry.path, count: found.count },
              ]
            : [];
        if (content) seen += found.count;
        for (const value of values) {
          if (!content && seen++ < args.offset) continue;
          if (
            matches.length >= args.limit ||
            length + JSON.stringify(value).length > 90000
          ) {
            more = true;
            break;
          }
          length += JSON.stringify(value).length;
          matches.push(value);
        }
        if (more) {
          scanTruncated ||=
            !found.complete || fileIndex < candidates.length - 1;
          break;
        }
      }
    } finally {
      await matcher.dispose();
    }
    return result({
      matches,
      mode: args.mode,
      offset: args.offset,
      next_offset: more ? args.offset + matches.length : null,
      truncated: more,
      scan_truncated: scanTruncated,
      skipped_files: skippedFiles,
    });
  }
  return {
    readFile,
    listFiles,
    writeFile,
    editFile,
    makeDirectory,
    searchFiles,
  };
}
