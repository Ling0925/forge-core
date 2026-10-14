import { expect, it } from "vitest";
import { messageSchema } from "../../src/shared/schemas";
it("accepts only the exact optional reconciliation origin on user messages without migrating legacy text", () => {
  const human = {
    role: "user",
    content: "All spawned children joined. Integrate these bounded results",
  };
  expect(messageSchema.parse(human)).toEqual(human);
  expect(
    messageSchema.parse({ ...human, origin: "agent_reconciliation" }),
  ).toEqual({ ...human, origin: "agent_reconciliation" });
  for (const origin of ["human", "reconciliation", null, 1])
    expect(messageSchema.safeParse({ ...human, origin }).success).toBe(false);
  for (const role of ["assistant", "system", "tool"])
    expect(
      messageSchema.safeParse({
        role,
        content: "internal",
        origin: "agent_reconciliation",
        ...(role === "tool" ? { tool_call_id: "id" } : {}),
      }).success,
    ).toBe(false);
});
