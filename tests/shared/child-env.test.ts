import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  isolateGithubCredentials,
  minimalEnv,
} from "../../src/store/child-env";

afterEach(() => vi.unstubAllEnvs());

it("inherits the complete minimal environment without credentials", () => {
  vi.stubEnv("PATH", "/fixture/bin");
  vi.stubEnv("TMPDIR", "/fixture/tmp");
  vi.stubEnv("FORGE_TEST_SECRET", "private");
  expect(minimalEnv()).toEqual({
    PATH: "/fixture/bin",
    TMPDIR: "/fixture/tmp",
  });
});

it("does not invent values for missing environment variables", () => {
  vi.stubEnv("PATH", undefined);
  vi.stubEnv("TMPDIR", undefined);
  expect(minimalEnv()).toEqual({});
});

it("isolates GitHub credentials without changing the parent environment or other git configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-child-env-"));
  const credentials = {
    GH_TOKEN: "fixture-gh-token",
    GITHUB_TOKEN: "fixture-github-token",
    GH_ENTERPRISE_TOKEN: "fixture-enterprise-token",
    GITHUB_ENTERPRISE_TOKEN: "fixture-enterprise-token",
    GH_HOST: "github.example.invalid",
    GH_TOKEN_GITHUB_COM: "fixture-host-token",
  };
  const env = {
    ...credentials,
    HOME: "/fixture/home",
    GH_CONFIG_DIR: "/fixture/home/.config/gh",
    GIT_CONFIG_GLOBAL: "/fixture/gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Fixture User",
    OTHER_TOKEN: "unrelated",
  };
  try {
    const isolated = await isolateGithubCredentials(env, directory);
    for (const key of Object.keys(credentials))
      expect(isolated).not.toHaveProperty(key);
    expect(isolated).toMatchObject({
      HOME: env.HOME,
      GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Fixture User",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "credential.https://gist.github.com.helper",
      GIT_CONFIG_VALUE_3: "",
      GIT_TERMINAL_PROMPT: "0",
      OTHER_TOKEN: "unrelated",
    });
    expect(isolated.GH_CONFIG_DIR).toBe(join(directory, "github-isolated"));
    expect(await readdir(isolated.GH_CONFIG_DIR!)).toEqual([]);
    expect((await stat(isolated.GH_CONFIG_DIR!)).mode & 0o777).toBe(0o700);
    expect((await isolateGithubCredentials({}, directory)).GH_CONFIG_DIR).toBe(
      isolated.GH_CONFIG_DIR,
    );
    expect(env).toMatchObject({ ...credentials, GIT_CONFIG_COUNT: "1" });
    expect(env).not.toHaveProperty("GIT_CONFIG_KEY_1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
