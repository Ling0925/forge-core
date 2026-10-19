import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/shared/contracts";
import { type ToolCall, parseSessionId } from "../../src/shared/schemas";
import { createBrowserToolRegistry } from "../../src/tools/browser";

it.each([2, 3])(
  "rejects a %i-hop HTTP redirect chain before any downstream request",
  async (hops) => {
    let forbiddenHits = 0;
    const paths: string[] = [];
    const forbidden = createServer((_req, res) => {
      forbiddenHits++;
      res.end("Forbidden");
    });
    await new Promise<void>((resolve) =>
      forbidden.listen(0, "127.0.0.1", resolve),
    );
    const deniedAddress = forbidden.address();
    if (!deniedAddress || typeof deniedAddress === "string")
      throw new Error("No forbidden fixture address");
    const deniedURL = `http://127.0.0.1:${deniedAddress.port}/target`;
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      if (req.url === "/canonical") {
        res.end("<p>Canonical</p>");
        return;
      }
      const step = Number((req.url ?? "").split("/").pop());
      res.writeHead(302, {
        location: step < hops - 1 ? `/hop/${step + 1}` : deniedURL,
      });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No allowed fixture address");
    const base = `http://127.0.0.1:${address.port}`;
    const registry = await createBrowserToolRegistry({
      allowedOrigins: [base],
    });
    const ctx: ToolContext = {
      sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
      toolCallId: "chain",
      workspace: ".",
      permission: "unrestricted",
      signal: new AbortController().signal,
      approve: async () => true,
      onEvent: () => undefined,
    };
    const navigate = (url: string) =>
      registry.execute(
        {
          id: "chain",
          type: "function",
          function: {
            name: "browser_navigate",
            arguments: JSON.stringify({ url }),
          },
        },
        ctx,
      );
    try {
      // The first navigation fails: immediately retry on the same fresh registry.
      const denied = await navigate(`${base}/hop/0`);
      expect(denied.isError).toBe(true);
      expect(denied.content).toContain("HTTP redirects are not followed");
      expect(denied.content).toContain("explicitly allowed canonical URL");
      // Recovery is immediate: no sleep, initial successful page, or replay.
      expect((await navigate(`${base}/canonical`)).isError).toBe(false);
      expect(paths.filter((path) => path.startsWith("/hop/"))).toEqual([
        "/hop/0",
      ]);
      expect(forbiddenHits).toBe(0);
    } finally {
      await registry.dispose();
      server.closeAllConnections();
      forbidden.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => forbidden.close(() => resolve())),
      ]);
    }
  },
);

