import { lookup } from "node:dns/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { type Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";

const BYTE_LIMIT = 2 * 1024 * 1024;
const TIMEOUT_MS = 20000;
export class WebAccessError extends Error {}

function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    // Reject mapped IPv4, transition networks and special-purpose ranges too.
    if (parsed.range() !== "unicast") return false;
    if (parsed.kind() === "ipv6" && !parsed.match(ipaddr.parse("2000::"), 3))
      return false;
    return address !== "168.63.129.16"; // Azure platform/metadata virtual IP.
  } catch {
    return false;
  }
}

/** Only direct public-web requests; this is intentionally not a LAN client. */
export function validatePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebAccessError("Invalid public web URL.");
  }
  const hasControl = [...input].some(
    (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
  );
  if (
    input.length > 4096 ||
    url.href.length > 4096 ||
    hasControl ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new WebAccessError(
      "Only HTTP(S) URLs on standard ports without credentials are allowed.",
    );
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    !host ||
    (isIP(host)
      ? !publicAddress(host)
      : !host.includes(".") ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(
          host,
        ))
  )
    throw new WebAccessError(
      "Local, private and reserved web addresses are blocked.",
    );
  url.hash = "";
  return url;
}

function check(signal: AbortSignal): void {
  if (signal.aborted)
    throw new WebAccessError("Web request cancelled or timed out.");
}

export async function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  // Always observe work, including a rejection racing an already-aborted signal.
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new WebAccessError("Web request cancelled or timed out."));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

async function resolvePublic(url: URL, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await abortable(lookup(host, { all: true, verbatim: true }), signal);
  check(signal);
  if (
    !addresses.length ||
    addresses.some((item) => !publicAddress(item.address))
  )
    throw new WebAccessError(
      "DNS resolved to a private, reserved or invalid address; request blocked.",
    );
  const pinned = addresses.find((item) => item.family === 4) ?? addresses[0];
  if (!pinned) throw new WebAccessError("No public DNS address available.");
  return pinned;
}

function byteGuard(): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > BYTE_LIMIT)
        done(new WebAccessError("Web response exceeds the 2 MiB limit."));
      else done(null, chunk);
    },
  });
}

function decode(buffer: Buffer, contentType: string): string {
  const declared = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const meta = /html/i.test(contentType)
    ? /<meta\b[^>]{0,512}\bcharset\s*=\s*["']?([\w-]+)/i.exec(
        buffer.subarray(0, 4096).toString("latin1"),
      )?.[1]
    : undefined;
  try {
    return new TextDecoder(declared ?? meta ?? "utf-8").decode(buffer);
  } catch {
    throw new WebAccessError("Unsupported web text character encoding.");
  }
}

interface Hop {
  status: number;
  location?: string;
  contentType: string;
  body: string;
}
async function requestOnce(url: URL, signal: AbortSignal): Promise<Hop> {
  const pinned = await resolvePublic(url, signal);
  check(signal);
  return new Promise<Hop>((resolve, reject) => {
    const streams: Readable[] = [];
    let settled = false;
    const finish = (error?: Error, value?: Hop) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      for (const stream of streams) stream.destroy();
      req.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new WebAccessError("Invalid web response."));
    };
    const abort = () =>
      finish(new WebAccessError("Web request cancelled or timed out."));
    const receive = (response: IncomingMessage) => {
      if (settled) {
        response.destroy();
        return;
      }
      streams.push(response);
      response.on("error", (error) => finish(error));
      response.on("aborted", () =>
        finish(new WebAccessError("Web response ended prematurely.")),
      );
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        finish(undefined, {
          status,
          ...(response.headers.location
            ? { location: response.headers.location }
            : {}),
          contentType: "",
          body: "",
        });
        return;
      }
      if (status < 200 || status >= 300) {
        finish(
          new WebAccessError(
            `Web server returned HTTP ${status}; no automatic retry performed.`,
          ),
        );
        return;
      }
      const contentType = response.headers["content-type"] ?? "";
      const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        !/^(?:text\/(?:html|plain|markdown|xml|csv)|application\/(?:xhtml\+xml|json|xml|rss\+xml|atom\+xml))$/.test(
          mime,
        )
      ) {
        finish(
          new WebAccessError(
            "Unsupported web content type; only HTML and text documents are supported.",
          ),
        );
        return;
      }
      if (Number(response.headers["content-length"]) > BYTE_LIMIT) {
        finish(new WebAccessError("Web response exceeds the 2 MiB limit."));
        return;
      }
      const encoding = (response.headers["content-encoding"] ?? "identity")
        .toLowerCase()
        .trim();
      const decompressor =
        encoding === "gzip"
          ? createGunzip()
          : encoding === "br"
            ? createBrotliDecompress()
            : encoding === "deflate"
              ? createInflate()
              : undefined;
      if (!decompressor && encoding !== "identity") {
        finish(new WebAccessError("Unsupported web content encoding."));
        return;
      }
      const wire = byteGuard();
      const decoded = byteGuard();
      const chain = decompressor
        ? [wire, decompressor, decoded]
        : [wire, decoded];
      let current: Readable = response;
      for (const stream of chain) {
        streams.push(stream);
        stream.on("error", (error) => finish(error));
        current = current.pipe(stream);
      }
      const chunks: Buffer[] = [];
      current.on("data", (chunk: Buffer) => chunks.push(chunk));
      current.on("end", () => {
        try {
          finish(undefined, {
            status,
            contentType,
            body: decode(Buffer.concat(chunks), contentType),
          });
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new WebAccessError("Invalid web text."),
          );
        }
      });
    };
    // No proxy/env credentials, shared agent, cookie jar, referer or auth. The
    // hostname stays original for Host/TLS verification; only DNS is pinned.
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        rejectUnauthorized: true,
        family: pinned.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
        headers: {
          "User-Agent": "Forge/0.1 (public-web-reader)",
          Accept:
            "text/html,application/rss+xml,application/xml,text/plain,application/json;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "gzip, deflate, br",
        },
        maxHeaderSize: 16384,
      },
      receive,
    );
    req.on("error", (error) => finish(error));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else req.end();
  });
}

export async function requestPublicText(
  input: string,
  options: {
    signal: AbortSignal;
    beforeRequest?: (url: URL, signal: AbortSignal) => Promise<void>;
  },
): Promise<{ url: string; status: number; contentType: string; body: string }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    let url = validatePublicUrl(input);
    for (let hop = 0; hop <= 3; hop++) {
      check(signal);
      if (options.beforeRequest)
        await abortable(options.beforeRequest(new URL(url), signal), signal);
      check(signal);
      const response = await requestOnce(url, signal);
      if (response.status >= 200 && response.status < 300)
        return { ...response, url: url.href };
      if (!response.location || hop === 3)
        throw new WebAccessError(
          "Web redirect limit reached or redirect URL missing.",
        );
      const next = validatePublicUrl(new URL(response.location, url).href);
      if (url.protocol === "https:" && next.protocol !== "https:")
        throw new WebAccessError("HTTPS to HTTP redirects are blocked.");
      url = next;
    }
    throw new WebAccessError("Web redirect limit reached.");
  } catch (error) {
    if (signal.aborted)
      throw new WebAccessError("Web request cancelled or timed out.");
    if (error instanceof WebAccessError) throw error;
    throw new WebAccessError(
      "Web request failed (network, DNS, TLS or response error); no automatic retry performed.",
    );
  } finally {
    clearTimeout(timer);
  }
}
