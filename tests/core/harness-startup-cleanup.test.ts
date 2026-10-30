import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Inject a failure at each createHarness startup stage and require every
// resource opened before it to be released, newest first.
const probe = vi.hoisted(() => ({
  failAt: "" as string,
  released: [] as string[],
}));
const fail = (stage: string) => {
  if (probe.failAt === stage) throw new Error(`${stage} startup failure`);
};
const wrap = <T extends object>(name: string, value: T, method: keyof T): T =>
  new Proxy(value, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (key !== method || typeof original !== "function") return original;
      return async (...args: unknown[]) => {
        probe.released.push(name);
        return original.apply(target, args);
      };
    },
  });

vi.mock("../../src/store/memory", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/store/memory")>();
  return {
    ...original,
    openMemoryStore: async (
      ...args: Parameters<typeof original.openMemoryStore>
    ) => {
      fail("memory");
      return wrap("memory", await original.openMemoryStore(...args), "close");
    },
  };
});
vi.mock("../../src/plugins/host", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/plugins/host")>();
  return {
    ...original,
    createPluginHost: async (
      ...args: Parameters<typeof original.createPluginHost>
    ) => {
      fail("plugins");
      return wrap(
        "plugins",
        await original.createPluginHost(...args),
        "dispose",
      );
    },
  };
});
vi.mock("../../src/mcp/registry", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/mcp/registry")>();
  return {
    ...original,
    createMcpService: async (
      ...args: Parameters<typeof original.createMcpService>
    ) => {
      fail("mcp");
      return wrap("mcp", await original.createMcpService(...args), "dispose");
    },
  };
});
vi.mock("../../src/store/model-catalog", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/store/model-catalog")>();
  return {
    ...original,
    openModelCatalogStore: async (
      ...args: Parameters<typeof original.openModelCatalogStore>
    ) => {
      fail("catalog");
      return original.openModelCatalogStore(...args);
    },
  };
});
vi.mock("../../src/core/model-access", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/core/model-access")>();
  return {
    ...original,
    createModelAccessService: (
      ...args: Parameters<typeof original.createModelAccessService>
    ) =>
      wrap(
        "modelAccess",
        original.createModelAccessService(...args),
        "dispose",
      ),
  };
});
vi.mock("../../src/core/harness-input-queue", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/core/harness-input-queue")>();
  return {
    ...original,
    openHarnessInputQueue: async (
      ...args: Parameters<typeof original.openHarnessInputQueue>
    ) => {
      fail("inputQueue");
      return wrap(
        "inputQueue",
        await original.openHarnessInputQueue(...args),
        "dispose",
      );
    },
  };
});
vi.mock("../../src/core/async-tasks", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/core/async-tasks")>();
  return {
    ...original,
    openAsyncTaskService: async (
      ...args: Parameters<typeof original.openAsyncTaskService>
    ) => {
      fail("asyncTasks");
      return original.openAsyncTaskService(...args);
    },
  };
});
import { createHarness } from "../../src/core/harness";

const dirs: string[] = [];
afterEach(async () => {
  probe.failAt = "";
  probe.released = [];
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const cases: [stage: string, released: string[]][] = [
  ["memory", []],
  ["plugins", ["memory"]],
  ["mcp", ["plugins", "memory"]],
  ["catalog", ["mcp", "plugins", "memory"]],
  ["inputQueue", ["modelAccess", "mcp", "plugins", "memory"]],
  // Async-task recovery previously skipped plugins.dispose().
  ["asyncTasks", ["inputQueue", "modelAccess", "mcp", "plugins", "memory"]],
];
for (const [stage, released] of cases)
  it(`releases resources opened before a failing ${stage} stage in reverse order`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-startup-"));
    dirs.push(dir);
    const stateDir = join(dir, "state");
    // Existing receipts make startup recover async tasks.
    await mkdir(join(stateDir, "async-tasks"), {
      recursive: true,
      mode: 0o700,
    });
    probe.failAt = stage;
    await expect(createHarness({ stateDir })).rejects.toThrow(
      `${stage} startup failure`,
    );
    expect(probe.released).toEqual(released);
  });

it("releases nothing when startup succeeds until dispose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-startup-"));
  dirs.push(dir);
  const harness = await createHarness({ stateDir: join(dir, "state") });
  expect(probe.released).toEqual([]);
  await harness.dispose();
  expect(new Set(probe.released)).toEqual(
    new Set(["modelAccess", "inputQueue", "memory", "mcp", "plugins"]),
  );
});
