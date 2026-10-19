import { expect, it } from "vitest";
import type { ToolContext } from "../../src/shared/contracts";
import { parseSessionId } from "../../src/shared/schemas";
import { createWebToolRegistry } from "../../src/tools/web";

// Explicit opt-in: normal tests never depend on public network availability.
it.runIf(process.env.FORGE_WEB_SMOKE === "1")(
  "reads a public page and searches live Bing RSS without credentials",
  async () => {
    const registry = createWebToolRegistry();
    const ctx: ToolContext = {
      sessionId: parseSessionId("00000000-0000-4000-8000-000000000001"),
      toolCallId: "web-smoke",
      workspace: ".",
      permission: "unrestricted",
      signal: new AbortController().signal,
      approve: async () => false,
      onEvent: () => {},
    };
    try {
      const page = await registry.execute(
        {
          id: "page",
          type: "function",
          function: {
            name: "web_fetch",
            arguments: JSON.stringify({
              url: "https://example.com/",
              limit: 2000,
            }),
          },
        },
        ctx,
      );
      expect(page.isError, page.content).toBe(false);
      expect(JSON.parse(page.content).text).toContain("documentation examples");
      const search = await registry.execute(
        {
          id: "search",
          type: "function",
          function: {
            name: "web_search",
            arguments: JSON.stringify({
              query: "TypeScript documentation",
              count: 3,
            }),
          },
        },
        ctx,
      );
      expect(search.isError, search.content).toBe(false);
      expect(JSON.parse(search.content).results.length).toBeGreaterThan(0);
      console.log(
        "Live web smoke: example.com text verified; search returned",
        JSON.parse(search.content).results.length,
        "results.",
      );
    } finally {
      await registry.dispose();
    }
  },
  50000,
);
