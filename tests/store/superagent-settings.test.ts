import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

it("stores the board token privately and preserves it across partial settings updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-board-settings-"));
  const token = "board-token-never-public";
  try {
    const store = await openSettingsStore(directory);
    const saved = await store.update({
      settings: {
        superAgent: {
          board: {
            url: "http://board.invalid",
            projectId: "project",
            accountable: "human",
            token,
          },
        },
      },
    });
    expect(saved.superAgent?.workItems?.backend).toBe("local");
    expect(saved.superAgent?.board).toEqual({
      url: "http://board.invalid",
      projectId: "project",
      accountable: "human",
      hasToken: true,
    });
    expect(publicSettingsSchema.parse(saved)).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(saved.superAgent?.board).not.toHaveProperty("token");
    expect(
      await readFile(join(directory, "settings/config.json"), "utf8"),
    ).not.toContain(token);
    const path = join(directory, "settings/state.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    expect(state.boardToken).toBe(token);
    expect(state.settings.superAgent.board).not.toHaveProperty("token");
    expect((await stat(path)).mode & 0o077).toBe(0);
    await store.update({
      settings: {
        superAgent: {
          workItems: { backend: "board" },
          board: { projectId: "another-project" },
        },
      },
    });
    await store.update({
      settings: { superAgent: { maxWorkers: 2, workItems: {} } },
    });
    const reopened = await openSettingsStore(directory);
    expect(await reopened.getBoardToken()).toBe(token);
    const publicSettings = await reopened.getPublic();
    expect(publicSettings.superAgent?.workItems?.backend).toBe("board");
    expect(publicSettings.superAgent?.board).toEqual({
      ...saved.superAgent?.board,
      projectId: "another-project",
    });
    expect(JSON.stringify(publicSettings)).not.toContain(token);
    const cleared = await reopened.update({
      settings: { superAgent: { board: { token: "" } } },
    });
    expect(cleared.superAgent?.board?.hasToken).toBe(false);
    expect(await reopened.getBoardToken()).toBe("");
    expect(
      configureInputSchema.safeParse({
        settings: { superAgent: { board: { hasToken: true } } },
      }).success,
    ).toBe(false);
    expect(
      publicSettingsSchema.safeParse({
        ...saved,
        superAgent: { board: { ...saved.superAgent?.board, token } },
      }).success,
    ).toBe(false);
    expect(
      (
        await store.update({
          settings: { superAgent: { workItems: { backend: "local" } } },
        })
      ).superAgent?.workItems?.backend,
    ).toBe("local");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves partial board settings without adding required fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-board-settings-"));
  try {
    const store = await openSettingsStore(directory);
    expect(
      (
        await store.update({
          settings: { superAgent: { board: { url: "http://board.invalid" } } },
        })
      ).superAgent?.board,
    ).toEqual({ url: "http://board.invalid", hasToken: false });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
