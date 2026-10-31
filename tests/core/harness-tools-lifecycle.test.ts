import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHarness } from "../../src/core/harness";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const ownership = vi.hoisted(() => ({
  secrets: new Map<string, { registries: number }>(),
}));
vi.mock("../../src/core/harness-tools", async (original) => {
  const module =
    await original<typeof import("../../src/core/harness-tools")>();
  return {
    ...module,
    createHarnessTools: (
      deps: Parameters<typeof module.createHarnessTools>[0],
    ) => {
      ownership.secrets = deps.taskSecrets;
      return module.createHarnessTools(deps);
    },
  };
});

it("retains each credential only until its last live registry is disposed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-secret-owners-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const running = new Map<string, ReturnType<typeof deferred>>();
  const harness = await createHarness({
    stateDir: join(directory, "state"),
    providerFactory: () => ({
      listModels: async () => [],
      complete: async (_messages, _tools, options) => {
        const barrier = deferred();
        running.set(options.sessionId!, barrier);
        await barrier.promise;
        return { message: { role: "assistant", content: "done" } };
      },
    }),
    toolFactory: async () => ({
      definitions: [],
      execute: async () => ({ content: "", isError: false }),
      dispose: async () => {},
    }),
  });
  const work: Promise<unknown>[] = [];
  try {
    await harness.updateSettings({
      apiKey: "first-key",
      settings: { baseUrl: "http://127.0.0.1:1/v1", model: "fixture" },
    });
    for (const key of ["first-key", "first-key", "rotated-key"]) {
      await harness.updateSettings({ apiKey: key });
      const session = await harness.createSession({
        workspace,
        title: "Credential lifetime",
      });
      work.push(
        harness.run(
          { sessionId: session.id, prompt: "work" },
          () => {},
          async () => false,
          new AbortController().signal,
        ),
      );
      await vi.waitFor(() => expect(running.has(session.id)).toBe(true));
    }
    expect([...ownership.secrets.keys()].sort()).toEqual([
      "first-key",
      "rotated-key",
    ]);
    const gates = [...running.values()];
    gates[0]!.resolve();
    await work[0];
    expect(ownership.secrets.has("first-key")).toBe(true);
    gates[1]!.resolve();
    await work[1];
    expect(ownership.secrets.has("first-key")).toBe(false);
    expect(ownership.secrets.has("rotated-key")).toBe(true);
    gates[2]!.resolve();
    await work[2];
    expect(ownership.secrets.size).toBe(0);
  } finally {
    for (const gate of running.values()) gate.resolve();
    await harness.dispose();
    await Promise.allSettled(work);
    await rm(directory, { recursive: true, force: true });
  }
});
