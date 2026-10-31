import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ForgeError } from "../../../shared/errors";
import type {
  BrowserCommand,
  BrowserCommandResult,
} from "../../../shared/plugins";
import { assertNavigable } from "./navigation";
import {
  type ToolResult,
  boundText,
  cancelled,
  imageMimeType,
  parseToolResult,
  requireNonEmptyResult,
} from "./result";
import type { Session } from "./session";

/** 700,000 base64 chars decode to at most 525,000 bytes. */
const IMAGE_MAX_BASE64_CHARS = 700_000;
const IMAGE_MAX_BYTES = Math.floor(IMAGE_MAX_BASE64_CHARS / 4) * 3;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;

export async function requestTool(
  session: Session,
  name: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const result = await session.connection.request(
    "tools/call",
    { name, arguments: { ...args } },
    signal === undefined ? undefined : { signal },
  );
  // The transport caps a frame at 1 MiB; retain a local guard so oversized
  // structured content cannot be mistaken for a usable browser result.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TOOL_RESULT_BYTES)
    throw new ForgeError(
      "tool",
      "agent-browser tool result exceeds the browser adapter limit.",
    );
  return result;
}

export function createTools(
  session: Session,
  lifecycle: {
    reclaim(): Promise<boolean>;
    dispose(): Promise<void>;
  },
  allowedDomains: readonly string[],
) {
  function actionArgs(
    command: BrowserCommand,
  ): Readonly<Record<string, unknown>> {
    const common = session.commonArgs();
    switch (command.action) {
      case "navigate":
        return { ...common, url: command.url, headed: false, webmcp: false };
      case "snapshot":
        return { ...common, interactive: true };
      case "read":
        return { ...common };
      case "click":
        return { ...common, selector: command.selector };
      case "fill":
        return { ...common, selector: command.selector, text: command.text };
      case "press":
        return { ...common, key: command.key };
      case "scroll":
        return {
          ...common,
          direction: command.direction,
          amount: command.pixels ?? 500,
        };
      case "close":
        return { ...common };
      case "screenshot":
        throw new ForgeError("tool", "Screenshot uses the private image path.");
    }
  }

  async function readOwnedImage(path: string): Promise<Buffer | undefined> {
    const screens = resolve(session.layout.screens);
    const candidate = resolve(path);
    // Never trust a path supplied by the page or the MCP response: only the
    // exact file this backend asked agent-browser to write is readable, and
    // only as a regular non-symlink file.
    if (dirname(candidate) !== screens) return undefined;
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(candidate);
    } catch {
      return undefined;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
    if (entry.size > IMAGE_MAX_BYTES) return undefined;
    const noFollow =
      (constants as unknown as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ??
      0;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(candidate, constants.O_RDONLY | noFollow);
    } catch {
      return undefined;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > IMAGE_MAX_BYTES) return undefined;
      const data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < info.size) {
        const { bytesRead } = await handle.read(
          data,
          offset,
          info.size - offset,
          offset,
        );
        if (bytesRead <= 0) break;
        offset += bytesRead;
      }
      return offset === info.size ? data : undefined;
    } finally {
      await handle.close();
    }
  }

  async function capture(
    path: string,
    format: "png" | "jpeg",
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const result = await requestTool(
      session,
      "agent_browser_screenshot",
      {
        ...session.commonArgs(),
        path,
        format,
        ...(format === "jpeg" ? { quality: 80 } : {}),
      },
      signal,
    );
    return parseToolResult(result);
  }

  async function screenshot(
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const pngPath = join(session.layout.screens, `shot-${randomUUID()}.png`);
    const jpegPath = join(session.layout.screens, `shot-${randomUUID()}.jpg`);
    try {
      const png = await capture(pngPath, "png", signal);
      if (png.isError)
        return {
          text: requireNonEmptyResult(png.text, session.secrets),
          isError: true,
        };
      let data = await readOwnedImage(pngPath);
      if (!data) {
        // PNG can exceed the shared image budget; ask for a bounded JPEG once.
        // This is a new screenshot of current state, never a replay of a
        // mutating action.
        const jpeg = await capture(jpegPath, "jpeg", signal);
        if (jpeg.isError)
          return {
            text: requireNonEmptyResult(jpeg.text, session.secrets),
            isError: true,
          };
        data = await readOwnedImage(jpegPath);
      }
      if (!data)
        return {
          text: "Screenshot was unavailable as a private PNG/JPEG within the 700,000-character image limit.",
          isError: true,
        };
      const mimeType = imageMimeType(data);
      if (!mimeType || data.toString("base64").length > IMAGE_MAX_BASE64_CHARS)
        return {
          text: "Screenshot is not a supported PNG/JPEG within the image limit.",
          isError: true,
        };
      return {
        text: `Screenshot captured (${mimeType}, ${data.length} bytes).`,
        isError: false,
        image: { mimeType, data: data.toString("base64") },
      };
    } finally {
      await Promise.all([
        rm(pngPath, { force: true }).catch(() => undefined),
        rm(jpegPath, { force: true }).catch(() => undefined),
      ]);
    }
  }

  async function check(signal?: AbortSignal): Promise<void> {
    session.assertUsable();
    if (signal?.aborted) throw cancelled();
    try {
      // Starts the MCP server and verifies required tools. It never launches
      // a browser or navigates; that only happens on an approved execute().
      await session.connect(signal);
    } catch (error) {
      await lifecycle.dispose().catch(() => undefined);
      throw error;
    }
  }

  async function execute(
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    session.assertUsable();
    if (session.browserClosed && command.action !== "close")
      throw new ForgeError(
        "tool",
        "This browser is closed. Start a new run to open another browser.",
      );
    if (signal?.aborted) throw cancelled();
    if (command.action !== "close" && !allowedDomains.length)
      throw new ForgeError(
        "invalid_input",
        "Browser plugin requires at least one allowed domain before executing actions.",
      );
    if (command.action === "navigate")
      assertNavigable(command.url, allowedDomains);
    try {
      await session.connect(signal);
      if (signal?.aborted) throw cancelled();
      // Past this point the command may launch or touch the browser, so
      // disposal must assume it needs reclaiming even if no response arrives.
      session.browserTouched = true;
      if (command.action === "screenshot") return await screenshot(signal);
      const result = await requestTool(
        session,
        session.toolName(command),
        actionArgs(command),
        signal,
      );
      const parsed = parseToolResult(result);
      if (command.action === "close" && !parsed.isError) {
        session.browserClosed = true;
        return {
          text: requireNonEmptyResult(parsed.text, session.secrets),
          isError: false,
        };
      }
      if (command.action === "close") {
        const reclaimed = await lifecycle.reclaim();
        return {
          text: boundText(
            `${requireNonEmptyResult(parsed.text, session.secrets)}${
              reclaimed
                ? ""
                : " Cleanup also failed; inspect this isolated browser before starting again."
            }`.trim(),
          ),
          isError: true,
        };
      }
      return {
        text: requireNonEmptyResult(parsed.text, session.secrets),
        isError: parsed.isError,
      };
    } catch (error) {
      // Cancellation and transport failures leave the page outcome unknown.
      // Reclaim the daemon/browser; the command is never replayed.
      const reclaimed = await lifecycle.reclaim();
      if (error instanceof ForgeError) {
        if (reclaimed) throw error;
        throw new ForgeError(
          error.code,
          boundText(
            `${error.message} Cleanup also failed; inspect this isolated browser before starting again.`,
          ),
        );
      }
      throw new ForgeError(
        "tool",
        reclaimed
          ? "Browser command failed or its outcome is unknown. This isolated browser was reclaimed; the command was not replayed."
          : "Browser command failed or its outcome is unknown, was not replayed, and cleanup of the isolated browser also failed. Inspect it before starting again.",
      );
    }
  }

  return { check, execute };
}
