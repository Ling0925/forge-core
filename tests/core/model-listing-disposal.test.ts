import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHarness } from "../../src/core/harness";
import type { ModelProvider } from "../../src/shared/contracts";

// listModels and listModelCatalog share one resolution path: a harness
// disposed while the provider resolves must not reach the provider.
for (const method of ["listModels", "listModelCatalog"] as const)
  it(`${method} rejects instead of calling a provider after disposal`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-listing-"));
    const calls: string[] = [];
    const provider: ModelProvider = {
      listModels: async () => {
        calls.push("listModels");
        return [];
      },
      listModelCatalog: async () => {
        calls.push("listModelCatalog");
        return [];
      },
      complete: async () => ({ message: { role: "assistant", content: "" } }),
    };
    const h = await createHarness({
      stateDir: join(dir, "state"),
      providerFactory: () => provider,
    });
    try {
      await h.updateSettings({
        settings: { baseUrl: "http://localhost:1234/v1", model: "m" },
      });
      const list = () =>
        method === "listModels"
          ? h.listModels()
          : (h.listModelCatalog?.() ?? Promise.reject(Error("missing")));
      await list(); // Warm the resolved-provider cache.
      calls.length = 0;
      const listing = list();
      const closing = h.dispose();
      await expect(listing).rejects.toMatchObject({ code: "cancelled" });
      await closing;
      expect(calls).toEqual([]);
    } finally {
      await h.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
