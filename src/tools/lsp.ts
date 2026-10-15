import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { extname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { LocalToolRegistry, ToolContext } from "../shared/contracts";
import { lspServersSchema, type ToolCall, type ToolDefinition, type ToolResult } from "../shared/schemas";
import { createWorkspacePathGuard } from "./path-guard";
import { StdioLspClient } from "./lsp-client";

export interface LspServerConfig {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly extensions: readonly string[];
}
export interface LspToolOptions {
  readonly protectedRoots?: readonly string[];
  readonly redactValues?: readonly string[];
}

// Share persisted configuration validation and limits with the host.
const languageIds: Readonly<Record<string, string>> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
  mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", rb: "ruby",
  sh: "shellscript", yml: "yaml", h: "c", cs: "csharp", kt: "kotlin",
};
const argsSchema = z.object({
  operation: z.enum(["symbols", "definition", "references", "hover"]),
  path: z.string().min(1).max(4096),
  line: z.number().int().min(1).max(2_097_153).optional(),
  character: z.number().int().min(1).max(2_097_153).optional(),
  offset: z.number().int().min(0).max(1000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().refine((v) => v.operation === "symbols" ||
  (v.line !== undefined && v.character !== undefined),
{ message: "line and character are required except for symbols" });
const definition: ToolDefinition = {
  type: "function",
  function: {
    name: "lsp",
    description: "Read-only semantic queries through explicitly configured local stdio language servers (not an OS sandbox). readonly denies execution; workspace needs fresh approval per call. Workspace-relative UTF-8 files only, no symlinks/sensitive paths; 1-based UTF-16 positions. Bounded, filtered and paginated results; no automatic install or retry.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["symbols", "definition", "references", "hover"] },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        line: { type: "integer", minimum: 1 },
        character: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      required: ["operation", "path"],
      additionalProperties: false,
    },
  },
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Match local filesystem tools' path/content policy without exposing their internals.
function sensitive(path: string): boolean {
  return path.split(/[\\/]/).some((part) =>
    /^(?:\.env.*|\.ssh|\.config|\.git|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(part) ||
    /credentials/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
}
function secretText(text: string): boolean {
  return /^\s*-----BEGIN [A-Z ]*PRIVATE KEY-----/m.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/.test(text) ||
    /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*(?:[A-Za-z0-9_-]{8,}|"[A-Za-z0-9_-]{8,}"|'[A-Za-z0-9_-]{8,}')\s*$/im.test(text);
}
const FILE_LIMIT = 2 * 1024 * 1024;
const RESULT_LIMIT = 48 * 1024;
const MAX_ITEMS = 1000;
const rangeSchema = z.object({
  start: z.object({ line: z.number().int().min(0).max(2_097_152), character: z.number().int().min(0).max(2_097_152) }),
  end: z.object({ line: z.number().int().min(0).max(2_097_152), character: z.number().int().min(0).max(2_097_152) }),
}).refine((r) => r.end.line > r.start.line ||
  (r.end.line === r.start.line && r.end.character >= r.start.character));
function range(value: unknown) {
  const parsed = rangeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { start: { line: parsed.data.start.line + 1, character: parsed.data.start.character + 1 },
    end: { line: parsed.data.end.line + 1, character: parsed.data.end.character + 1 } };
}

export async function createLspToolRegistry(
  workspace: string,
  configurations: readonly LspServerConfig[],
  options: LspToolOptions = {},
): Promise<LocalToolRegistry> {
  const configs = lspServersSchema.parse(configurations);
  const guard = await createWorkspacePathGuard(workspace, options.protectedRoots);
  const known = [...(options.redactValues ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
  const containsKnown = (text: string) => known.some((s) => text.includes(s));
  if (configs.some((server) => [server.id, server.command, ...server.args].some((s) => containsKnown(s) || secretText(s))))
    throw new Error("Sensitive LSP server configuration is not permitted.");
  const clean = (text: string, max = 4096): string => {
    // Redact before truncating, so a secret straddling the boundary cannot leak.
    let value = text;
    for (const secret of known) value = value.split(secret).join("[REDACTED]");
    if (secretText(value)) return "[Sensitive output withheld]";
    value = value.split(guard.root).join("[workspace]");
    value = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`\])}]+/gi, "[URI withheld]");
    value = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    return value.slice(0, max);
  };
  const result = (value: unknown, isError = false): ToolResult => ({ content: JSON.stringify(value), isError });
  const shutdown = new AbortController();
  const active = new Set<Promise<ToolResult>>();
  let disposal: Promise<void> | undefined;

  async function read(path: string): Promise<{ absolute: string; text: string; path: string }> {
    if (sensitive(path) || containsKnown(path)) throw new Error("Sensitive paths are not permitted.");
    const absolute = await guard.resolveRead(path);
    const local = relative(guard.root, absolute).split(sep).join("/");
    if (sensitive(local) || containsKnown(local)) throw new Error("Sensitive paths are not permitted.");
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > FILE_LIMIT) throw new Error("LSP requires a file of at most 2 MiB.");
      const buffer = Buffer.alloc(FILE_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      if (length > FILE_LIMIT) throw new Error("LSP file exceeds 2 MiB.");
      const after = await handle.stat();
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error("LSP file changed while reading.");
      // Recheck ancestor symlinks after opening, matching other local tools' guard.
      if (await guard.resolveRead(path) !== absolute) throw new Error("LSP file changed while reading.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (text.includes("\0") || secretText(text) || containsKnown(text))
        throw new Error("Binary or sensitive content is not permitted.");
      return { absolute, text, path: local };
    } finally { await handle.close(); }
  }

  async function safeLocation(value: unknown) {
    if (!object(value)) return undefined;
    const uri = typeof value.uri === "string" ? value.uri : value.targetUri;
    const locationRange = range(value.range ?? value.targetSelectionRange ?? value.targetRange);
    if (typeof uri !== "string" || uri.length > 16384 || !locationRange) return undefined;
    try {
      const url = new URL(uri);
      if (url.protocol !== "file:" || url.search || url.hash || url.hostname) return undefined;
      const absolute = fileURLToPath(url);
      const local = relative(guard.root, absolute).split(sep).join("/");
      if (!local || sensitive(local) || containsKnown(local)) return undefined;
      if (await guard.resolveRead(local) !== absolute || !(await lstat(absolute)).isFile()) return undefined;
      return { path: clean(local), range: locationRange };
    } catch { return undefined; }
  }

  async function authorize(ctx: ToolContext, call: ToolCall, server: LspServerConfig) {
    if (ctx.signal.aborted) throw new Error("LSP invocation cancelled.");
    if (ctx.permission === "readonly") throw new Error("LSP is unavailable in readonly mode: language servers execute external code.");
    if (ctx.permission === "unrestricted") return;
    const request = { id: randomUUID(), sessionId: ctx.sessionId, toolCallId: ctx.toolCallId,
      toolName: call.function.name, command: [server.command, ...server.args],
      description: clean(`Run local LSP server ${server.id}: ${server.command} ${server.args.join(" ")}. Semantic read-only queries are not an OS sandbox.`, 8192) };
    ctx.onEvent({ type: "approval_requested", sessionId: ctx.sessionId, timestamp: new Date().toISOString(), request });
    let abort = () => {};
    let approved: boolean;
    try {
      approved = await Promise.race([
        Promise.resolve().then(() => { if (ctx.signal.aborted) throw new Error("LSP invocation cancelled."); return ctx.approve(request, ctx.signal); }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("LSP invocation cancelled."));
          ctx.signal.addEventListener("abort", abort, { once: true });
          if (ctx.signal.aborted) abort();
        }),
      ]);
    } finally { ctx.signal.removeEventListener("abort", abort); }
    if (!approved) throw new Error("LSP invocation denied.");
    if (ctx.signal.aborted) throw new Error("LSP invocation cancelled.");
  }

  async function execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    let client: StdioLspClient | undefined;
    try {
      if (shutdown.signal.aborted) throw new Error("LSP registry disposed.");
      if (call.function.name !== "lsp" || configs.length === 0) throw new Error("Unknown tool.");
      if (Buffer.byteLength(call.function.arguments) > 16384) throw new Error("LSP arguments too large.");
      const args = argsSchema.parse(JSON.parse(call.function.arguments));
      const extension = extname(args.path).slice(1).toLowerCase();
      const matches = configs.filter((c) => c.extensions.some((e) => e.replace(/^\./, "").toLowerCase() === extension));
      if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous LSP server configuration." : "No LSP server configured for this extension.");
      const server = matches[0]!;
      const signal = AbortSignal.any([ctx.signal, shutdown.signal]);
      await authorize({ ...ctx, signal }, call, server);
      const document = await read(args.path);
      if (signal.aborted) throw new Error("LSP invocation cancelled.");
      if (args.operation !== "symbols") {
        const lines = document.text.split(/\r\n|\r|\n/);
        if (args.line! > lines.length || args.character! > lines[args.line! - 1]!.length + 1)
          throw new Error("LSP position is outside the document.");
      }
      client = new StdioLspClient({ command: server.command, args: server.args, cwd: guard.root, signal });
      client.start();
      const rootUri = pathToFileURL(guard.root).href;
      const initialized = await client.request("initialize", {
        processId: null, rootUri, workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        capabilities: { general: { positionEncodings: ["utf-16"] }, workspace: { applyEdit: false },
          textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      });
      if (!object(initialized) || !object(initialized.capabilities))
        throw new Error("Invalid LSP initialize result.");
      if (initialized.capabilities.positionEncoding !== undefined && initialized.capabilities.positionEncoding !== "utf-16")
        throw new Error("LSP server must use UTF-16 positions.");
      client.notify("initialized", {});
      const uri = pathToFileURL(document.absolute).href;
      client.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageIds[extension] ?? extension, version: 1, text: document.text } });
      const method = { symbols: "documentSymbol", definition: "definition", references: "references", hover: "hover" }[args.operation];
      const response = await client.request(`textDocument/${method}`, {
        textDocument: { uri },
        ...(args.operation === "symbols" ? {} : { position: { line: args.line! - 1, character: args.character! - 1 } }),
        ...(args.operation === "references" ? { context: { includeDeclaration: true } } : {}),
      });
      const items: unknown[] = [];
      let truncated = false;
      const boundedText = (text: string, max: number) => {
        // Conservatively flag raw truncation even if redaction shortens it.
        if (text.length > max) truncated = true;
        return clean(text, max);
      };
      if (args.operation === "symbols") {
        const queue: unknown[] = Array.isArray(response) ? [...response] : [];
        let visited = 0;
        while (queue.length && visited++ < MAX_ITEMS) {
          const item = queue.shift();
          if (!object(item) || typeof item.name !== "string") continue;
          const location = "location" in item ? await safeLocation(item.location) :
            { path: document.path, range: range(item.selectionRange ?? item.range) };
          if (location?.range && Number.isInteger(item.kind) && Number(item.kind) >= 1 && Number(item.kind) <= 26)
            items.push({ name: boundedText(item.name, 512), kind: item.kind, ...location });
          if (Array.isArray(item.children)) queue.push(...item.children.slice(0, MAX_ITEMS));
          if (queue.length > MAX_ITEMS) { queue.length = MAX_ITEMS; truncated = true; }
        }
        truncated ||= queue.length > 0;
      } else if (args.operation === "hover") {
        const contents = object(response) ? response.contents : undefined;
        const values = Array.isArray(contents) ? contents : [contents];
        for (const value of values.slice(0, MAX_ITEMS)) {
          const text = typeof value === "string" ? value : object(value) && typeof value.value === "string" ? value.value : undefined;
          if (text !== undefined) items.push({ text: boundedText(text, 8192) });
        }
        truncated ||= values.length > MAX_ITEMS;
      } else {
        const values = Array.isArray(response) ? response : response == null ? [] : [response];
        for (const value of values.slice(0, MAX_ITEMS)) {
          const location = await safeLocation(value);
          if (location) items.push(location);
        }
        truncated ||= values.length > MAX_ITEMS;
      }
      const page: unknown[] = [];
      let bytes = 0;
      let consumed = 0;
      for (const item of items.slice(args.offset, args.offset + args.limit)) {
        const size = Buffer.byteLength(JSON.stringify(item));
        // An individually oversize item is omitted and consumed, never loop at
        // nextOffset=offset. Normal field limits keep ordinary items below cap.
        if (size > RESULT_LIMIT) { truncated = true; consumed++; continue; }
        if (bytes + size > RESULT_LIMIT) { truncated = true; break; }
        page.push(item); bytes += size; consumed++;
      }
      const nextOffset = args.offset + consumed < items.length ? args.offset + consumed : null;
      const payload = { operation: args.operation, path: document.path, items: page, offset: args.offset, nextOffset, truncated: truncated || nextOffset !== null };
      await client.dispose();
      return result(payload);
    } catch (error) {
      try { await client?.dispose(); }
      catch { return result({ error: "LSP process cleanup failed; execution stopped." }, true); }
      // zod and filesystem errors can contain user input; return only bounded text.
      return result({ error: error instanceof z.ZodError ? "Invalid LSP arguments." :
        clean(error instanceof Error ? error.message : "LSP query failed.", 512) }, true);
    }
  }
  return {
    definitions: configs.length ? [definition] : [],
    execute(call, ctx) {
      const task = execute(call, ctx);
      active.add(task);
      void task.finally(() => active.delete(task)).catch(() => undefined);
      return task;
    },
    dispose() {
      if (!disposal) {
        shutdown.abort();
        disposal = Promise.all([...active]).then(() => undefined);
      }
      return disposal;
    },
  };
}
