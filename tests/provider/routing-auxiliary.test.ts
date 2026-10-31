import { expect, it } from "vitest";
import { ProviderError } from "../../src/provider/errors";
import {
  createRouteState,
  createRoutedProvider,
} from "../../src/provider/routing";
import type { ModelProvider } from "../../src/shared/contracts";
import { routeGroupSchema } from "../../src/shared/model-access";

const session = "11111111-1111-4111-8111-111111111111";
function route(fail: Set<string>) {
  const calls: string[] = [];
  const state = createRouteState();
  const group = routeGroupSchema.parse({
    id: "g",
    label: "G",
    strategy: "rotate",
    sticky: true,
    members: ["a", "b", "c"].map((sourceId) => ({ sourceId, model: "m" })),
  });
  const routed = createRoutedProvider({
    group,
    state,
    resolve: (member) => ({
      provider: {
        listModels: async () => [],
        complete: async () => {
          calls.push(member.sourceId);
          if (fail.has(member.sourceId))
            throw new ProviderError("http", "Rate limited.", true, 429);
          return { message: { role: "assistant", content: member.sourceId } };
        },
      } satisfies ModelProvider,
    }),
  });
  const ask = (provider: ModelProvider, sessionId?: string) =>
    provider.complete([{ role: "user", content: "hi" }], [], {
      model: "m",
      signal: new AbortController().signal,
      onText: () => {},
      ...(sessionId ? { sessionId } : {}),
    });
  return { calls, state, routed, ask };
}

it("follows the session's sticky member without moving the pin", async () => {
  const { calls, state, routed, ask } = route(new Set());
  await ask(routed, session);
  const pinned = state.sticky.get(session);
  expect(calls).toHaveLength(1);
  for (let i = 0; i < 3; i++) await ask(routed.auxiliary(session));
  expect(calls).toEqual([calls[0], calls[0], calls[0], calls[0]]);
  expect(state.sticky.get(session)).toBe(pinned);
});

it("fails over unexecuted members but keeps the run's retry chain untouched", async () => {
  const { calls, state, routed, ask } = route(new Set(["a", "b"]));
  await expect(ask(routed, session)).rejects.toThrow("Rate limited.");
  const runLast = state.last.get(session);
  expect(runLast?.kind).toBe("unexecuted");
  calls.length = 0;
  const response = await ask(routed.auxiliary(session));
  expect(response.message.content).toBe("c");
  expect(calls.at(-1)).toBe("c");
  // The run may still retry its own unexecuted request.
  expect(state.last.get(session)).toBe(runLast);
  expect(routed.routeControl.mayRetry(session)).toBe(true);
});

it("stops after a bounded number of members", async () => {
  const { calls, routed, ask } = route(new Set(["a", "b", "c"]));
  await expect(ask(routed.auxiliary(session))).rejects.toThrow("Rate limited.");
  expect(calls).toHaveLength(3);
});
