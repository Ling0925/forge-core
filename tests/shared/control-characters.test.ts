import { describe, expect, it } from "vitest";
import {
  C0_CONTROL,
  C0_CONTROL_OR_DELETE,
  NON_LAYOUT_CONTROLS,
  UNSAFE_DISPLAY_CHARACTER,
  UNSAFE_DISPLAY_CHARACTERS,
} from "../../src/shared/control-characters";

describe("shared control-character classes", () => {
  it("separates C0 controls from DEL", () => {
    expect(C0_CONTROL.test("a\u0000b")).toBe(true);
    expect(C0_CONTROL.test("a\u001fb")).toBe(true);
    expect(C0_CONTROL.test("a\u007fb")).toBe(false);
    expect(C0_CONTROL_OR_DELETE.test("a\u007fb")).toBe(true);
    expect(C0_CONTROL_OR_DELETE.test("plain é 文字")).toBe(false);
  });

  it("strips non-layout controls but keeps tab, LF and CR", () => {
    expect(
      "a\tb\nc\rd\u0000e\u000bf\u007fg".replace(NON_LAYOUT_CONTROLS, ""),
    ).toBe("a\tb\nc\rdefg");
  });

  it("flags C1 and bidi spoofing characters for display text", () => {
    for (const char of ["\u0085", "\u202e", "\u2066", "\u0007"])
      expect(UNSAFE_DISPLAY_CHARACTER.test(`x${char}y`)).toBe(true);
    expect(UNSAFE_DISPLAY_CHARACTER.test("safe title")).toBe(false);
    expect("a\u202eb\u0000c".replace(UNSAFE_DISPLAY_CHARACTERS, " ")).toBe(
      "a b c",
    );
  });
});
