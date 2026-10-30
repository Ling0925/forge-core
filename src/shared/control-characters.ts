/**
 * Character classes that intentionally match control characters.
 *
 * Validators and display sanitizers share these definitions instead of
 * repeating hand-written ranges. Global variants are for `replace` only;
 * use the non-global ones with `test` so no `lastIndex` state is carried.
 */

/** C0 controls (U+0000–U+001F). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose.
export const C0_CONTROL = /[\x00-\x1f]/;

/** C0 controls plus DEL (U+007F). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose.
export const C0_CONTROL_OR_DELETE = /[\x00-\x1f\x7f]/;

/** C0 controls except tab, LF and CR, plus DEL; for stripping from text output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose.
export const NON_LAYOUT_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** C0/C1 controls and bidi embeddings/overrides/isolates that can spoof displayed text. */
export const UNSAFE_DISPLAY_CHARACTER =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the purpose.
  /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;

/** Global form of {@link UNSAFE_DISPLAY_CHARACTER} for `replace`. */
export const UNSAFE_DISPLAY_CHARACTERS = new RegExp(
  UNSAFE_DISPLAY_CHARACTER.source,
  "g",
);
