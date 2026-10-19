import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Browser, type Page, chromium } from "playwright";
import { z } from "zod";
import { invalidToolInput, noArgumentFields, noArgumentProperties, recoverToolInputError } from "../shared/tool-input";
import type {
  BrowserToolOptions,
  LocalToolRegistry,
  ToolContext,
} from "../shared/contracts";
import type {
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../shared/schemas";
import { createWorkspacePathGuard } from "./path-guard";

const LIMIT = 12000;
const selectors = z.string().min(1).max(1000);
const text = z.string().min(1).max(4000);
const args = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("browser_navigate"),
      url: z.string().url().max(4096),
    })
    .strict(),
  z.object({ tool: z.literal("browser_read"), ...noArgumentFields }).strict(),
  z.object({ tool: z.literal("browser_click"), selector: selectors }).strict(),
  z
    .object({ tool: z.literal("browser_fill"), selector: selectors, text })
    .strict(),
  z
    .object({
      tool: z.literal("browser_screenshot"),
      path: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ tool: z.literal("browser_close"), ...noArgumentFields }).strict(),
]);
const props = { type: "object", additionalProperties: false } as const;
const definitions: readonly ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Navigate to an exact allowlisted HTTP(S) origin. Forge readonly/plan mode denies browser tools. Workspace requires approval; unrestricted does not. Scripts may have remote side effects.",
      parameters: {
        ...props,
        properties: { url: { type: "string", format: "uri", maxLength: 4096 } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_read",
      description: "Read bounded visible page text.",
      parameters: { ...props, properties: noArgumentProperties, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click a selector (1000 chars max); readonly denied. Workspace requires scoped approval.",
      parameters: {
        ...props,
        properties: {
          selector: { type: "string", minLength: 1, maxLength: 1000 },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fill",
      description:
        "Fill a selector; readonly denied. Workspace requires scoped approval.",
      parameters: {
        ...props,
        properties: {
          selector: { type: "string", minLength: 1, maxLength: 1000 },
          text: { type: "string", minLength: 1, maxLength: 4000 },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Save a 1280x720 PNG (at most 2 MiB) to a safe relative workspace path with an existing parent. Readonly cannot write; workspace requires approval. Returns text metadata, not image pixels.",
      parameters: {
        ...props,
        properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description: "Close the ephemeral browser context.",
      parameters: { ...props, properties: noArgumentProperties, required: [] },
    },
  },
];
const result = (value: JsonValue, isError = false): ToolResult => ({
  content: JSON.stringify(value),
  isError,
});
function origin(url: string): string {
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Only credential-free HTTP(S) URLs are allowed.");
  return parsed.origin;
}

export interface ForgeBrowserOptions extends BrowserToolOptions {
  readonly protectedRoots?: readonly string[];
  readonly redactValues?: readonly string[];
}
export async function createBrowserToolRegistry(
  options: ForgeBrowserOptions,
): Promise<LocalToolRegistry> {
  const allowed = new Set(
    options.allowedOrigins.map((value) => {
      if (origin(value) !== value)
        throw new Error("Expected exact HTTP(S) origins.");
      return value;
    }),
  );
  const approved = new Set<string>();
  const shutdown = new AbortController();
  let browser: Browser | undefined;
  let launching: Promise<Page> | undefined;
  let page: Page | undefined;
  let creatingPage = false;
  let replaceFailedPage: (() => Promise<void>) | undefined;
  let disposal: Promise<void> | undefined;
  let redirectRejected = false;
  const redirectPages = new WeakSet<Page>();
  let tail: Promise<unknown> = Promise.resolve();
  const active = new Set<Promise<ToolResult>>();
  const signals = new Set<AbortSignal>();
  const routes = new Set<Promise<void>>();
  const clean = (value: string): string => {
    let output = value;
    for (const secret of options.redactValues ?? [])
      if (secret) output = output.split(secret).join("[REDACTED]");
    return output;
  };
  const check = (): void => {
    if (shutdown.signal.aborted) throw new Error("cancelled");
  };
  const close = async (): Promise<void> => {
    await browser?.close();
    if (launching) await launching.catch(() => undefined);
    await browser?.close();
    await Promise.allSettled([...routes]);
    page = undefined;
  };
  const stop = (): void => {
    shutdown.abort();
    void browser?.close().catch(() => undefined);
  };
  const ensure = (): Promise<Page> => {
    check();
    launching ??= (async () => {
      const executablePath =
        options.executablePath ?? process.env.FORGE_BROWSER_EXECUTABLE;
      browser = await chromium.launch({
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        },
        headless: options.headless ?? true,
        timeout: 15000,
        ...(executablePath ? { executablePath } : {}),
      });
      if (shutdown.signal.aborted) {
        await browser.close();
        check();
      }
      const context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
        viewport: { width: 1280, height: 720 },
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", async (route) => {
        const work = (async () => {
          try {
            check();
            const request = route.request();
            if (request.frame().page() !== page || creatingPage) {
              await route.abort("blockedbyclient");
              return;
            }
            const target = origin(request.url());
            if (!allowed.has(target) || !approved.has(target)) {
              await route.abort("blockedbyclient");
              return;
            }
            const response = await route.fetch({
              maxRedirects: 0,
              timeout: 15000,
            });
            try {
              check();
              // Never hand a 3xx to Chromium: subsequent redirect hops can bypass
              // routing. Reject even same-origin redirects (and 3xx without Location).
              if (response.status() >= 300 && response.status() < 400) {
                redirectRejected = true;
                redirectPages.add(request.frame().page());
                await route.abort("blockedbyclient");
                return;
              }
              await route.fulfill({ response });
            } finally {
              await response.dispose();
            }
          } catch {
            await route.abort("blockedbyclient").catch(() => undefined);
          }
        })();
        routes.add(work);
        try {
          await work;
        } finally {
          routes.delete(work);
        }
      });
      context.on("page", (popup) => {
        if (popup !== page && !creatingPage)
          void popup.close().catch(() => undefined);
      });
      const createPage = async (): Promise<Page> => {
        check();
        creatingPage = true;
        try {
          const created = await context.newPage();
          if (shutdown.signal.aborted) {
            await created.close();
            check();
          }
          page = created;
          created.on("framenavigated", (frame) => {
            // A failed page can commit its internal error document asynchronously.
            // Its listener must never affect a replacement page or registry.
            if (page !== created) return;
            // Only a page with a policy-rejected response may commit an internal
            // blank/error document; other non-HTTP navigations still close the run.
            if (
              redirectPages.has(created) &&
              (frame.url() === "about:blank" ||
                frame.url() === "chrome-error://chromewebdata/")
            )
              return;
            try {
              if (
                !allowed.has(origin(frame.url())) ||
                !approved.has(origin(frame.url()))
              )
                stop();
            } catch {
              stop();
            }
          });
          created.on("download", (download) => {
            void download.cancel();
          });
          return created;
        } finally {
          creatingPage = false;
        }
      };
      replaceFailedPage = async () => {
        check();
        const failed = page;
        page = undefined;
        await failed?.close();
        check();
        await createPage();
      };
      const created = await createPage();
      check();
      return created;
    })();
    return launching;
  };
  async function approval(
    ctx: ToolContext,
    call: ToolCall,
    description: string,
  ): Promise<void> {
    check();
    if (ctx.permission === "unrestricted") return;
    const request = {
      id: randomUUID(),
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      toolName: call.function.name,
      description: clean(description),
    };
    ctx.onEvent({
      type: "approval_requested",
      sessionId: ctx.sessionId,
      timestamp: new Date().toISOString(),
      request,
    });
    const ok = await new Promise<boolean>((resolve, reject) => {
      const abort = () => reject(new Error("cancelled"));
      shutdown.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          check();
          return ctx.approve(request, shutdown.signal);
        })
        .then(resolve, reject)
        .finally(() => shutdown.signal.removeEventListener("abort", abort));
      if (shutdown.signal.aborted) abort();
    });
    check();
    if (!ok) throw new Error("denied");
  }
  async function perform(
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    redirectRejected = false;
    try {
      check();
      if (call.function.arguments.length > 16000) return invalidToolInput("Tool call arguments exceed 16000 characters.");
      const input: unknown = JSON.parse(call.function.arguments);
      const object = z.record(z.unknown()).parse(input);
      if ("tool" in object) return invalidToolInput("tool is not an accepted argument; use the declared parameters.");
      const parsed = args.parse({ ...object, tool: call.function.name });
      if (parsed.tool === "browser_close") {
        stop();
        await close();
        return result({ closed: true });
      }
      if (parsed.tool === "browser_navigate") {
        const target = origin(parsed.url);
        if (!allowed.has(target)) throw new Error("denied");
        await approval(
          ctx,
          call,
          `Allow browser access to exact origin ${target}. Scripts can cause remote side effects even in readonly mode. No other origins granted.`,
        );
        approved.add(target);
        await ensure();
        check();
        if (page && redirectPages.has(page)) await replaceFailedPage?.();
        check();
        const p = page;
        if (!p) throw new Error("no page");
        await p.goto(parsed.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        check();
        if (redirectRejected)
          return result(
            {
              error:
                "HTTP redirects are not followed. Navigate directly to an explicitly allowed canonical URL instead.",
            },
            true,
          );
        return result({ navigated: true });
      }
      if (!page) throw new Error("no page");
      const p = page;
      if (parsed.tool === "browser_read") {
        const extracted = await p.locator("body").evaluate(
          (body, limit) => {
            const walker = document.createTreeWalker(
              body,
              NodeFilter.SHOW_TEXT,
            );
            let output = "";
            let visited = 0;
            while (output.length < limit && visited++ < 20000) {
              const node = walker.nextNode();
              if (!node) break;
              const parent = node.parentElement;
              if (
                !parent ||
                parent.closest("script,style,noscript") ||
                !parent.checkVisibility()
              )
                continue;
              output += (node.textContent ?? "").slice(
                0,
                limit - output.length,
              );
            }
            return {
              text: output,
              truncated: output.length >= limit || visited >= 20000,
            };
          },
          LIMIT,
          { timeout: 10000 },
        );
        check();
        return result({
          text: clean(extracted.text),
          truncated: extracted.truncated,
        });
      }
      if (parsed.tool === "browser_screenshot" && !parsed.path)
        return result({
          note: "Text-only tool: specify a relative PNG artifact path. Images are not attached.",
        });
      if (ctx.permission === "readonly") throw new Error("readonly");
      if (parsed.tool === "browser_screenshot") {
        const path = parsed.path;
        if (
          !path ||
          !/^[a-zA-Z0-9_./-]+\.png$/.test(path) ||
          path.startsWith("/") ||
          path
            .split("/")
            .some(
              (part) =>
                !part ||
                part === "." ||
                part === ".." ||
                /^\.(?:env|ssh|config|git)/i.test(part) ||
                /credentials|private|id_rsa|id_ed25519/i.test(part),
            )
        )
          throw new Error("path");
        const guard = await createWorkspacePathGuard(
          ctx.workspace,
          options.protectedRoots,
        );
        const dest = await guard.resolveWrite(path);
        await approval(
          ctx,
          call,
          `Write a viewport PNG artifact to workspace path ${path}.`,
        );
        check();
        const png = await p.screenshot({
          type: "png",
          fullPage: false,
          animations: "disabled",
          timeout: 10000,
        });
        check();
        if (png.length > 2 * 1024 * 1024) throw new Error("size");
        const temporary = join(dirname(path), `forge-shot-${randomUUID()}.png`);
        const temp = await guard.resolveWrite(temporary);
        let created = false;
        try {
          check();
          const handle = await open(
            temp,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          created = true;
          try {
            await handle.writeFile(png);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await guard.resolveWrite(path);
          await guard.resolveRead(temporary);
          check();
          await rename(temp, dest);
        } finally {
          if (created) await unlink(temp).catch(() => undefined);
        }
        return result({
          artifact: clean(path),
          bytes: png.length,
          width: 1280,
          height: 720,
          note: "PNG saved; image not visible to text-only models.",
        });
      }
      await approval(
        ctx,
        call,
        `Browser ${parsed.tool} at ${origin(p.url())}; selector ${parsed.selector}; ${parsed.tool === "browser_fill" ? `fill ${parsed.text.length} characters` : "click may submit or navigate"}.`,
      );
      check();
      if (parsed.tool === "browser_click")
        await p.locator(parsed.selector).click({ timeout: 10000 });
      else
        await p.locator(parsed.selector).fill(parsed.text, { timeout: 10000 });
      check();
      return result({ completed: true });
    } catch (error) {
      const invalid = recoverToolInputError(error);
      if (invalid) return invalid;
      return result(
        {
          error: shutdown.signal.aborted
            ? "Browser operation cancelled; registry closed."
            : redirectRejected
              ? "HTTP redirects are not followed. Navigate directly to an explicitly allowed canonical URL instead."
              : "Browser operation denied or failed. Check permission, origin policy, arguments, artifact path, and page state.",
        },
        true,
      );
    }
  }
  return {
    definitions,
    execute(call, ctx) {
      if (!signals.has(ctx.signal)) {
        signals.add(ctx.signal);
        ctx.signal.addEventListener("abort", stop, { once: true });
      }
      if (ctx.signal.aborted) stop();
      const work = tail
        .then(() => perform(call, ctx))
        .then(async (value) => {
          if (shutdown.signal.aborted) await close();
          return value;
        });
      active.add(work);
      tail = work.catch(() => undefined);
      void work.finally(() => active.delete(work)).catch(() => undefined);
      return work;
    },
    dispose() {
      disposal ??= (async () => {
        stop();
        await close();
        await Promise.allSettled([...active]);
        for (const signal of signals) signal.removeEventListener("abort", stop);
        signals.clear();
      })();
      return disposal;
    },
  };
}
