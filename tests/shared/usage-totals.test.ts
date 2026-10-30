import { expect, it } from "vitest";
import { addUsage } from "../../src/shared/usage-totals";

const base = { promptTokens: 10, completionTokens: 2, totalTokens: 12 };

it("sums token counts", () => {
  expect(addUsage(base, base)).toEqual({
    promptTokens: 20,
    completionTokens: 4,
    totalTokens: 24,
  });
});

it("never invents cached usage but keeps a count reported on either side", () => {
  expect(addUsage(base, base)).not.toHaveProperty("cachedPromptTokens");
  expect(addUsage({ ...base, cachedPromptTokens: 3 }, base)).toMatchObject({
    cachedPromptTokens: 3,
  });
  expect(addUsage(base, { ...base, cachedPromptTokens: 0 })).toMatchObject({
    cachedPromptTokens: 0,
  });
  expect(
    addUsage(
      { ...base, cachedPromptTokens: 3 },
      { ...base, cachedPromptTokens: 4 },
    ),
  ).toMatchObject({ cachedPromptTokens: 7 });
});
