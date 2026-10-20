import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  configureInputSchema,
  defaultPublicSettings,
  publicSettingsSchema,
} from "../../src/shared/schemas";
import { openSettingsStore } from "../../src/store/settings";

it("keeps old settings readable and persists explicit root limits independently of local limits", async () => {
  expect(publicSettingsSchema.parse(defaultPublicSettings)).not.toHaveProperty(
    "maxRootToolCalls",
  );
  const directory = await mkdtemp(join(tmpdir(), "forge-root-settings-"));
  try {
    const store = await openSettingsStore(directory);
    await store.update({
      settings: { maxToolCalls: 20, maxRootToolCalls: 45, rootTimeoutMs: 2000 },
    });
    const reopened = await openSettingsStore(directory);
    expect(await reopened.getPublic()).toMatchObject({
      maxToolCalls: 20,
      maxRootToolCalls: 45,
      rootTimeoutMs: 2000,
    });
    await reopened.update({ settings: { maxToolCalls: 5 } });
    expect(await store.getPublic()).toMatchObject({
      maxToolCalls: 5,
      maxRootToolCalls: 45,
      rootTimeoutMs: 2000,
    });
    expect(
      configureInputSchema.safeParse({ settings: { rootTimeoutMs: 0 } })
        .success,
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
