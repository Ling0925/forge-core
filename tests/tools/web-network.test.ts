import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
import {
  WebAccessError,
  requestPublicText,
  validatePublicUrl,
} from "../../src/tools/web-network";

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  hang?: boolean;
  error?: Error;
};
let replies: Reply[];
let destroyed: ReturnType<typeof vi.fn>[];
const run = (
  url = "https://example.com/",
  signal = new AbortController().signal,
  beforeRequest?: (url: URL, signal: AbortSignal) => Promise<void>,
) =>
  requestPublicText(url, {
    signal,
    ...(beforeRequest ? { beforeRequest } : {}),
  });

beforeEach(() => {
  mocks.lookup
    .mockReset()
    .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  replies = [{ body: "Hello" }];
  destroyed = [];
  mocks.request.mockReset().mockImplementation((_url, _options, receive) => {
    const req = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: () => void;
    };
    req.destroy = vi.fn();
    destroyed.push(req.destroy as ReturnType<typeof vi.fn>);
    req.end = () =>
      queueMicrotask(() => {
        const reply = replies.shift() ?? {};
        if (reply.error) {
          req.emit("error", reply.error);
          return;
        }
        const response = Object.assign(new PassThrough(), {
          statusCode: reply.status ?? 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            ...reply.headers,
          },
        });
        receive(response);
        if (!reply.hang) response.end(reply.body ?? "Hello");
      });
    return req;
  });
});
afterEach(() => vi.useRealTimers());

describe("public URL and DNS boundary", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/a",
    "http://user:pass@example.com/",
    "http://example.com:8080/",
    "http://localhost/",
    "http://app.local/",
    "http://internal/",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://169.254.169.254/",
    "http://100.100.100.200/",
    "http://0.0.0.0/",
    "http://224.0.0.1/",
    "http://192.0.2.1/",
    "http://168.63.129.16/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[2001:db8::1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://[2002:7f00:1::]/",
    "http://example.com/\nsecret",
  ])("rejects unsafe URL %s before any request", async (url) => {
    await expect(run(url)).rejects.toBeInstanceOf(WebAccessError);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("normalizes safe URLs, strips fragments and accepts public IPv6", () => {
    expect(validatePublicUrl("https://example.com:443/a#fragment").href).toBe(
      "https://example.com/a",
    );
    expect(
      validatePublicUrl("https://[2606:4700:4700::1111]/").hostname,
    ).toContain("2606");
  });
  it.each([
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "10.1.2.3", family: 4 },
    ],
    [{ address: "::ffff:10.0.0.1", family: 6 }],
    [],
  ])("rejects unsafe or mixed DNS results", async (...addresses) => {
    mocks.lookup.mockResolvedValue(addresses);
    await expect(run()).rejects.toThrow(/DNS/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("pins verified DNS while preserving original TLS/Host and fixed headers", async () => {
    expect((await run()).body).toBe("Hello");
    const first = mocks.request.mock.calls[0];
    if (!first) throw new Error("Expected HTTP request");
    const [url, options] = first;
    expect(url.hostname).toBe("example.com");
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.family).toBe(4);
    const cb = vi.fn();
    options.lookup("example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(Object.keys(options.headers).sort()).toEqual([
      "Accept",
      "Accept-Encoding",
      "User-Agent",
    ]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(destroyed[0]).toHaveBeenCalled();
  });
});

it("approves each redirect, never forwards cookies, resolves each hop", async () => {
  replies = [
    {
      status: 302,
      headers: {
        location: "https://second.example/page",
        "set-cookie": "auth=secret",
      },
    },
    { body: "Final" },
  ];
  const approved: string[] = [];
  const response = await run("https://example.com/", undefined, async (url) => {
    approved.push(url.href);
  });
  expect(approved).toEqual([
    "https://example.com/",
    "https://second.example/page",
  ]);
  expect(response.url).toBe("https://second.example/page");
  expect(response.body).toBe("Final");
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(mocks.request.mock.calls[1]?.[1])).not.toContain(
    "secret",
  );
});
it.each([
  "http://127.0.0.1/",
  "https://169.254.169.254/",
  "http://example.com/insecure",
  "file:///x",
])(
  "blocks unsafe redirect %s before the next approval/connection",
  async (location) => {
    replies = [{ status: 302, headers: { location } }];
    const approve = vi.fn(async () => {});
    await expect(
      run("https://example.com/", undefined, approve),
    ).rejects.toBeInstanceOf(WebAccessError);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
  },
);
it("blocks a redirect resolving to private DNS", async () => {
  replies = [{ status: 302, headers: { location: "https://second.example/" } }];
  mocks.lookup
    .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
    .mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
  await expect(run()).rejects.toThrow(/DNS/);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it("bounds redirects without retries", async () => {
  replies = Array.from({ length: 5 }, () => ({
    status: 302,
    headers: { location: "/again" },
  }));
  await expect(run()).rejects.toThrow(/redirect limit/);
  expect(mocks.request).toHaveBeenCalledTimes(4);
});
it("denied approval never resolves DNS or sends a request", async () => {
  await expect(
    run("https://example.com/", undefined, async () => {
      throw new WebAccessError("Denied");
    }),
  ).rejects.toThrow("Denied");
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it("decodes gzip UTF-8 and charset-declared text", async () => {
  replies = [
    { headers: { "content-encoding": "gzip" }, body: gzipSync("中文正文") },
  ];
  expect((await run()).body).toBe("中文正文");
  replies = [
    {
      headers: { "content-type": "text/plain; charset=windows-1252" },
      body: Buffer.from([0xe9]),
    },
  ];
  expect((await run()).body).toBe("é");
});
it.each([
  { headers: { "content-type": "application/pdf" }, body: "%PDF" },
  { headers: { "content-encoding": "unknown" } },
  { headers: { "content-length": "3000000" } },
  { body: "a".repeat(2 * 1024 * 1024 + 1) },
  {
    headers: { "content-encoding": "gzip" },
    body: gzipSync("a".repeat(2 * 1024 * 1024 + 1)),
  },
  { status: 403, body: "secret upstream details" },
  { error: new Error("secret upstream details") },
])(
  "rejects bounded/protocol errors without leaking body or retry",
  async (reply) => {
    replies = [reply];
    await expect(run()).rejects.toBeInstanceOf(WebAccessError);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    replies = [reply];
    await expect(run()).rejects.not.toThrow("secret upstream details");
  },
);
it("cancels a pending DNS lookup", async () => {
  mocks.lookup.mockReturnValue(new Promise(() => {}));
  const abort = new AbortController();
  const work = run("https://example.com/", abort.signal);
  abort.abort();
  await expect(work).rejects.toThrow(/cancelled/);
  expect(mocks.request).not.toHaveBeenCalled();
});
it("total timeout covers headers/body and destroys requests", async () => {
  vi.useFakeTimers();
  replies = [{ hang: true }];
  const work = run();
  const assertion = expect(work).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(20001);
  await assertion;
  expect(destroyed[0]).toHaveBeenCalled();
});
it("total timeout covers approval and does not initiate DNS", async () => {
  vi.useFakeTimers();
  const work = run(
    "https://example.com/",
    undefined,
    () => new Promise(() => {}),
  );
  const assertion = expect(work).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(20001);
  await assertion;
  expect(mocks.lookup).not.toHaveBeenCalled();
});
