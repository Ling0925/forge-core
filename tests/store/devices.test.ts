import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runDevices } from "../../src/cli/devices";
import type { DeviceAuthorization } from "../../src/shared/device-authorization";
import {
  MAX_AUTHORIZED_DEVICES,
  MAX_PAIRING_INVITATIONS,
  openDeviceAuthorization,
} from "../../src/store/devices";
const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.reverse()) await dispose();
  disposals.length = 0;
});
async function fixture(now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), "forge-fixture-devices-"));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const store = await openDeviceAuthorization({
    directory,
    ...(now ? { now } : {}),
  });
  disposals.push(() => store.close());
  return {
    store,
    directory,
    path: join(directory, "devices", "authorizations.json"),
  };
}
async function paired(store: DeviceAuthorization) {
  return store.exchange(
    (await store.createPairing("isolated fixture device")).token,
  );
}

it("exchanges a one-time invitation exactly once under concurrent independent writers", async () => {
  const f = await fixture();
  const other = await openDeviceAuthorization({ directory: f.directory });
  disposals.push(() => other.close());
  const invite = await f.store.createPairing("fixture");
  const results = await Promise.allSettled([
    f.store.exchange(invite.token),
    other.exchange(invite.token),
  ]);
  const successes = results.filter((item) => item.status === "fulfilled");
  expect(successes).toHaveLength(1);
  expect(await other.list()).toHaveLength(1);
  const value = successes[0];
  if (!value || value.status !== "fulfilled")
    throw Error("missing fixture credential");
  expect(await f.store.verify(value.value.credential)).toEqual(
    value.value.device,
  );
  await expect(f.store.exchange(invite.token)).rejects.toThrow();
});

it("persists only domain-separated hashes in private files, never invitation/device secrets", async () => {
  const f = await fixture();
  const invite = await f.store.createPairing("fixture");
  expect(await readFile(f.path, "utf8")).not.toContain(invite.token);
  const result = await f.store.exchange(invite.token);
  const stored = await readFile(f.path, "utf8");
  expect(stored).not.toContain(invite.token.split(".")[1]);
  expect(stored).not.toContain(result.credential.split(".")[1]);
  expect(JSON.stringify(await f.store.list())).not.toContain("hash");
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.directory, "devices"))).mode & 0o777).toBe(0o700);
  expect(await f.store.verify(invite.token)).toBeUndefined();
  await expect(f.store.exchange(result.credential)).rejects.toThrow();
});

it("enforces expiration and finite invitation catalog bounds", async () => {
  let clock = Date.now();
  const f = await fixture(() => clock);
  const expired = await f.store.createPairing("fixture", 1000);
  clock += 1000;
  await expect(f.store.exchange(expired.token)).rejects.toThrow();
  for (let i = 0; i < MAX_PAIRING_INVITATIONS; i++)
    await f.store.createPairing(`fixture ${i}`);
  await expect(f.store.createPairing("overflow")).rejects.toThrow();
  await expect(f.store.createPairing("bad", 600001)).rejects.toThrow();
  const data = JSON.parse(await readFile(f.path, "utf8"));
  data.invitations.push(data.invitations[0]);
  await writeFile(f.path, JSON.stringify(data), { mode: 0o600 });
  await expect(f.store.list()).rejects.toThrow();
});

it("keeps authorization/revocation durable across reopen and rejects stale readers immediately", async () => {
  const f = await fixture();
  const first = await paired(f.store);
  const second = await paired(f.store);
  const reader = await openDeviceAuthorization({ directory: f.directory });
  disposals.push(() => reader.close());
  expect(await reader.verify(first.credential)).toBeDefined();
  let notified = false;
  f.store.subscribe(async () => {
    notified = true;
  });
  await f.store.revoke(first.device.id);
  expect(notified).toBe(true);
  expect(await reader.verify(first.credential)).toBeUndefined();
  expect(await reader.verify(second.credential)).toBeDefined();
  await f.store.close();
  const reopened = await openDeviceAuthorization({ directory: f.directory });
  disposals.push(() => reopened.close());
  expect(await reopened.verify(first.credential)).toBeUndefined();
  expect(await reopened.verify(second.credential)).toBeDefined();
  expect(await reopened.list()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: first.device.id, status: "revoked" }),
    ]),
  );
});

it("fails closed on corrupt or missing authoritative state without restoring old grants", async () => {
  const f = await fixture();
  const result = await paired(f.store);
  await writeFile(f.path, '{"corrupt":true}', { mode: 0o600 });
  expect(await f.store.verify(result.credential)).toBeUndefined();
  expect(await f.store.isAuthorized(result.device.id)).toBe(false);
  await expect(
    openDeviceAuthorization({ directory: f.directory }),
  ).rejects.toThrow();
  await rm(f.path);
  expect(await f.store.verify(result.credential)).toBeUndefined();
});

it("manages fixture pairing locally without constructing a harness or model provider", async () => {
  const f = await fixture();
  const output: string[] = [];
  expect(
    await runDevices(
      ["pair", "CLI fixture"],
      (text) => output.push(text),
      f.directory,
    ),
  ).toBe(0);
  const invitation = JSON.parse(output.pop() ?? "{}");
  const paired = await f.store.exchange(invitation.token);
  await runDevices(["list"], (text) => output.push(text), f.directory);
  expect(JSON.parse(output.pop() ?? "[]")).toEqual([paired.device]);
  await runDevices(
    ["revoke", paired.device.id],
    (text) => output.push(text),
    f.directory,
  );
  expect(await f.store.verify(paired.credential)).toBeUndefined();
  expect(output.join("")).not.toContain(paired.credential);
});

it("bounds retained devices including revoked records and refuses catalog overflow", async () => {
  const f = await fixture();
  const result = await paired(f.store);
  const data = JSON.parse(await readFile(f.path, "utf8"));
  data.devices = Array.from({ length: MAX_AUTHORIZED_DEVICES }, (_, index) => ({
    ...data.devices[0],
    id: index === 0 ? result.device.id : randomUUID(),
  }));
  await writeFile(f.path, JSON.stringify(data), { mode: 0o600 });
  expect(await f.store.list()).toHaveLength(MAX_AUTHORIZED_DEVICES);
  await f.store.revoke(result.device.id);
  await expect(f.store.createPairing("overflow")).rejects.toThrow();
  data.devices.push({ ...data.devices[0], id: randomUUID() });
  await writeFile(f.path, JSON.stringify(data), { mode: 0o600 });
  expect(await f.store.isAuthorized(data.devices[1].id)).toBe(false);
});
