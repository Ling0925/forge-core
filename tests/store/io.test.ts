import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForgeError } from "../../src/shared/errors";
import { readJson, storageError } from "../../src/store/io";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-json-scan-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function parseWithIterator(text: string): unknown {
  try {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (const char of text) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") {
        depth += 1;
        if (depth > 64) throw storageError();
      } else if (char === "}" || char === "]") depth -= 1;
    }
    return JSON.parse(text) as unknown;
  } catch (error) {
    return error instanceof ForgeError ? error : storageError();
  }
}

const values = [
  ["number", "0"],
  ["brackets in strings", JSON.stringify("[{".repeat(65) + "}]".repeat(65))],
  ["escaped quotes and backslashes", JSON.stringify('\\"[{]}\\')],
  ["astral characters", JSON.stringify("😀𝄞[{]}")],
  ["escaped backslash before emoji", JSON.stringify("\\😀")],
  ["escaped backslash before astral character", JSON.stringify("\\𝄞")],
  ["invalid emoji escape before a quote", String.raw`"\😀"`],
  ["invalid astral escape before an escaped quote", String.raw`"\𝄞\"[{]}"`],
  ["invalid emoji escape before a backslash", String.raw`"\😀\\"`],
  ["invalid astral escape before brackets", String.raw`"\𝄞[{]}"`],
] as const;

const cases = (
  [
    ["objects", '{"value":', "}"],
    ["arrays", "[", "]"],
  ] as const
).flatMap(([shape, open, close]) =>
  [63, 64, 65].flatMap((depth) =>
    values.map(([name, value]) => ({
      name: `${shape} at depth ${depth}: ${name}`,
      text: `${open.repeat(depth)}${value}${close.repeat(depth)}`,
    })),
  ),
);

it.each(cases)("matches the iterator scan for $name", async ({ text }) => {
  const path = join(directory, "record.json");
  await writeFile(path, text, { mode: 0o600 });
  const parse = vi.spyOn(JSON, "parse");
  const expected = parseWithIterator(text);
  const calls = parse.mock.calls.slice();
  parse.mockClear();

  if (expected instanceof ForgeError)
    await expect(readJson(path)).rejects.toMatchObject(expected);
  else await expect(readJson(path)).resolves.toEqual(expected);
  expect(parse.mock.calls).toEqual(calls);
});
