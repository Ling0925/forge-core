import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../src/shared/schemas";
import * as io from "../../src/store/io";
import { openSessionStore } from "../../src/store/sessions";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
for (const method of ["read", "changesSince"] as const) {
  it.each(["append", "checkpoint", "temporary"] as const)(
    `${method} returns a valid prefix during %s without granting stale CAS writes`,
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "forge-port-race-"));
      directories.push(directory);
      const writer = await openSessionStore(directory);
      const initial = await writer.create({
        workspace: directory,
        title: "original",
        model: "fixture",
      });
      const snapshot = {
        ...initial,
        status: "running" as const,
        messages: [{ role: "user" as const, content: "accepted" }],
      };
      await writer.save(snapshot);
      const writerPort = writer.incremental;
      if (!writerPort) throw new Error("Missing writer port");
      const base = await writerPort.read(initial.id);
      const reader = await openSessionStore(directory);
      const readerPort = reader.incremental;
      if (!readerPort) throw new Error("Missing reader port");
      let latest: SessionSnapshot = snapshot;
      let races = 0;
      const readJson = io.readJson;
      const spy = vi
        .spyOn(io, "readJson")
        .mockImplementation(async (path, limit) => {
          const raw = await readJson(path, limit);
          if (path.endsWith("/00000001.json")) {
            races++;
            if (kind === "temporary")
              await writeFile(
                join(dirname(path), `pending-${races}.tmp`),
                "{",
                { mode: 0o600 },
              );
            else {
              latest = {
                ...snapshot,
                title: "new head",
                status: kind === "checkpoint" ? "completed" : "running",
              };
              await writer.save(latest);
            }
          }
          return raw;
        });
      const read =
        method === "read"
          ? await readerPort.read(initial.id)
          : await readerPort.changesSince(initial.id, base.revision);
      expect(races).toBe(1);
      expect(read.revision).toBe(base.revision);
      if ("snapshot" in read) expect(read.snapshot).toEqual(snapshot);
      else expect(read.changes).toEqual([]);
      spy.mockRestore();
      expect(await reader.get(initial.id)).toEqual(latest);
      const { messages, events, changes, ...metadata } = snapshot;
      const mutation = {
        baseRevision: read.revision,
        metadata: { ...metadata, title: "old reader write" },
        messages: { keep: messages.length, append: [] },
        events: { keep: events.length, append: [] },
        changes: { keep: changes.length, append: [] },
      };
      if (kind !== "temporary")
        await expect(
          readerPort.commit(initial.id, mutation),
        ).rejects.toMatchObject({ code: "busy" });
      else
        expect(
          (await readerPort.commit(initial.id, mutation)).snapshot.title,
        ).toBe("old reader write");
    },
  );
}
