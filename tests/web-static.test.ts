import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createStaticRenderer } from "../src/web/static";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const script = "export const message = 'Forge static compression fixture';\n".repeat(400);
const asset = "/assets/app-12345678.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "forge-static-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "renderer");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<meta content=\"script-src 'self'; connect-src 'none';\"><script src=\"./assets/app-12345678.js\"></script>");
  await writeFile(join(root, asset), script);
  await writeFile(join(root, "plain.js"), script);
  await writeFile(join(root, "small.css"), "body{color:white}");
  await writeFile(join(root, "assets/font-12345678.woff2"), Buffer.alloc(4096, 7));
  const renderer = await createStaticRenderer({ rendererRoot: root });
  let origin = "http://127.0.0.1:5173";
  const server = createServer((req, res) => {
    void renderer.handle(req, res, origin).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  // Raw HTTP is deliberate: fetch automatically decompresses responses.
  const call = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<{
    status: number; headers: IncomingHttpHeaders; body: Buffer;
  }>((done, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  return { root, directory, call, setOrigin: (next: string) => { origin = next; } };
}

describe("production renderer transfer", () => {
  it.each([
    ["br, gzip", "br"],
    ["gzip", "gzip"],
    ["br;q=0, gzip;q=1", "gzip"],
    ["br;q=0.4, gzip;q=0.8", "gzip"],
    ["gzip;q=0.4, identity;q=0.8", undefined],
    ["*;q=0.5, br;q=0", "gzip"],
    ["br;q=0, gzip;q=0", undefined],
    ["deflate", undefined],
    ["", undefined],
  ])("negotiates %s as %s without changing bytes", async (accept, encoding) => {
    const { call } = await setup();
    const response = await call(asset, { "Accept-Encoding": accept! });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe(encoding);
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const decoded = encoding === "br" ? brotliDecompressSync(response.body)
      : encoding === "gzip" ? gunzipSync(response.body) : response.body;
    expect(decoded.toString()).toBe(script);
    if (encoding) {
      expect(response.body.length).toBeLessThan(Buffer.byteLength(script) / 2);
      expect(response.headers["content-length"]).toBeUndefined();
    } else expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(script)));
  });

  it("does not compress tiny files or already-compressed fonts", async () => {
    const { call } = await setup();
    for (const path of ["/small.css", "/assets/font-12345678.woff2"]) {
      const response = await call(path, { "Accept-Encoding": "br, gzip" });
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.body.length).toBe(Number(response.headers["content-length"]));
    }
    expect((await call("/small.css")).headers["cache-control"]).toBe("no-cache");
  });

  it("returns 406 when neither a supported encoding nor identity is acceptable", async () => {
    const { call } = await setup();
    const response = await call(asset, { "Accept-Encoding": "br;q=0, gzip;q=0, identity;q=0" });
    expect(response.status).toBe(406);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.length).toBe(0);
  });

  it("supports HEAD and conditional GET/HEAD across encodings without a body", async () => {
    const { call } = await setup();
    const response = await call(asset);
    const etag = response.headers.etag!;
    const head = await call(asset, { "Accept-Encoding": "gzip" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers.etag).toBe(etag);
    expect(head.body.length).toBe(0);
    for (const method of ["GET", "HEAD"]) {
      for (const candidate of [etag, etag.replace(/^W\//, ""), `"other", ${etag}`, "*"]) {
        const cached = await call(asset, { "If-None-Match": candidate, "Accept-Encoding": "br" }, method);
        expect(cached.status).toBe(304);
        expect(cached.headers.etag).toBe(etag);
        expect(cached.headers.vary).toBe("Accept-Encoding");
        expect(cached.headers["cache-control"]).toContain("immutable");
        expect(cached.headers["content-length"]).toBeUndefined();
        expect(cached.body.length).toBe(0);
      }
    }
  });

  it("revalidates stable filenames and detects a rebuilt file", async () => {
    const { root, call } = await setup();
    const original = await call("/plain.js");
    expect(original.headers["cache-control"]).toBe("no-cache");
    const headers = { "If-None-Match": original.headers.etag! };
    expect((await call("/plain.js", headers)).status).toBe(304);
    await writeFile(join(root, "plain.js"), "console.log('rebuilt');");
    const rebuilt = await call("/plain.js", headers);
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.headers.etag).not.toBe(original.headers.etag);
    expect(rebuilt.body.toString()).toBe("console.log('rebuilt');");
  });

  it("keeps HTML revalidating and includes rewritten CSP and new builds in its validator", async () => {
    const { root, call, setOrigin } = await setup();
    const original = await call("/");
    expect(original.headers["cache-control"]).toBe("no-cache");
    expect(original.body.toString()).toContain("connect-src 'self' ws://127.0.0.1:5173;");
    expect(original.body.toString()).toContain("script-src 'self';");
    expect(original.headers["x-frame-options"]).toBe("DENY");
    const headers = { "If-None-Match": original.headers.etag! };
    expect((await call("/", headers)).status).toBe(304);
    expect((await call("/index.html", headers, "HEAD")).body.length).toBe(0);
    setOrigin("https://example.invalid");
    const otherOrigin = await call("/", headers);
    expect(otherOrigin.status).toBe(200);
    expect(otherOrigin.body.toString()).toContain("wss://example.invalid");
    await writeFile(join(root, "index.html"), "<html>new build</html>");
    const rebuilt = await call("/", { "If-None-Match": otherOrigin.headers.etag! });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.toString()).toBe("<html>new build</html>");
  });

  it("still refuses traversal, symlinks and non-read methods even with validators", async () => {
    const { root, directory, call } = await setup();
    const original = await call(asset);
    await writeFile(join(directory, "outside.js"), script);
    await rm(join(root, asset));
    await symlink(join(directory, "outside.js"), join(root, asset));
    for (const path of [asset, "/%2e%2e/outside.js", "/assets/%2e%2e/plain.js", "/.hidden.js"]) {
      expect((await call(path, { "If-None-Match": original.headers.etag!, "Accept-Encoding": "br" })).status).toBe(404);
    }
    expect((await call("/plain.js", {}, "POST")).status).toBe(404);
  });
});
