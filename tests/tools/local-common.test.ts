import { expect, it, vi } from "vitest";
import { withCancellation } from "../../src/shared/cancellation";
import { toolCancelled } from "../../src/tools/local-common";

it("observes work before rejecting an already-cancelled approval", async () => {
  const controller = new AbortController();
  controller.abort();
  const work = Promise.reject(new Error("Approval failed"));
  const observe = vi.spyOn(work, "then");
  try {
    await expect(
      withCancellation(work, controller.signal, toolCancelled),
    ).rejects.toMatchObject({
      code: "cancelled",
      message: "Tool execution cancelled.",
    });
    expect(observe).toHaveBeenCalled();
  } finally {
    await work.catch(() => undefined);
  }
});
