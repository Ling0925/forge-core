import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  LocalToolRegistry,
  ToolContext,
} from "../../src/shared/contracts";
import { type ToolCall, parseSessionId } from "../../src/shared/schemas";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../src/tools/web-network", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/web-network")>()),
  requestPublicText: mocks.request,
}));
import { createWebToolRegistry } from "../../src/tools/web";

const call = (name: string, args: unknown): ToolCall => ({
  id: "web",
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const context = (patch: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
  toolCallId: "web",
  workspace: ".",
  permission: "unrestricted",
  signal: new AbortController().signal,
  approve: vi.fn(async () => true),
  onEvent: vi.fn(),
  ...patch,
});
let registry: LocalToolRegistry;
let body: string;
let mime: string;
let transmitted: string[];
beforeEach(() => {
  registry = createWebToolRegistry({ redactValues: ["fixture-secret"] });
  body = `<title>Article</title><main><p>${"正文 content ".repeat(20)}</p><a href='/ref'>Reference</a></main>`;
  mime = "text/html";
  transmitted = [];
  mocks.request.mockReset().mockImplementation(async (url, options) => {
    await options.beforeRequest(new URL(url), options.signal);
    if (options.signal.aborted) throw new Error("aborted");
    transmitted.push(url);
    return { url, status: 200, contentType: mime, body };
  });
});
afterEach(async () => {
  await registry.dispose();
});

it("registration is lazy and exposes only page fetch, not a fake search function", () => {
  expect(registry.definitions.map((tool) => tool.function.name)).toEqual(["web_fetch"]);
  expect(mocks.request).not.toHaveBeenCalled();
});
it.each(["workspace"] as const)(
  "requires fresh %s approval for every network request",
  async (permission) => {
    const ctx = context({ permission });
    await registry.execute(
      call("web_fetch", { url: "https://example.com/a" }),
      ctx,
    );
    await registry.execute(
      call("web_fetch", { url: "https://example.com/b" }),
      ctx,
    );
    expect(ctx.approve).toHaveBeenCalledTimes(2);
    expect(ctx.onEvent).toHaveBeenCalledTimes(2);
    expect(transmitted).toHaveLength(2);
    expect(JSON.stringify(vi.mocked(ctx.approve).mock.calls[0]?.[0])).toContain(
      "https://example.com/a",
    );
  },
);
it("honors denial before transmitting, unrestricted does not prompt", async () => {
  const denied = context({
    permission: "workspace",
    approve: vi.fn(async () => false),
  });
  expect(
    (
      await registry.execute(
        call("web_fetch", { url: "https://example.com/" }),
        denied,
      )
    ).isError,
  ).toBe(true);
  expect(transmitted).toEqual([]);
  const open = context();
  expect(
    (
      await registry.execute(
        call("web_fetch", { url: "https://example.com/" }),
        open,
      )
    ).isError,
  ).toBe(false);
  expect(open.approve).not.toHaveBeenCalled();
});
it("paginates stable cached text and refetches only on refresh", async () => {
  const ctx = context({ permission: "workspace" });
  const read = async (args: object) =>
    JSON.parse(
      (
        await registry.execute(
          call("web_fetch", {
            url: "https://example.com/",
            limit: 10,
            ...args,
          }),
          ctx,
        )
      ).content,
    );
  const first = await read({});
  expect(first.from_cache).toBe(false);
  expect(first.next_offset).toBe(10);
  body = "<p>Changed</p>";
  const second = await read({ offset: first.next_offset });
  expect(second.from_cache).toBe(true);
  expect(second.fetched_at).toBe(first.fetched_at);
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(ctx.approve).toHaveBeenCalledTimes(1);
  const refreshed = await read({ refresh: true });
  expect(refreshed.text).toBe("Changed");
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("evicts the oldest of eight cached pages", async () => {
  for (let i = 0; i < 9; i++)
    await registry.execute(
      call("web_fetch", { url: `https://example.com/${i}` }),
      context(),
    );
  const output = await registry.execute(
    call("web_fetch", { url: "https://example.com/0" }),
    context(),
  );
  expect(JSON.parse(output.content).from_cache).toBe(false);
  expect(mocks.request).toHaveBeenCalledTimes(10);
});
it("never executes old local web_search calls or falls back to Bing", async () => {
  const output = await registry.execute(call("web_search", { query: "test" }), context());
  expect(output.isError).toBe(true);
  expect(mocks.request).not.toHaveBeenCalled();
});
it.each([
  ["web_search", { query: "fixture-secret" }],
  ["web_fetch", { url: "https://example.com/?key=fixture%2Dsecret" }],
  ["web_fetch", { url: "http://127.0.0.1/" }],
  ["web_search", { query: "test", count: 100 }],
  [
    "web_fetch",
    { url: "https://example.com", headers: { Authorization: "test" } },
  ],
  ["web_fetch", { url: "https://example.com", tool: "web_fetch" }],
  ["unknown", {}],
])(
  "rejects invalid/secret arguments for %s before network",
  async (name, input) => {
    expect(
      (await registry.execute(call(name as string, input), context())).isError,
    ).toBe(true);
    expect(mocks.request).not.toHaveBeenCalled();
  },
);
it("redacts configured keys and bounds serialized output", async () => {
  mime = "text/plain";
  body = `fixture-secret \u202e\x1b[31m${'"\\中文'.repeat(60000)}`;
  const output = await registry.execute(
    call("web_fetch", { url: "https://example.com/", limit: 20000 }),
    context(),
  );
  expect(output.isError).toBe(false);
  expect(output.content).not.toContain("fixture-secret");
  expect(output.content).not.toContain("\u202e");
  expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(96 * 1024);
  expect(JSON.parse(output.content).extraction_truncated).toBe(true);
});
it("cancels pending approval, joins disposal, and rejects later calls", async () => {
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const ctx = context({
    permission: "workspace",
    approve: () => {
      notify();
      return new Promise(() => {});
    },
  });
  const work = registry.execute(
    call("web_fetch", { url: "https://example.com/" }),
    ctx,
  );
  await started;
  await registry.dispose();
  expect((await work).content).toContain("cancelled");
  expect(transmitted).toEqual([]);
  expect(
    (
      await registry.execute(
        call("web_fetch", { url: "https://example.com/" }),
        context(),
      )
    ).isError,
  ).toBe(true);
});
it("never echoes unexpected transport errors", async () => {
  mocks.request.mockRejectedValue(new Error("provider-secret response body"));
  const output = await registry.execute(
    call("web_fetch", { url: "https://example.com/" }),
    context(),
  );
  expect(output.isError).toBe(true);
  expect(output.content).not.toContain("provider-secret");
});

it.each(["web_search", "web_fetch"])(
  "rejects %s in readonly before approval or network",
  async (name) => {
    const ctx = context({ permission: "readonly" });
    const input =
      name === "web_search"
        ? { query: "public docs" }
        : { url: "https://example.com/" };
    const output = await registry.execute(call(name, input), ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain("readonly");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(ctx.approve).not.toHaveBeenCalled();
  },
);

it("rechecks permission after pending approval", async () => {
  let permission: ToolContext["permission"] = "workspace";
  const ctx = context({
    approve: async () => {
      permission = "readonly";
      return true;
    },
  });
  Object.defineProperty(ctx, "permission", { get: () => permission });
  const output = await registry.execute(
    call("web_fetch", { url: "https://example.com/" }),
    ctx,
  );
  expect(output.isError).toBe(true);
  expect(transmitted).toEqual([]);
});
