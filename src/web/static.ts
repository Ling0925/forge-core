import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createBrotliCompress, createGzip } from "node:zlib";

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const COMPRESSIBLE = new Set([".css", ".js", ".json", ".map", ".mjs", ".svg", ".webmanifest"]);
const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
type Encoding = "br" | "gzip" | "identity";

/** Respect explicit exclusions and quality weights, with identity as fallback. */
function negotiateEncoding(header: string | undefined, compressible: boolean): Encoding | undefined {
  const weights = new Map<string, number>();
  for (const entry of (header ?? "").split(",")) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    if (!name) continue;
    const quality = parameters.map((part) => part.trim()).find((part) => part.startsWith("q="));
    const weight = quality === undefined ? 1 : Number(quality.slice(2));
    weights.set(name.trim(), Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  let selected: Encoding | undefined;
  let best = 0;
  if (compressible) {
    for (const encoding of ["br", "gzip"] as const) {
      const weight = weights.get(encoding) ?? weights.get("*") ?? 0;
      if (weight > best) { selected = encoding; best = weight; }
    }
  }
  const identity = weights.get("identity") ?? (weights.get("*") === 0 ? 0 : undefined);
  if (identity === undefined) return selected ?? "identity";
  if (identity > best) return "identity";
  return selected;
}

function notModified(request: IncomingMessage, etag: string): boolean {
  // GET and HEAD use weak comparison, including when a proxy removes W/.
  return (request.headers["if-none-match"] ?? "").split(",").some((value) => {
    const tag = value.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag.replace(/^W\//, "");
  });
}

/**
 * The built renderer is loaded from `file://` by Electron, where its CSP says
 * `connect-src 'none'`. A Web host must talk to its own origin over HTTP and
 * WebSocket, so only that directive is relaxed; every other directive stays
 * exactly as shipped.
 *
 * Some WebViews do not treat `'self'` as covering WebSocket origins, so the
 * socket origin is listed explicitly alongside it.
 */
export function rendererCspForOrigin(html: string, origin: string): string {
  const socket = origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return html
    .replace("connect-src 'none';", `connect-src 'self' ${socket};`)
    .replace(
      /(<script\b[^>]*\bsrc=")\.\//g,
      (_match, prefix: string) => `${prefix}/`,
    );
}

/** Returns decoded, non-empty path segments or `undefined` when unsafe. */
function decodePath(rawUrl: string | undefined): string[] | undefined {
  const pathname = (rawUrl ?? "/").split("?")[0] ?? "/";
  if (!pathname.startsWith("/")) return undefined;
  if (pathname.includes("\0") || pathname.includes("\\")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "") continue;
    // Traversal, hidden entries and any dot-prefixed name are refused outright.
    if (segment === "." || segment === ".." || segment.startsWith("."))
      return undefined;
    segments.push(segment);
  }
  return segments;
}

export interface StaticRenderer {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    origin: string,
  ): Promise<boolean>;
}

/**
 * Serves only ordinary files inside the packaged renderer directory.
 *
 * The configured root itself is resolved with `realpath` once, so a symlinked
 * install path (for example a versioned `dist` link) is accepted as the
 * declared root. Every segment below it is then checked with `lstat` and any
 * symlink is refused, so a link inside the renderer directory cannot expose
 * files from elsewhere. The file is opened with `O_NOFOLLOW` and served from
 * that descriptor, keeping the check and the bytes consistent. Directories,
 * dotfiles, absolute escapes and oversized files are never served.
 */
export async function createStaticRenderer(options: {
  rendererRoot: string;
}): Promise<StaticRenderer> {
  const root = await realpath(resolve(options.rendererRoot)).catch(() => {
    throw new Error(
      `The packaged renderer was not found at ${resolve(options.rendererRoot)}; run the Web build first.`,
    );
  });
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const within = (candidate: string): boolean =>
    candidate === root || candidate.startsWith(rootPrefix);

  const locate = async (
    segments: readonly string[],
  ): Promise<string | undefined> => {
    let current = root;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      if (!within(current)) return undefined;
      let info: Stats;
      try {
        info = await lstat(current);
      } catch {
        return undefined;
      }
      if (info.isSymbolicLink()) return undefined;
      const last = index === segments.length - 1;
      if (last ? !info.isFile() : !info.isDirectory()) return undefined;
    }
    return segments.length > 0 ? current : undefined;
  };

  const serveHtml = async (
    response: ServerResponse,
    request: IncomingMessage,
    origin: string,
    handle: Awaited<ReturnType<typeof open>>,
  ): Promise<void> => {
    const html = rendererCspForOrigin(await handle.readFile("utf8"), origin);
    // Hash the rewritten document: CSP depends on this host's origin. HTML
    // always revalidates so a rebuilt renderer's new asset URLs are discovered.
    const etag = `"${createHash("sha256").update(html).digest("base64url")}"`;
    const headers = {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ETag: etag,
    };
    if (notModified(request, etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": String(Buffer.byteLength(html)) });
    response.end(request.method === "HEAD" ? undefined : html);
  };

  const serveFile = async (
    response: ServerResponse,
    request: IncomingMessage,
    path: string,
    info: Stats,
    handle: Awaited<ReturnType<typeof open>>,
  ): Promise<void> => {
    const extension = extname(path).toLowerCase();
    const compressible = info.size >= 1024 && COMPRESSIBLE.has(extension);
    const encoding = negotiateEncoding(request.headers["accept-encoding"], compressible);
    // Vite embeds an eight-character content hash in these filenames. Do not
    // give stable names (or any HTML/API/session data) an immutable lifetime.
    const fingerprinted = path.startsWith(join(root, "assets") + sep) &&
      /-[\w-]{8}\.[\w]+$/.test(basename(path));
    // Weak validators describe the same bytes across gzip/br/identity. ctime
    // also invalidates files replaced with an unchanged size and mtime.
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${info.ctimeMs.toString(16)}"`;
    const headers = {
      ...SECURITY_HEADERS,
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Cache-Control": fingerprinted ? "public, max-age=31536000, immutable" : "no-cache",
      ETag: etag,
      Vary: "Accept-Encoding",
    };
    if (!encoding) {
      response.writeHead(406, { ...SECURITY_HEADERS, Vary: "Accept-Encoding", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (notModified(request, etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      ...(encoding === "identity" ? { "Content-Length": String(info.size) } : { "Content-Encoding": encoding }),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = handle.createReadStream({ autoClose: false });
    if (encoding === "identity") await pipeline(stream, response);
    else {
      // Asynchronous streaming avoids buffering whole bundles or blocking the
      // shared agent runtime. Already-compressed fonts/images are left alone.
      const compression = encoding === "br"
        ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
        : createGzip();
      await pipeline(stream, compression, response);
    }
  };

  return {
    async handle(request, response, origin): Promise<boolean> {
      if (request.method !== "GET" && request.method !== "HEAD") return false;
      const parsed = decodePath(request.url);
      if (!parsed) return false;
      const path = await locate(parsed.length === 0 ? ["index.html"] : parsed);
      if (!path) return false;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        // O_NOFOLLOW closes the race where the final name becomes a link
        // between the lstat above and this open.
        handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NOCTTY ?? 0),
        );
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return false;
        if (path.toLowerCase().endsWith(".html"))
          await serveHtml(response, request, origin, handle);
        else await serveFile(response, request, path, info, handle);
        return true;
      } catch {
        // A disconnected client/failed stream must not fall through to a
        // second response after headers have already been sent.
        if (response.headersSent) { response.destroy(); return true; }
        return false;
      } finally {
        await handle?.close().catch(() => {});
      }
    },
  };
}
