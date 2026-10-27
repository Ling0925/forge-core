import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeHost } from "../../src/shared/runtime-host";
import { buildStatus, readDiskBuildInfo } from "../../src/web/build-info";
import { createWebHost } from "../../src/web/server";

// Task scratch space in the workspace root, never the OS temp directory.
const SCRATCH = fileURLToPath(
  new URL(
    "../../../../.forge/tmp/cross-provider-fixes/version/",
    import.meta.url,
  ),
);

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function http(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: string,
): Promise<Reply> {
  return new Promise((done, reject) => {
    const req = request(
      `http://127.0.0.1:${port}${path}`,
      { method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          done({
            status: res.statusCode ?? 500,
            headers: res.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? (body ?? "{}") : undefined);
  });
}

async function temp(prefix: string): Promise<string> {
  await mkdir(SCRATCH, { recursive: true });
  const directory = await mkdtemp(join(SCRATCH, prefix));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture() {
  const directory = await temp("forge-build-info-");
  const runtime: RuntimeHost = {
    handle: async () => {},
    request: async () => {
      throw new Error("The build test never issues RPC.");
    },
    subscribe: () => () => {},
    recoveryEvents: () => [],
    hostState: () => {
      throw new Error("The build test never reads host state.");
    },
    dispose: async () => {},
  };
  const web = await createWebHost({
    runtime,
    workspace: directory,
    host: "127.0.0.1",
    port: 5173,
  });
  cleanup.push(() => web.dispose());
  web.server.on("request", (req, res) => {
    void web.handle(req, res, () => res.end("fixture"));
  });
  await new Promise<void>((done) => web.server.listen(0, "127.0.0.1", done));
  return { web, port: (web.server.address() as { port: number }).port };
}

const old = { id: "old-build", builtAt: "2025-01-01T00:00:00.000Z" };
const next = { id: "next-build", builtAt: "2025-01-02T00:00:00.000Z" };

describe("Core build identity", () => {
  it("only claims agreement for two valid equal identities", () => {
    expect(buildStatus(old, old).restartRequired).toBe("false");
    expect(buildStatus(old, next)).toEqual({
      running: old,
      disk: next,
      restartRequired: "true",
    });
    // Missing or malformed input is unknown; it is never reported as equal.
    expect(buildStatus(null, old).restartRequired).toBe("unknown");
    expect(buildStatus(old, null).restartRequired).toBe("unknown");
    expect(buildStatus(null, null).restartRequired).toBe("unknown");
  });

  it("reads one fixed manifest and refuses missing, corrupt, oversized or linked files", async () => {
    const parent = await temp("forge-build-parent-");
    const directory = join(parent, "dist");
    await mkdir(directory);
    // A manifest in a parent directory must not be consulted.
    await writeFile(join(parent, "build-info.json"), JSON.stringify(old));
    expect(await readDiskBuildInfo(directory)).toBeNull();

    const manifest = join(directory, "build-info.json");
    await writeFile(manifest, "{not json");
    expect(await readDiskBuildInfo(directory)).toBeNull();
    await writeFile(manifest, JSON.stringify({ id: old.id }));
    expect(await readDiskBuildInfo(directory)).toBeNull();
    await writeFile(manifest, JSON.stringify({ ...old, builtAt: "yesterday" }));
    expect(await readDiskBuildInfo(directory)).toBeNull();
    await writeFile(manifest, `"${"x".repeat(5000)}"`);
    expect(await readDiskBuildInfo(directory)).toBeNull();

    await writeFile(manifest, JSON.stringify(old));
    expect(await readDiskBuildInfo(directory)).toEqual(old);
    const real = join(parent, "real.json");
    await writeFile(real, JSON.stringify(next));
    await rm(manifest);
    await symlink(real, manifest);
    expect(await readDiskBuildInfo(directory)).toBeNull();
  });
});

describe("HTTP build diagnosis", () => {
  it("serves the same static facts on /api/version, connect and connection", async () => {
    const { web, port } = await fixture();
    const headers = { Host: "127.0.0.1:5173", Origin: web.origin };
    const version = await http(port, "/api/version", headers);
    expect(version.status).toBe(200);
    const body = JSON.parse(version.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "disk",
      "restartRequired",
      "running",
    ]);
    expect(body.restartRequired).toBe("unknown");
    expect(version.headers["x-forge-core-build"]).toBe("unknown");
    expect(version.headers["x-forge-core-restart-required"]).toBe("unknown");
    // No workspace, home directory, path or configuration is exposed.
    expect(version.body).not.toContain(SCRATCH);

    const connect = await http(
      port,
      "/api/connect",
      { ...headers, "Content-Type": "application/json" },
      "POST",
    );
    expect(connect.status).toBe(200);
    for (const name of [
      "x-forge-core-build",
      "x-forge-core-disk-build",
      "x-forge-core-restart-required",
    ])
      expect(connect.headers[name]).toBe("unknown");
    const connection = await http(
      port,
      "/api/connection",
      {
        ...headers,
        "Content-Type": "application/json",
        "X-Forge-Client": JSON.parse(connect.body).clientId as string,
      },
      "POST",
      JSON.stringify({ cursor: 0 }),
    );
    expect(connection.status).toBe(200);
    expect(connection.headers["x-forge-core-build"]).toBe("unknown");
    expect(connection.headers["x-forge-core-restart-required"]).toBe("unknown");
  });

  it("keeps the /api/version Host, Origin and method boundary", async () => {
    const { web, port } = await fixture();
    const headers = { Host: "127.0.0.1:5173", Origin: web.origin };
    expect((await http(port, "/api/version", headers)).status).toBe(200);
    // A same-origin page GET carries no Origin; DNS rebinding is still stopped
    // by the exact Host check, and a present Origin must match exactly.
    expect(
      (await http(port, "/api/version", { Host: "127.0.0.1:5173" })).status,
    ).toBe(200);
    for (const hostile of [
      { ...headers, Host: "evil.test:5173" },
      { ...headers, Origin: "http://evil.test:5173" },
    ])
      expect((await http(port, "/api/version", hostile)).status).toBe(403);
    expect((await http(port, "/api/version", headers, "POST")).status).toBe(
      403,
    );
  });
});
