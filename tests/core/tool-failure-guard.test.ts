import { expect, it } from "vitest";
import { createToolFailureGuard } from "../../src/core/tool-failure-guard";
import type { ToolCall } from "../../src/shared/schemas";

const call = (name: string, args: object): ToolCall => ({ id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } });
const failure = { isError: true, content: '{"error":"old_text was not found."}' };
const success = { isError: false, content: '{}' };

it("recognizes equivalent arguments and does not let unrelated reads reset failures", () => {
  const guard = createToolFailureGuard();
  guard(call("edit_file", { path: "a", old_text: "x" }), failure);
  guard(call("read_file", { path: "a" }), success);
  guard(call("edit_file", { old_text: "x", path: "a" }), failure);
  expect(() => guard(call("edit_file", { path: "a", old_text: "x" }), failure)).toThrow("three identical failures");
});

it("allows revised arguments and resets after an actual file change", () => {
  const guard = createToolFailureGuard();
  const original = call("edit_file", { path: "a", old_text: "x" });
  guard(original, failure);
  guard(original, failure);
  guard(call("edit_file", { path: "a", old_text: "y" }), failure);
  guard(call("write_file", { path: "a", content: "x" }), { ...success, changes: [{ path: "a", kind: "modified" }] });
  expect(() => guard(original, failure)).not.toThrow();
});

const invalid = { isError: true, content: JSON.stringify({ code: "invalid_input", error: "write_file replacement does not accept expected_bytes." }) };

it("stops the same validation failure even when generated content changes", () => {
  const guard = createToolFailureGuard();
  guard(call("write_file", { path: "a", content: "first", expected_bytes: 0 }), invalid);
  guard(call("read_file", { path: "a" }), success);
  guard(call("write_file", { path: "a", content: "second", expected_bytes: 12 }), invalid);
  expect(() => guard(call("write_file", { path: "a", content: "third", expected_bytes: 24 }), invalid)).toThrow("correct the reported field");
});

it("keeps different validation errors and files separate and resets on corrected success", () => {
  const guard = createToolFailureGuard();
  const original = call("write_file", { path: "a", content: "first", expected_bytes: 0 });
  guard(original, invalid);
  guard(original, invalid);
  guard(call("write_file", { path: "b", content: "other", expected_bytes: 0 }), invalid);
  guard(original, { isError: true, content: JSON.stringify({ code: "invalid_input", error: "content: expected string, received number" }) });
  guard(call("write_file", { path: "a", content: "corrected" }), success);
  expect(() => guard(original, invalid)).not.toThrow();
});

it("allows meaningful argument corrections for filesystem or command failures", () => {
  const guard = createToolFailureGuard();
  for (const old_text of ["one", "two", "three", "four"])
    expect(() => guard(call("edit_file", { path: "a", old_text }), failure)).not.toThrow();
  for (const argv of [["git", "status"], ["git", "diff"], ["git", "log"]])
    expect(() => guard(call("run_command", { argv }), { isError: true, content: '{"exit_code":1}' })).not.toThrow();
});
