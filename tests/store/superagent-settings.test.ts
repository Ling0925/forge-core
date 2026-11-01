import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES,
  DEFAULT_MAX_ACTIVE_AGENTS,
  configureInputSchema,
  publicSettingsSchema,
} from "../../src/shared";
import { openSettingsStore } from "../../src/store";

it("keeps webhook credentials private, preserves omitted secrets, and clears explicit empty secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-webhook-settings-"));
  try {
    const store = await openSettingsStore(directory);
    expect((await store.getPublic()).superAgent?.enabled).not.toBe(true);
    const saved = await store.update({
      settings: {
        superAgent: {
          enabled: true,
          workspace: directory,
          routerProfileId: "router",
          workerProfileId: "worker",
          github: {
            login: "bot",
            repos: ["owner/repo"],
            webhook: { host: "localhost", port: 8080 },
            webhookSecret: "fixture-secret",
          },
        },
      },
    });
    expect(saved.superAgent).toMatchObject({
      maxWorkers: DEFAULT_MAX_ACTIVE_AGENTS,
      github: {
        hasWebhookSecret: true,
        webhook: { maxBodyBytes: DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES },
      },
    });
    expect(JSON.stringify(saved)).not.toContain("fixture-secret");
    expect(saved.superAgent?.github).not.toHaveProperty("webhookSecret");
    expect(publicSettingsSchema.parse(saved)).toEqual(saved);
    expect(
      await readFile(join(directory, "settings/config.json"), "utf8"),
    ).not.toContain("fixture-secret");
    const state = JSON.parse(
      await readFile(join(directory, "settings/state.json"), "utf8"),
    );
    expect(state.webhookSecret).toBe("fixture-secret");
    expect(state.settings.superAgent.github).not.toHaveProperty(
      "webhookSecret",
    );
    await store.update({
      settings: {
        superAgent: {
          github: { webhook: { port: 8081, maxBodyBytes: 1024 } },
          maxWorkers: DEFAULT_MAX_ACTIVE_AGENTS + 1,
        },
      },
    });
    const reopened = await openSettingsStore(directory);
    expect(await reopened.getWebhookSecret()).toBe("fixture-secret");
    expect((await reopened.getPublic()).superAgent).toMatchObject({
      enabled: true,
      maxWorkers: DEFAULT_MAX_ACTIVE_AGENTS + 1,
      github: {
        login: "bot",
        repos: ["owner/repo"],
        webhook: { host: "localhost", port: 8081, maxBodyBytes: 1024 },
        hasWebhookSecret: true,
      },
    });
    const cleared = await reopened.update({
      settings: { superAgent: { github: { webhookSecret: "" } } },
    });
    expect(cleared.superAgent?.github?.hasWebhookSecret).toBe(false);
    expect(await reopened.getWebhookSecret()).toBe("");
    await reopened.update({
      settings: { superAgent: { github: { webhook: { port: 8082 } } } },
    });
    expect((await reopened.getPublic()).superAgent?.github?.webhook).toEqual({
      host: "localhost",
      port: 8082,
      maxBodyBytes: 1024,
    });
    expect(
      configureInputSchema.safeParse({
        settings: { superAgent: { github: { hasWebhookSecret: true } } },
      }).success,
    ).toBe(false);
    expect(
      publicSettingsSchema.safeParse({
        ...saved,
        superAgent: {
          github: { hasWebhookSecret: true, webhookSecret: "secret" },
        },
      }).success,
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
