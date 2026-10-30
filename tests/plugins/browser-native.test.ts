import { once } from "node:events";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentBrowserBackend } from "../../src/plugins/builtin/browser/backend";

// Native protocol diagnostics stay separate from Harness so a cleanup failure
// cannot mask a failed upstream command. Only an anonymous local fixture is used.
it
  .runIf(process.env.FORGE_BROWSER_SMOKE === "1")
  .each([{ allowedDomains: ["127.0.0.1"] }, { allowedDomains: ["*"] }])(
  "protects the real ephemeral browser profile with allowedDomains=$allowedDomains and confirms cleanup",
  async ({ allowedDomains }) => {
    const root = await mkdtemp(join(tmpdir(), "forge-browser-native-"));
    const home = join(root, "state");
    const site = createServer((request, response) => {
      const port = (site.address() as { port: number }).port;
      if (request.url === "/redirect") {
        response.writeHead(302, {
          Location: `http://localhost:${port}/cross-page`,
        });
        response.end();
        return;
      }
      if (request.url === "/cross.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(
          "document.querySelector('h1').textContent = 'Cross-host resource loaded';",
        );
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><html><body><h1>Native browser fixture</h1><input id='name'><button id='go'>Go</button>" +
          (request.url === "/cross-page"
            ? `<script src="http://127.0.0.1:${port}/cross.js"></script>`
            : "") +
          "</body></html>",
      );
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    let backend:
      | Awaited<ReturnType<typeof createAgentBrowserBackend>>
      | undefined;
    let failure: unknown;
    let cleanupFailed = false;
    let ownedTemp: string | undefined;
    try {
      const browserExecutablePath =
        process.env.FORGE_BROWSER_EXECUTABLE ||
        (await import("playwright")).chromium.executablePath();
      backend = await createAgentBrowserBackend(
        {
          executablePath: "agent-browser",
          browserExecutablePath,
          allowedDomains,
        },
        { home },
      );
      await backend.check();
      const opened = await backend.execute({
        action: "navigate",
        url: `http://127.0.0.1:${(site.address() as { port: number }).port}`,
      });
      expect(opened.isError, opened.text).toBe(false);
      const runDirectories = await readdir(join(home, "browser-plugin"));
      expect(runDirectories).toHaveLength(1);
      // Inspect only this fixture backend's owned layout, never cookie contents.
      ownedTemp = (backend as unknown as { layout: { tmp: string } }).layout
        .tmp;
      expect(ownedTemp).toContain("credentials");
      expect((await lstat(ownedTemp)).mode & 0o777).toBe(0o700);
      const profileEntries = await readdir(ownedTemp, { recursive: true });
      expect(
        profileEntries.some((entry) => /(?:^|[\\/\\\\])Default$/.test(entry)),
      ).toBe(true);
      for (const command of [
        { action: "snapshot" },
        { action: "read" },
        { action: "fill", selector: "#name", text: "Fixture" },
        { action: "click", selector: "#go" },
        { action: "press", key: "Tab" },
        { action: "scroll", direction: "down", pixels: 100 },
        { action: "screenshot" },
      ] as const) {
        const result = await backend.execute(command);
        expect(result.isError, `${command.action}: ${result.text}`).toBe(false);
        if (command.action === "screenshot")
          expect(result.image?.data.length).toBeGreaterThan(100);
      }
      if (allowedDomains.includes("*")) {
        // Two loopback hostnames exercise a redirect plus a cross-host script,
        // without contacting any external site or reading a personal profile.
        const redirected = await backend.execute({
          action: "navigate",
          url: `http://127.0.0.1:${(site.address() as { port: number }).port}/redirect`,
        });
        expect(redirected.isError, redirected.text).toBe(false);
        const read = await backend.execute({ action: "read" });
        expect(read.isError, read.text).toBe(false);
        expect(read.text).toContain("Cross-host resource loaded");
      } else {
        await expect(
          backend.execute({
            action: "navigate",
            url: `http://localhost:${(site.address() as { port: number }).port}/`,
          }),
        ).rejects.toThrow(/configured allowed hostname/);
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await backend?.dispose();
      } catch (error) {
        cleanupFailed = true;
        if (failure)
          console.error("Native fixture cleanup also failed:", error);
        else failure = error;
      }
      await new Promise<void>((resolve, reject) => {
        site.close((error) => (error ? reject(error) : resolve()));
        site.closeAllConnections();
      });
      if (cleanupFailed)
        console.error(`Native fixture state retained for inspection: ${root}`);
      else {
        try {
          expect(await readdir(join(home, "browser-plugin"))).toEqual([]);
          if (ownedTemp)
            await expect(lstat(ownedTemp)).rejects.toMatchObject({
              code: "ENOENT",
            });
        } catch (error) {
          failure ??= error;
        }
        await rm(root, { recursive: true, force: true });
      }
    }
    if (failure) throw failure;
  },
  120000,
);
