import { expect, it } from "vitest";
import { rpcRequestSchema } from "../../src/shared/ipc";
import { messageSchema } from "../../src/shared/schemas";
it("accepts the reconciliation origin on user messages without migrating legacy text", () => {
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

it("keeps delivery metadata out of external steering RPCs", () => {
  const request = {
    id: "22222222-2222-4222-8222-222222222222",
    method: "steerRun",
    runId: "11111111-1111-4111-8111-111111111111",
    prompt: "prompt",
  };
  expect(rpcRequestSchema.safeParse(request).success).toBe(true);
  for (const metadata of [
    { origin: "superagent" },
    { superagent: { kind: "work_updates", workId: "work" } },
  ])
    expect(
      rpcRequestSchema.safeParse({ ...request, ...metadata }).success,
    ).toBe(false);
});

it.each([
  "route_batch",
  "work_brief",
  "work_updates",
  "work_changed",
  "worker_report",
])("accepts %s metadata only with the superagent user origin", (kind) => {
  const message = {
    role: "user",
    content: "Delivered prompt",
    origin: "superagent",
    superagent: { kind, workId: "work", triggerIds: ["trigger"] },
  };
  expect(messageSchema.parse(message)).toEqual(message);
  expect(
    messageSchema.parse({
      role: "user",
      content: "prompt",
      origin: "superagent",
    }),
  ).toMatchObject({ origin: "superagent" });
  for (const origin of [undefined, "agent_reconciliation"])
    expect(messageSchema.safeParse({ ...message, origin }).success).toBe(false);
  for (const role of ["system", "assistant", "tool"])
    expect(messageSchema.safeParse({ ...message, role }).success).toBe(false);
  expect(
    messageSchema.safeParse({ ...message, superagent: { kind: "unknown" } })
      .success,
  ).toBe(false);
});
