import { afterEach, expect, it, vi } from "vitest";
import { minimalEnv } from "../../src/store/child-env";

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
