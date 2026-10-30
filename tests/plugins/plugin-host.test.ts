import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserBackend } from "../../src/plugins/browser";
import { createPluginHost } from "../../src/plugins/host";
import type { ToolContext } from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import {
  type BrowserCommand,
  type BrowserCommandResult,
  browserPluginConfigSchema,
} from "../../src/shared/plugins";
import {
  type PublishedFile,
  collectPublishedFiles,
} from "../../src/shared/published-files";
import { type Permission, parseSessionId } from "../../src/shared/schemas";

const id = parseSessionId("00000000-0000-4000-8000-000000000001");
const otherId = parseSessionId("00000000-0000-4000-8000-000000000002");
const homes: string[] = [];
const hosts: Awaited<ReturnType<typeof createPluginHost>>[] = [];
const image = { mimeType: "image/png" as const, data: "iVBORw0KGgo=" };
const file: PublishedFile = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "browser.png",
  mimeType: "image/png",
  size: 8,
  sha256: "0".repeat(64),
  createdAt: "2026-10-24T00:00:00.000Z",
  previewKind: "image",
};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "forge-plugin-test-"));
  homes.push(home);
  const backends: {
    execute: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
  }[] = [];
  const factory = vi.fn(async (): Promise<BrowserBackend> => {
    const backend = {
      execute: vi.fn(
        async (command: BrowserCommand): Promise<BrowserCommandResult> => ({
          text:
            command.action === "snapshot"
              ? "[ref=e1] button Go"
              : command.action,
          isError: false,
          ...(command.action === "screenshot" ? { image } : {}),
        }),
      ),
      check: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    backends.push(backend);
    return backend;
  });
  const publish = vi.fn(async () => file);
  const host = await createPluginHost(home, {
    browserFactory: factory,
    publishImage: publish,
  });
  hosts.push(host);
  const enable = () =>
    host.configure({
      pluginId: "browser",
      enabled: true,
      config: { allowedDomains: ["example.com", "*.allowed.test"] },
    });
  return { home, host, factory, backends, publish, enable };
}
function context(permission: Permission = "unrestricted"): ToolContext {
  return {
    sessionId: id,
    workspace: "/tmp",
    toolCallId: "browser-call",
    permission,
    signal: new AbortController().signal,
    approve: vi.fn(async () => true),
    onEvent: vi.fn(),
  };
}
const call = (name: string, args: object = {}) => ({
  id: "browser-call",
  type: "function" as const,
  function: { name: `browser_${name}`, arguments: JSON.stringify(args) },
});
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("plugin management", () => {
  it("lists disabled builtins and composes tools without launching a backend", async () => {
    const { host, factory, enable, home } = await fixture();
    expect(await host.list()).toMatchObject([
      {
        enabled: false,
        status: "disabled",
        activeSessions: 0,
        manifest: { id: "browser", apiVersion: 1, builtin: true },
      },
      {
        enabled: false,
        status: "disabled",
        activeSessions: 0,
        manifest: { id: "officecli", apiVersion: 1, builtin: true },
      },
    ]);
    expect((await host.createTools("/tmp")).registry.definitions).toEqual([]);
    await expect(readFile(join(home, "plugins.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await enable();
    const scope = await host.createTools("/tmp");
    expect(scope.enabledIds).toEqual(["browser"]);
    expect(
      scope.registry.definitions.map((tool) => tool.function.name),
    ).toContain("browser_snapshot");
    expect(scope.registry.definitions).toHaveLength(9);
    expect(scope.instructions).toContain("untrusted");
    await scope.registry.dispose();
    expect(factory).not.toHaveBeenCalled();
    expect((await host.list())[0]).toMatchObject({
      status: "configured",
      activeSessions: 0,
    });
  });
  it("rejects unknown plugins, incompatible config, implicit wildcard network access and no-op updates", async () => {
    const { host } = await fixture();
    await expect(
      host.configure({ pluginId: "unknown", enabled: true }),
    ).rejects.toThrow("Unknown plugin");
    await expect(
      host.configure({ pluginId: "browser", enabled: true }),
    ).rejects.toThrow("allowedDomains");
    await expect(
      host.configure({
        pluginId: "browser",
        config: { allowedDomains: ["*"], profile: "/secret" },
      }),
    ).rejects.toThrow("Invalid browser");
    await expect(host.configure({ pluginId: "browser" })).rejects.toThrow();
    expect(
      browserPluginConfigSchema.safeParse({ executablePath: "x\nunsafe" })
        .success,
    ).toBe(false);
    expect(
      browserPluginConfigSchema.safeParse({
        allowedDomains: ["https://example.com"],
      }).success,
    ).toBe(false);
  });
  it("persists an explicit all-host wildcard without implicitly starting a browser", async () => {
    const { host, home, factory } = await fixture();
    const record = await host.configure({
      pluginId: "browser",
      enabled: true,
      config: { allowedDomains: ["*"] },
    });
    expect(record).toMatchObject({
      enabled: true,
      status: "configured",
      config: { allowedDomains: ["*"] },
    });
    expect(
      JSON.parse(await readFile(join(home, "plugins.json"), "utf8")).plugins
        .browser.config.allowedDomains,
    ).toEqual(["*"]);
    expect(factory).not.toHaveBeenCalled();
    expect(browserPluginConfigSchema.parse({}).allowedDomains).toEqual([]);
    for (const domain of ["**", "*example.com", "*.*", "https://*", "", " * "])
      expect(
        browserPluginConfigSchema.safeParse({ allowedDomains: [domain] })
          .success,
      ).toBe(false);
  });
  it("checks only after an explicit request and cleans the diagnostic process", async () => {
    const { host, factory, backends } = await fixture();
    expect((await host.health("browser")).status).toBe("ready");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(backends[0]!.check).toHaveBeenCalledTimes(1);
    expect(backends[0]!.execute).not.toHaveBeenCalled();
    expect(backends[0]!.dispose).toHaveBeenCalledTimes(1);
    expect((await host.list())[0]!.status).toBe("disabled");
  });
  it("reports configured rather than inventing an available browser on health failure", async () => {
    const { host, factory, enable } = await fixture();
    await enable();
    factory.mockRejectedValueOnce(new Error("private upstream details"));
    expect(await host.health("browser")).toMatchObject({
      status: "unavailable",
    });
    expect(JSON.stringify(await host.health("browser"))).not.toContain(
      "private upstream details",
    );
    expect((await host.list())[0]!.status).toBe("configured");
  });
  it("persists explicit enablement, retains same-revision scopes and revokes changed scopes", async () => {
    const { host, home, enable, backends } = await fixture();
    await enable();
    const scope = await host.createTools("/tmp");
    await scope.registry.execute(
      call("navigate", { url: "https://example.com/" }),
      context(),
    );
    expect((await host.list())[0]).toMatchObject({
      status: "running",
      activeSessions: 1,
    });
    await host.configure({ pluginId: "browser", enabled: true });
    expect(backends[0]!.dispose).not.toHaveBeenCalled();
    await host.configure({ pluginId: "browser", enabled: false });
    expect(backends[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(
      await host.browser({ sessionId: id, action: "status" }),
    ).toMatchObject({ available: false });
    expect(
      JSON.parse(await readFile(join(home, "plugins.json"), "utf8")).plugins
        .browser.enabled,
    ).toBe(false);
  });
});

describe("browser permissions and ownership", () => {
  it("denies readonly/plan and declined approval before process creation", async () => {
    const { host, factory, enable } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    const readonly = context("readonly");
    expect(
      (
        await registry.execute(
          call("navigate", { url: "https://example.com/" }),
          readonly,
        )
      ).isError,
    ).toBe(true);
    expect(readonly.approve).not.toHaveBeenCalled();
    const workspace = {
      ...context("workspace"),
      approve: vi.fn(async () => false),
    };
    expect(
      (
        await registry.execute(
          call("navigate", { url: "https://example.com/" }),
          workspace,
        )
      ).isError,
    ).toBe(true);
    expect(workspace.approve).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
  });
  it("requires fresh workspace approval for each call and redacts output", async () => {
    const { host, enable, backends } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp", ["private-key"]);
    const ctx = context("workspace");
    await registry.execute(
      call("navigate", { url: "https://example.com/" }),
      ctx,
    );
    backends[0]!.execute.mockResolvedValueOnce({
      text: "page private-key",
      isError: false,
    });
    const result = await registry.execute(call("snapshot"), ctx);
    expect(result.content).toContain("[REDACTED]");
    expect(ctx.approve).toHaveBeenCalledTimes(2);
    expect(ctx.onEvent).toHaveBeenCalledTimes(2);
  });
  it("rechecks permission and configuration after approval", async () => {
    const { host, enable, factory } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    let permission: Permission = "workspace";
    const ctx = {
      ...context(),
      get permission() {
        return permission;
      },
      approve: async () => {
        permission = "readonly";
        return true;
      },
    };
    expect(
      (
        await registry.execute(
          call("navigate", { url: "https://example.com/" }),
          ctx,
        )
      ).isError,
    ).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    const next = await host.createTools("/tmp");
    const changed = {
      ...context("workspace"),
      approve: async () => {
        await host.configure({ pluginId: "browser", enabled: false });
        return true;
      },
    };
    await expect(
      next.registry.execute(
        call("navigate", { url: "https://example.com/" }),
        changed,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(factory).not.toHaveBeenCalled();
  });
  it("validates domain and tool/argument allowlists before effects", async () => {
    const { host, enable, factory } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    for (const url of [
      "file:///etc/passwd",
      "https://example.com.evil.test/",
      "https://u:p@example.com/",
      "https://other.test/",
    ]) {
      expect(
        (await registry.execute(call("navigate", { url }), context())).isError,
      ).toBe(true);
    }
    expect(
      (await registry.execute(call("eval", { code: "unsafe" }), context()))
        .isError,
    ).toBe(true);
    expect(
      (
        await registry.execute(
          call("snapshot", { session: "someone-else" }),
          context(),
        )
      ).isError,
    ).toBe(true);
    expect(factory).not.toHaveBeenCalled();
    expect(
      (
        await registry.execute(
          call("navigate", { url: "https://child.allowed.test/" }),
          context(),
        )
      ).isError,
    ).toBe(false);
  });
  it.each([{ domains: ["*"] }, { domains: ["example.com", "*"] }])(
    "allows arbitrary HTTP(S) hosts with $domains without bypassing other permissions",
    async ({ domains }) => {
      const { host, factory } = await fixture();
      await host.configure({
        pluginId: "browser",
        enabled: true,
        config: { allowedDomains: domains },
      });
      const { registry } = await host.createTools("/tmp");
      const navigation = call("navigate", {
        url: "https://not-listed.test/page",
      });
      expect(
        (await registry.execute(navigation, context("readonly"))).isError,
      ).toBe(true);
      const denied = {
        ...context("workspace"),
        approve: vi.fn(async () => false),
      };
      expect((await registry.execute(navigation, denied)).isError).toBe(true);
      expect(denied.approve).toHaveBeenCalledTimes(1);
      for (const url of [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "https://user:pass@not-listed.test/",
      ])
        expect(
          (await registry.execute(call("navigate", { url }), context()))
            .isError,
        ).toBe(true);
      expect(factory).not.toHaveBeenCalled();
      const approved = context("workspace");
      expect((await registry.execute(navigation, approved)).isError).toBe(
        false,
      );
      expect(approved.approve).toHaveBeenCalledTimes(1);
      await host.browser({ sessionId: id, action: "takeover", enabled: true });
      expect(
        await host.browser({
          sessionId: id,
          action: "execute",
          command: { action: "navigate", url: "http://127.0.0.1:8080/" },
        }),
      ).toMatchObject({ result: { isError: false } });
      await host.browser({ sessionId: id, action: "takeover", enabled: false });
    },
  );
  it("isolates scopes and rejects session or workspace impersonation", async () => {
    const { host, enable, factory } = await fixture();
    await enable();
    const a = await host.createTools("/tmp");
    const b = await host.createTools("/tmp");
    await a.registry.execute(
      call("navigate", { url: "https://example.com/" }),
      context(),
    );
    expect(
      (
        await a.registry.execute(call("snapshot"), {
          ...context(),
          sessionId: otherId,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await a.registry.execute(call("snapshot"), {
          ...context(),
          workspace: "/elsewhere",
        })
      ).isError,
    ).toBe(true);
    await b.registry.execute(
      call("navigate", { url: "https://example.com/" }),
      { ...context(), sessionId: otherId },
    );
    expect(factory).toHaveBeenCalledTimes(2);
    await a.registry.dispose();
    expect(
      (await host.browser({ sessionId: otherId, action: "status" })).available,
    ).toBe(true);
    expect(
      (await host.browser({ sessionId: id, action: "status" })).available,
    ).toBe(false);
  });
});

describe("browser preview and human control", () => {
  it("does not create a browser from metadata or manual requests", async () => {
    const { host, factory, enable } = await fixture();
    await enable();
    await host.createTools("/tmp");
    expect(await host.browser({ sessionId: id, action: "status" })).toEqual({
      sessionId: id,
      available: false,
      takeover: false,
    });
    await expect(
      host.browser({
        sessionId: id,
        action: "execute",
        command: { action: "screenshot" },
      }),
    ).rejects.toThrow("No active browser");
    expect(factory).not.toHaveBeenCalled();
  });
  it("previews screenshots without transferring control, but blocks manual mutations until takeover", async () => {
    const { host, enable } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    await registry.execute(
      call("navigate", { url: "https://example.com/" }),
      context(),
    );
    await expect(
      host.browser({
        sessionId: id,
        action: "execute",
        command: { action: "click", selector: "@e1" },
      }),
    ).rejects.toThrow("Take browser control");
    expect(
      await host.browser({
        sessionId: id,
        action: "execute",
        command: { action: "screenshot" },
      }),
    ).toMatchObject({ available: true, takeover: false, result: { image } });
  });
  it("pauses agent actions, serializes human input and invalidates stale pending interactions", async () => {
    const { host, enable, backends } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    const ctx = context();
    await registry.execute(
      call("navigate", { url: "https://example.com/" }),
      ctx,
    );
    await host.browser({ sessionId: id, action: "takeover", enabled: true });
    // A queued click must not act on stale @refs after the human changes the page.
    const pending = registry.execute(call("click", { selector: "@e1" }), ctx);
    await host.browser({
      sessionId: id,
      action: "execute",
      command: { action: "fill", selector: "@e2", text: "manual input" },
    });
    expect(
      backends[0]!.execute.mock.calls.map(([command]) => command.action),
    ).toEqual(["navigate", "fill"]);
    await host.browser({ sessionId: id, action: "takeover", enabled: false });
    expect(await pending).toMatchObject({
      isError: true,
      content: expect.stringContaining("fresh browser_snapshot"),
    });
    // A newly issued mutation also needs observation; only refreshing a snapshot releases this guard.
    expect(
      (await registry.execute(call("click", { selector: "@e1" }), ctx)).isError,
    ).toBe(true);
    await registry.execute(call("snapshot"), ctx);
    expect(
      (await registry.execute(call("click", { selector: "@e1" }), ctx)).isError,
    ).toBe(false);
  });
  it("can release control after a permission downgrade without permitting any browser action", async () => {
    const { host, enable, backends } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    let permission: Permission = "unrestricted";
    const ctx = {
      ...context(),
      get permission() {
        return permission;
      },
    };
    await registry.execute(
      call("navigate", { url: "https://example.com/" }),
      ctx,
    );
    await host.browser({ sessionId: id, action: "takeover", enabled: true });
    permission = "readonly";
    await expect(
      host.browser({
        sessionId: id,
        action: "execute",
        command: { action: "screenshot" },
      }),
    ).rejects.toThrow("readonly");
    expect(
      await host.browser({ sessionId: id, action: "takeover", enabled: false }),
    ).toMatchObject({ takeover: false });
    expect(backends[0]!.execute).toHaveBeenCalledTimes(1);
  });
  it("cancels a paused action, joins cleanup and never replays it", async () => {
    const { host, enable, backends } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    const abort = new AbortController();
    const ctx = { ...context(), signal: abort.signal };
    await registry.execute(
      call("navigate", { url: "https://example.com/" }),
      ctx,
    );
    await host.browser({ sessionId: id, action: "takeover", enabled: true });
    const pending = registry.execute(call("click", { selector: "@e1" }), ctx);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    abort.abort();
    await rejected;
    await registry.dispose();
    expect(backends[0]!.execute).toHaveBeenCalledTimes(1);
    expect(backends[0]!.dispose).toHaveBeenCalledTimes(1);
  });
  it("publishes screenshots as retrievable attachments without putting pixels in the transcript", async () => {
    const { host, enable, publish } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    const tool = call("screenshot");
    const result = await registry.execute(tool, context());
    expect(result.files).toEqual([file]);
    expect(result.content).not.toContain(image.data);
    expect(publish).toHaveBeenCalledWith(id, image, expect.any(AbortSignal));
    const transcript = [
      { role: "assistant", content: null, tool_calls: [tool] },
      { role: "tool", content: JSON.stringify(result), tool_call_id: tool.id },
    ];
    expect(collectPublishedFiles(transcript)).toEqual([file]);
    expect(
      collectPublishedFiles([
        {
          ...transcript[0]!,
          tool_calls: [{ ...tool, function: { name: "untrusted_tool" } }],
        },
        transcript[1]!,
      ]),
    ).toEqual([]);
  });
  it("surfaces an uncertain backend error without replaying it", async () => {
    const { host, enable, backends } = await fixture();
    await enable();
    const { registry } = await host.createTools("/tmp");
    await registry.execute(
      call("navigate", { url: "https://example.com/" }),
      context(),
    );
    backends[0]!.execute.mockRejectedValueOnce(
      new ForgeError("tool", "Browser outcome is uncertain."),
    );
    const result = await registry.execute(
      call("click", { selector: "@e1" }),
      context(),
    );
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining("uncertain"),
    });
    expect(backends[0]!.execute).toHaveBeenCalledTimes(2);
    expect(
      await host.browser({ sessionId: id, action: "status" }),
    ).toMatchObject({ available: false });
  });
});