describe("browser tools", () => {
  it("navigates, reads, mutates, screenshots, enforces origins, and disposes", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://example.org/" });
        res.end();
        return;
      }
      res.end(
        '<title>QA</title><p>Hello</p><input id="value"><button id="go" onclick="document.querySelector(\'p\').textContent=\'Changed\'">Go</button>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    const base = `http://127.0.0.1:${address.port}`;
    const workspace = await mkdtemp(join(tmpdir(), "forge-browser-"));
    const registry = await createBrowserToolRegistry({
      allowedOrigins: [base],
    });
    const context: ToolContext = {
      sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
      toolCallId: "call",
      workspace,
      permission: "workspace",
      signal: new AbortController().signal,
      approve: async () => true,
      onEvent: () => undefined,
    };
    const run = async (name: string, arguments_: object) =>
      registry.execute(
        {
          id: "call",
          type: "function",
          function: { name, arguments: JSON.stringify(arguments_) },
        } as ToolCall,
        context,
      );
    try {
      expect((await run("browser_navigate", { url: `${base}/` })).isError).toBe(
        false,
      );
      expect((await run("browser_read", {})).content).toContain("Hello");
      expect((await run("browser_read", { reason: "Inspect the page" })).content).toContain("Hello");
      expect(
        (await run("browser_fill", { selector: "#value", text: "typed" }))
          .isError,
      ).toBe(false);
      expect((await run("browser_click", { selector: "#go" })).isError).toBe(
        false,
      );
      const shot = await run("browser_screenshot", { path: "capture.png" });
      expect(shot.content).toContain("capture.png");
      await expect(stat(join(workspace, "capture.png"))).resolves.toBeDefined();
      expect(
        (await run("browser_navigate", { url: "http://example.org/" })).isError,
      ).toBe(true);
      expect(
        (await run("browser_navigate", { url: `${base}/redirect` })).isError,
      ).toBe(true);
    } finally {
      await registry.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60000);
});

it("blocks forbidden redirect, subresource, popup and websocket traffic before sending", async () => {
  let hits = 0;
  let upgrades = 0;
  let workers = 0;
  const denied = createServer((_req, res) => {
    hits++;
    res.end("forbidden");
  });
  denied.on("upgrade", (_req, socket) => {
    upgrades++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => denied.listen(0, "127.0.0.1", resolve));
  const addr = denied.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  const forbidden = `http://127.0.0.1:${addr.port}`;
  const allowed = createServer((req, res) => {
    if (req.url === "/worker.js") workers++;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: forbidden });
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<p>Ready</p><img src="${forbidden}/image"><script>
      fetch('${forbidden}/fetch').catch(()=>{});
      new WebSocket('${forbidden.replace("http:", "ws:")}/socket');
      window.open('${forbidden}/popup');
      navigator.serviceWorker.register('/worker.js').catch(()=>{});
    </script>`);
  });
  await new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve));
  const address = allowed.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const registry = await createBrowserToolRegistry({ allowedOrigins: [base] });
  const ctx: ToolContext = {
    sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
    toolCallId: "c",
    workspace: ".",
    permission: "unrestricted",
    signal: new AbortController().signal,
    approve: async () => {
      throw new Error("unexpected approval");
    },
    onEvent: () => undefined,
  };
  const navigate = (url: string) =>
    registry.execute(
      {
        id: "c",
        type: "function",
        function: {
          name: "browser_navigate",
          arguments: JSON.stringify({ url }),
        },
      },
      ctx,
    );
  try {
    expect((await navigate(base)).isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await navigate(`${base}/redirect`)).isError).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(hits).toBe(0);
    expect(upgrades).toBe(0);
    expect(workers).toBe(0);
  } finally {
    await registry.dispose();
    allowed.closeAllConnections();
    denied.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => allowed.close(() => resolve())),
      new Promise<void>((resolve) => denied.close(() => resolve())),
    ]);
  }
});

it("rejects screenshot symlinks, traversal and readonly without creating artifacts; emits usable approvals", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "forge-safe-"));
  const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
  await symlink(outside, join(workspace, "link"));
  await symlink(join(outside, "final.png"), join(workspace, "final.png"));
  const server = createServer((_req, res) => res.end("<p>QA</p>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const registry = await createBrowserToolRegistry({ allowedOrigins: [base] });
  const events = new Set<string>();
  const ctx: ToolContext = {
    sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
    toolCallId: "c",
    workspace,
    permission: "workspace",
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.type === "approval_requested") events.add(event.request.id);
    },
    approve: async (request) => {
      expect(events.has(request.id)).toBe(true);
      return true;
    },
  };
  const run = (name: string, input: object, context = ctx) =>
    registry.execute(
      {
        id: "c",
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      },
      context,
    );
  try {
    expect((await run("browser_navigate", { url: base })).isError).toBe(false);
    for (const path of [
      "link/out.png",
      "final.png",
      "../out.png",
      "/tmp/out.png",
      "a/../out.png",
      ".env.png",
    ])
      expect((await run("browser_screenshot", { path })).isError).toBe(true);
    expect(
      (
        await run(
          "browser_screenshot",
          { path: "readonly.png" },
          { ...ctx, permission: "readonly" },
        )
      ).isError,
    ).toBe(true);
    await expect(stat(join(outside, "out.png"))).rejects.toThrow();
    await expect(stat(join(outside, "final.png"))).rejects.toThrow();
    await expect(stat(join(workspace, "readonly.png"))).rejects.toThrow();
    expect(events.size).toBeGreaterThan(0);
    expect(
      (
        await run(
          "browser_click",
          { selector: "p" },
          { ...ctx, permission: "readonly" },
        )
      ).isError,
    ).toBe(true);
    expect(
      (
        await run(
          "browser_fill",
          { selector: "p", text: "secret" },
          { ...ctx, permission: "readonly" },
        )
      ).isError,
    ).toBe(true);
    const failed = await run("browser_navigate", {
      url: "http://denied.invalid/?token=DO_NOT_ECHO",
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).not.toContain("DO_NOT_ECHO");
    expect((await run("browser_read", { unexpected: true })).isError).toBe(
      true,
    );
  } finally {
    await registry.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it("pre-abort performs no requests and cancellation interrupts a never-settling approval", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("QA");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  controller.abort();
  const ctx: ToolContext = {
    sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
    toolCallId: "c",
    workspace: ".",
    permission: "workspace",
    signal: controller.signal,
    approve: () => new Promise<boolean>(() => undefined),
    onEvent: () => undefined,
  };
  const call: ToolCall = {
    id: "c",
    type: "function",
    function: {
      name: "browser_navigate",
      arguments: JSON.stringify({ url: base }),
    },
  };
  const pre = await createBrowserToolRegistry({ allowedOrigins: [base] });
  const pending = await createBrowserToolRegistry({ allowedOrigins: [base] });
  try {
    expect((await pre.execute(call, ctx)).isError).toBe(true);
    expect(hits).toBe(0);
    const abort = new AbortController();
    const work = pending.execute(call, {
      ...ctx,
      signal: abort.signal,
      onEvent: () => {
        setTimeout(() => abort.abort(), 10);
      },
    });
    expect((await work).isError).toBe(true);
    expect(hits).toBe(0);
  } finally {
    await pre.dispose();
    await pending.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 5000);

it("abort and disposal interrupt delayed navigation and launch without later network effects", async () => {
  let hits = 0;
  let reached: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const server = createServer((_req, _res) => {
    hits++;
    reached();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  const ctx: ToolContext = {
    sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
    toolCallId: "c",
    workspace: ".",
    permission: "unrestricted",
    signal: controller.signal,
    approve: async () => true,
    onEvent: () => undefined,
  };
  const call: ToolCall = {
    id: "c",
    type: "function",
    function: {
      name: "browser_navigate",
      arguments: JSON.stringify({ url: base }),
    },
  };
  const registry = await createBrowserToolRegistry({ allowedOrigins: [base] });
  try {
    const work = registry.execute(call, ctx);
    await received;
    controller.abort();
    expect((await work).isError).toBe(true);
    await registry.dispose();
    expect((await registry.execute(call, ctx)).isError).toBe(true);
    expect(hits).toBe(1);
    const launching = await createBrowserToolRegistry({
      allowedOrigins: [base],
    });
    const fresh = new AbortController();
    const launchWork = launching.execute(call, {
      ...ctx,
      signal: fresh.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await launching.dispose();
    expect((await launchWork).isError).toBe(true);
    expect(hits).toBe(1);
  } finally {
    await registry.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);
