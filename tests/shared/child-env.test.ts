import { afterEach, expect, it, vi } from "vitest";
import { minimalEnv } from "../../src/shared/child-env";

afterEach(() => vi.unstubAllEnvs());

it("inherits the complete minimal environment without credentials", () => {
  vi.stubEnv("PATH", "/fixture/bin");
  vi.stubEnv("TMPDIR", "/fixture/tmp");
  vi.stubEnv("SYSTEMROOT", "C:\\fixture");
  vi.stubEnv("FORGE_TEST_SECRET", "private");
  expect(minimalEnv()).toEqual({
    PATH: "/fixture/bin",
    TMPDIR: "/fixture/tmp",
    ...(process.platform === "win32" ? { SYSTEMROOT: "C:\\fixture" } : {}),
  });
});

it("does not invent values for missing environment variables", () => {
  vi.stubEnv("PATH", undefined);
  vi.stubEnv("TMPDIR", undefined);
  vi.stubEnv("SYSTEMROOT", undefined);
  expect(minimalEnv()).toEqual({});
});
