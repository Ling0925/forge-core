import { vi } from "vitest";
// Run the exact protocol/control cases over a deterministic in-memory duplex.
// Keep local-host.test.ts separate: only that suite validates real Unix sockets.
vi.mock("node:net", async () => import("./memory-net"));
vi.mock("../../src/host/socket-path", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/host/socket-path")>();
  const memory = await import("./memory-net");
  return {
    ...actual,
    verifyLocalSocket: async (path: string) => memory.verifyMemorySocket(path),
  };
});
import { registerLocalHostTests } from "./local-host-cases";
registerLocalHostTests();
