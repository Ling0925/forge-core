import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createRunEvents } from "../../src/core/runtime-events";
import { createRunState } from "../../src/core/runtime-state";
import { ForgeError } from "../../src/shared/errors";
import { parseSessionId } from "../../src/shared/schemas";

it("reports sink failures without making notifications transactional", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const events = createRunEvents(
    createRunState(),
    parseSessionId(randomUUID()),
    () => {
      throw new ForgeError("invalid_input", "Invalid approval request.");
    },
    () => new Date().toISOString(),
  );
  expect(() =>
    events.ephemeral({ type: "text_delta", text: "x" }),
  ).not.toThrow();
  expect(report).toHaveBeenCalledWith("Event sink failed.", {
    code: "invalid_input",
    message: "Invalid approval request.",
    retryable: false,
  });
});
