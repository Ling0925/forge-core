import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createGithubWebhook } from "../../src/host";
import { openSuperAgentStore } from "../../src/store";
import { deferred } from "./fixture";
import { payload } from "./github-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
async function setup(maxBodyBytes?: number) {
  const dir = await mkdtemp(join(tmpdir(), "forge-webhook-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = await openSuperAgentStore(dir);
  cleanup.push(() => store.close());
  const processDelivery = vi.fn(async () => {});
  const onError = vi.fn();
  const receiver = await createGithubWebhook({
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes,
    secret: "fixture-secret",
    store,
    processDelivery,
    onError,
  });
  cleanup.push(() => receiver.close());
  const address = receiver.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing TCP address");
  const body = JSON.stringify(payload);
  const headers = {
    "X-GitHub-Delivery": "delivery-1",
    "X-GitHub-Event": "issue_comment",
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", "fixture-secret").update(body).digest("hex")}`,
  };
  return {
    store,
    processDelivery,
    onError,
    body,
    headers,
    url: `http://127.0.0.1:${address.port}`,
  };
}

it("persists before 202, processes afterward, and rejects replays", async () => {
  const f = await setup();
  const entered = deferred();
  const release = deferred();
  const record = f.store.recordDelivery;
  vi.spyOn(f.store, "recordDelivery").mockImplementation(async (delivery) => {
    entered.resolve();
    await release.promise;
    return record(delivery);
  });
  let replied = false;
  const response = fetch(f.url, {
    method: "POST",
    headers: f.headers,
    body: f.body,
  }).then((result) => {
    replied = true;
    return result;
  });
  await entered.promise;
  expect(replied).toBe(false);
  expect(f.processDelivery).not.toHaveBeenCalled();
  release.resolve();
  expect((await response).status).toBe(202);
  expect(await f.store.unprocessedDeliveries()).toMatchObject([
    { id: "delivery-1", payload },
  ]);
  await vi.waitFor(() => expect(f.processDelivery).toHaveBeenCalledOnce());
  expect(
    (await fetch(f.url, { method: "POST", headers: f.headers, body: f.body }))
      .status,
  ).toBe(409);
  expect(f.processDelivery).toHaveBeenCalledOnce();
});

it.each([undefined, "sha256=bad", `sha256=${"0".repeat(64)}`])(
  "rejects missing/invalid signatures (%s)",
  async (signature) => {
    const f = await setup();
    const { "X-Hub-Signature-256": _, ...headers } = f.headers;
    expect(
      (
        await fetch(f.url, {
          method: "POST",
          headers: {
            ...headers,
            ...(signature ? { "X-Hub-Signature-256": signature } : {}),
          },
          body: f.body,
        })
      ).status,
    ).toBe(401);
    expect(await f.store.unprocessedDeliveries()).toEqual([]);
    expect(f.processDelivery).not.toHaveBeenCalled();
  },
);

it("requires POST and a delivery ID, and checks the unmodified body", async () => {
  const f = await setup();
  expect((await fetch(f.url)).status).toBe(405);
  const { "X-GitHub-Delivery": _, ...headers } = f.headers;
  expect(
    (await fetch(f.url, { method: "POST", headers, body: f.body })).status,
  ).toBe(400);
  expect(
    (
      await fetch(f.url, {
        method: "POST",
        headers: f.headers,
        body: `${f.body}\n`,
      })
    ).status,
  ).toBe(401);
});

it.each(["content-length", "chunked"])(
  "rejects an oversized %s upload before the client finishes sending it",
  async (framing) => {
    const limit = Buffer.byteLength(JSON.stringify(payload));
    const f = await setup(limit);
    const record = vi.spyOn(f.store, "recordDelivery");
    const response = new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        f.url,
        {
          method: "POST",
          headers: {
            ...f.headers,
            ...(framing === "content-length"
              ? { "Content-Length": limit + 1 }
              : { "Transfer-Encoding": "chunked" }),
          },
        },
        (res) => {
          expect(res.headers.connection).toBe("close");
          res.resume();
          res.on("end", () => {
            resolve(res.statusCode);
            req.destroy();
          });
        },
      );
      cleanup.push(async () => {
        req.destroy();
      });
      req.on("error", reject);
      req.flushHeaders();
      if (framing === "chunked") {
        req.write(f.body);
        setImmediate(() => req.write(" "));
      }
    });
    expect(await response).toBe(413);
    expect(record).not.toHaveBeenCalled();
    expect(await f.store.unprocessedDeliveries()).toEqual([]);
    expect(f.processDelivery).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  },
);

it("accepts a signed body exactly at the byte limit", async () => {
  const f = await setup(Buffer.byteLength(JSON.stringify(payload)));
  expect(
    (await fetch(f.url, { method: "POST", headers: f.headers, body: f.body }))
      .status,
  ).toBe(202);
  expect(await f.store.unprocessedDeliveries()).toHaveLength(1);
});
