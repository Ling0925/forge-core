import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import {
  canonicalIpHost,
  hostAuthority,
  isLoopbackIp,
  validListenEndpoint,
} from "../../src/web/endpoint";
import { createWebHost } from "../../src/web/server";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe("listen endpoints", () => {
  it("accepts concrete IPv4 and IPv6 literals, bracketed or not", () => {
    expect(validListenEndpoint("127.0.0.1", 5173)).toBe(true);
    expect(validListenEndpoint("192.168.1.20", 5173)).toBe(true);
    expect(validListenEndpoint("::1", 5173)).toBe(true);
    expect(validListenEndpoint("[::1]", 5173)).toBe(true);
    expect(validListenEndpoint("fd00::20", 5173)).toBe(true);
  });

  it("still refuses wildcards, hostnames, zone IDs, short IPv4 and low ports", () => {
    for (const host of [
      "0.0.0.0",
      "::",
      "[::]",
      "localhost",
      "127.1",
      "fe80::1%en0",
      "[::1",
    ])
      expect(validListenEndpoint(host, 5173), host).toBe(false);
    expect(validListenEndpoint("::1", 80)).toBe(false);
  });

  it("canonicalizes IPv6 to the form browsers send and brackets it in authorities", () => {
    expect(canonicalIpHost("[0:0:0:0:0:0:0:1]")).toBe("::1");
    expect(canonicalIpHost("FD00:0::20")).toBe("fd00::20");
    expect(hostAuthority("0:0::1", 5175)).toBe("[::1]:5175");
    expect(hostAuthority("127.0.0.1", 5175)).toBe("127.0.0.1:5175");
    expect(isLoopbackIp("[::1]")).toBe(true);
    expect(isLoopbackIp("127.0.0.2")).toBe(true);
    expect(isLoopbackIp("192.168.1.1")).toBe(false);
  });
});

describe("Web host on IPv6", () => {
  it("serves an [::1] origin and keeps DNS-rebinding Host checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-web-v6-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const service = await createHarness({ stateDir: join(directory, "state") });
    const web = await createWebHost({
      service,
      workspace: directory,
      host: "::1",
      port: 5173,
    });
    cleanup.push(() => web.dispose());
    expect(web.origin).toBe("http://[::1]:5173");
    web.server.on("request", (req, res) => {
      void web.handle(req, res, () => res.end("next"));
    });
    await new Promise<void>((done) => web.server.listen(0, "::1", done));
    const { port } = web.server.address() as { port: number };
    const post = (host: string) =>
      new Promise<number>((done, reject) => {
        const req = request(
          {
            host: "::1",
            port,
            path: "/api/connect",
            method: "POST",
            headers: {
              Host: host,
              Origin: web.origin,
              "Content-Type": "application/json",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => done(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
    expect(await post("[::1]:5173")).toBe(200);
    expect(await post("evil.invalid")).not.toBe(200);
  });
});
