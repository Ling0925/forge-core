import { readdirSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const modules = readdirSync(new URL("../../src/shared", import.meta.url), {
  recursive: true,
  encoding: "utf8",
})
  .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
  .map((path) => path.slice(0, -3));

beforeEach(() => vi.resetModules());

it.each(modules)("loads %s first from source", async (path) => {
  const entry = `../../src/shared/${path}.ts`;
  await expect(import(entry)).resolves.toBeDefined();
});
