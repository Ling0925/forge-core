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
