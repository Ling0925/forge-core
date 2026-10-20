import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { ForgeError } from "../shared/errors";
import type {
  WorkspaceDirectoryListingDto,
  WorkspaceFileEntryDto,
  WorkspaceFilePreviewDto,
} from "../shared/ipc";
import { createWorkspacePathGuard } from "../tools/path-guard";

const MAX_DIRECTORY_ENTRIES = 500;
const MAX_PREVIEW_BYTES = 64 * 1024;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".build",
  ".cache",
  ".vite",
]);

function isSensitiveSegment(pathValue: string): boolean {
  return pathValue
    .split(/[\\/]/)
    .some(
      (part) =>
        /^(?:\.env.*|\.ssh|\.config|\.git|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(
          part,
        ) ||
        /credentials/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}

function hasSecretPattern(text: string): boolean {
  return (
    /^\s*-----BEGIN [A-Z ]*PRIVATE KEY-----/m.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/.test(
      text,
    ) ||
    /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*(?:[A-Za-z0-9_-]{8,}|"[A-Za-z0-9_-]{8,}"|'[A-Za-z0-9_-]{8,}')\s*$/im.test(
      text,
    )
  );
}

export interface WorkspaceFileOptions {
  readonly protectedRoots?: readonly string[];
  readonly redactValues?: readonly string[];
}

function normalizeSecrets(values: readonly string[] = []): readonly string[] {
  return [...values]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

function redactPreview(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) {
    clean = clean.split(secret).join("[REDACTED]");
  }
  if (hasSecretPattern(clean)) {
    return "[敏感内容已隐藏]";
  }
  return clean;
}

export async function listWorkspaceDirectory(
  workspace: string,
  relativePath = ".",
  options: WorkspaceFileOptions = {},
): Promise<WorkspaceDirectoryListingDto> {
  const normalizedInput = relativePath.trim() === "" ? "." : relativePath.trim();
  if (isSensitiveSegment(normalizedInput)) {
    throw new ForgeError("tool", "不允许访问敏感路径。");
  }
  const secrets = normalizeSecrets(options.redactValues);
  const guard = await createWorkspacePathGuard(
    workspace,
    options.protectedRoots,
  );
  const target = await guard.resolveRead(normalizedInput);
  const safeRelative =
    relative(guard.root, target).split(sep).join("/") || ".";
  if (
    isSensitiveSegment(safeRelative) ||
    secrets.some((secret) => safeRelative.includes(secret))
  ) {
    throw new ForgeError("tool", "不允许访问敏感路径。");
  }
  const targetInfo = await lstat(target);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new ForgeError("tool", "目标路径不是有效目录。");
  }

  const collected: WorkspaceFileEntryDto[] = [];
  let truncated = false;
  const dir = await opendir(target);
  for await (const item of dir) {
    if (
      item.isSymbolicLink() ||
      IGNORED_DIRECTORY_NAMES.has(item.name) ||
      isSensitiveSegment(item.name) ||
      secrets.some((secret) => item.name.includes(secret))
    ) {
      continue;
    }
    const childPath = join(target, item.name);
    if (guard.isProtected(childPath)) {
      continue;
    }
    let childInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      childInfo = await lstat(childPath);
    } catch {
      continue;
    }
    if (childInfo.isSymbolicLink()) {
      continue;
    }
    if (!childInfo.isDirectory() && !childInfo.isFile()) {
      continue;
    }
    const childRelative =
      relative(guard.root, childPath).split(sep).join("/") || item.name;
    collected.push({
      name: item.name,
      path: childRelative,
      kind: childInfo.isDirectory() ? "directory" : "file",
      ...(childInfo.isFile() ? { sizeBytes: childInfo.size } : {}),
      updatedAt: new Date(childInfo.mtimeMs).toISOString(),
    });
  }

  collected.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
  });

  if (collected.length > MAX_DIRECTORY_ENTRIES) {
    truncated = true;
  }
  const entries = collected.slice(0, MAX_DIRECTORY_ENTRIES);
  const rawParent =
    safeRelative === "." ? null : dirname(safeRelative).split(sep).join("/");
  const parentPath = rawParent === "" ? "." : rawParent;

  return {
    workspace: guard.root,
    path: safeRelative,
    parentPath,
    entries,
    truncated,
  };
}

export async function readWorkspaceFilePreview(
  workspace: string,
  relativePath: string,
  options: WorkspaceFileOptions = {},
): Promise<WorkspaceFilePreviewDto> {
  const normalizedInput = relativePath.trim();
  if (normalizedInput.length === 0 || isSensitiveSegment(normalizedInput)) {
    throw new ForgeError("tool", "不允许读取敏感或无效文件路径。");
  }
  const secrets = normalizeSecrets(options.redactValues);
  const guard = await createWorkspacePathGuard(
    workspace,
    options.protectedRoots,
  );
  const target = await guard.resolveRead(normalizedInput);
  const safeRelative =
    relative(guard.root, target).split(sep).join("/") || ".";
  if (
    safeRelative === "." ||
    isSensitiveSegment(safeRelative) ||
    secrets.some((secret) => safeRelative.includes(secret))
  ) {
    throw new ForgeError("tool", "不允许读取敏感文件路径。");
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ForgeError("tool", "目标路径不是普通文件。");
  }

  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new ForgeError("tool", "目标路径不是普通文件。");
    }
    const toRead = Math.min(opened.size, MAX_PREVIEW_BYTES);
    const buffer = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const chunk = await handle.read(
        buffer,
        offset,
        toRead - offset,
        offset,
      );
      if (chunk.bytesRead === 0) break;
      offset += chunk.bytesRead;
    }
    const slice = buffer.subarray(0, offset);
    if (slice.includes(0)) {
      return {
        path: safeRelative,
        sizeBytes: opened.size,
        content: "",
        truncated: false,
        binary: true,
      };
    }
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch {
      return {
        path: safeRelative,
        sizeBytes: opened.size,
        content: "",
        truncated: false,
        binary: true,
      };
    }
    return {
      path: safeRelative,
      sizeBytes: opened.size,
      content: redactPreview(decoded, secrets),
      truncated: opened.size > offset,
      binary: false,
    };
  } finally {
    await handle.close();
  }
}
