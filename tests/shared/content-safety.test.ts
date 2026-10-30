import { describe, expect, it } from "vitest";
import {
  containsSensitiveText,
  isSensitivePath,
} from "../../src/shared/content-safety";

describe("shared content safety", () => {
  it.each([
    ".env.local",
    "nested/.ssh/config",
    "nested\\.config\\app",
    "ID_ED25519",
    "service-credentials.json",
    "nested/server.PEM",
  ])("refuses sensitive path segments in %s", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each(["src/settings.ts", "docs/key-management.md", "public/readme.txt"])(
    "allows ordinary project paths: %s",
    (path) => {
      expect(isSensitivePath(path)).toBe(false);
    },
  );

  it.each([
    "-----BEGIN PRIVATE KEY-----\nfixture",
    "  -----BEGIN RSA PRIVATE KEY-----\nfixture",
    "\t-----BEGIN EC PRIVATE KEY-----\nfixture",
    'export access_token="abcdefgh12345678"',
    `example sk-${"x".repeat(32)}`,
  ])("recognizes secret-shaped content: %j", (text) => {
    expect(containsSensitiveText(text)).toBe(true);
  });

  it.each([
    "# Project instructions",
    "API_KEY=",
    "password policy documentation",
  ])("allows ordinary content: %j", (text) => {
    expect(containsSensitiveText(text)).toBe(false);
  });
});
