import { expect, it, vi } from "vitest";
import {
  HostResponseError,
  createTransportBridge,
} from "../../src/shared/bridge";
import type { RpcRequest } from "../../src/shared/ipc";

it.each([
  [
    "id_mismatch",
    (input: RpcRequest) => ({
      id: "PRIVATE-ID",
      method: input.method,
      ok: true,
      result: [],
    }),
  ],
  [
    "method_mismatch",
    (input: RpcRequest) => ({
      id: input.id,
      method: "PRIVATE-METHOD",
      ok: true,
      result: [],
    }),
  ],
  [
    "schema_mismatch",
    (input: RpcRequest) => ({
      id: input.id,
      method: input.method,
      ok: true,
      result: "PRIVATE-BODY",
    }),
  ],
  [
    "schema_mismatch",
    (input: RpcRequest) => ({
      id: input.id,
      method: input.method,
      ok: true,
      result: [],
      PRIVATE_FIELD: "secret",
    }),
  ],
  ["schema_mismatch", () => null],
] as const)(
  "classifies %s without exposing any remote payload %#",
  async (reason, response) => {
    const request = vi.fn(async (input: RpcRequest) => response(input));
    const bridge = createTransportBridge({ request, onEvent: () => {} });
    const error = await bridge.listSessions().catch((error) => error);
    expect(error).toBeInstanceOf(HostResponseError);
    expect(error).toMatchObject({ method: "listSessions", reason });
    expect(error.message).toContain("wait for active tasks to finish");
    expect(error.message).toContain("No request was automatically replayed");
    expect(error.message).not.toMatch(/PRIVATE|secret/);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("keeps successful RPCs and strict event validation, never retries transport failures", async () => {
  let receive: (raw: unknown) => void = () => {};
  const request = vi.fn(async (input: RpcRequest) => ({
    id: input.id,
    method: input.method,
    ok: true,
    result: [],
  }));
  const bridge = createTransportBridge({
    request,
    onEvent: (listener) => {
      receive = listener;
    },
  });
  expect(await bridge.listSessions()).toEqual([]);
  const listener = vi.fn();
  bridge.onEvent(listener);
  receive({ PRIVATE: "body", event: { type: "invalid" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(listener).not.toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error("transport unavailable"));
  await expect(bridge.listSessions()).rejects.toThrow("transport unavailable");
  expect(request).toHaveBeenCalledTimes(2);
});
