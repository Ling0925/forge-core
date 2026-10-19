import { expect, it } from "vitest";
import { estimateToolCallLines } from "../../src/shared/tool-preview-lines";

it("counts escaped newlines in a complete or truncated write_file content", () => {
  expect(
    estimateToolCallLines(
      "write_file",
      '{"path":"a.ts","content":"one\\ntwo\\nthree"}',
    ),
  ).toEqual({ linesAdded: 3 });
  // Streaming stops mid-value: the estimate must already be useful.
  expect(
    estimateToolCallLines("write_file", '{"path":"a.ts","content":"one\\ntwo'),
  ).toEqual({ linesAdded: 2 });
  // A single line of content is still one added line.
  expect(
    estimateToolCallLines("write_file", '{"path":"a.ts","content":"one"}'),
  ).toEqual({ linesAdded: 1 });
});

it("estimates append chunks while arguments are still streaming", () => {
  expect(estimateToolCallLines("append_file", '{"path":"a","expected_bytes":42,"content":"one\\ntwo')).toEqual({ linesAdded: 2 });
});

it("counts raw newlines and ignores escaped backslashes that only look like \\n", () => {
  expect(estimateToolCallLines("write_file", '{"content":"a\nb"}')).toEqual({
    linesAdded: 2,
  });
  // `\\n` in the wire text is a literal backslash plus "n", not a newline.
  expect(estimateToolCallLines("write_file", '{"content":"a\\\\nb"}')).toEqual({
    linesAdded: 1,
  });
});

it("reports zero added lines for empty content and nothing for missing content", () => {
  expect(
    estimateToolCallLines("write_file", '{"path":"a","content":""}'),
  ).toEqual({
    linesAdded: 0,
  });
  expect(
    estimateToolCallLines("write_file", '{"path":"a","content":"'),
  ).toEqual({ linesAdded: 0 });
  expect(estimateToolCallLines("write_file", '{"path":"a"')).toEqual({});
});

it("derives both directions for edit_file from new_text and old_text", () => {
  expect(
    estimateToolCallLines(
      "edit_file",
      '{"path":"a.ts","old_text":"x\\nx","new_text":"y\\ny\\ny"}',
    ),
  ).toEqual({ linesAdded: 3, linesRemoved: 2 });
  // Truncated before old_text arrives: only the known half is reported.
  expect(
    estimateToolCallLines("edit_file", '{"path":"a.ts","new_text":"y'),
  ).toEqual({ linesAdded: 1 });
});

it("never inspects nested or unrelated keys and stays silent for other tools", () => {
  // A nested "content" member belongs to another object, not the arguments.
  expect(
    estimateToolCallLines(
      "write_file",
      '{"meta":{"content":"a\\nb\\nc"},"content":"z"}',
    ),
  ).toEqual({ linesAdded: 1 });
  for (const name of ["read_file", "run_command", "", "write_file_v2"]) {
    expect(
      estimateToolCallLines(name, '{"path":"a","content":"a\\nb"}'),
    ).toEqual({});
  }
  expect(estimateToolCallLines("write_file", "")).toEqual({});
});

it("ignores a trailing escape that has not delivered its letter yet", () => {
  expect(estimateToolCallLines("write_file", '{"content":"a\\nb\\')).toEqual({
    linesAdded: 2,
  });
});

it("clamps the estimate to the schema bound", () => {
  const huge = `{"content":"${"\\n".repeat(1_000_010)}"}`;
  expect(estimateToolCallLines("write_file", huge)).toEqual({
    linesAdded: 1_000_000,
  });
});
