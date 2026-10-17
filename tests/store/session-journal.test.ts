import { randomUUID } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type SessionSnapshot, parseSessionId } from "../../src/shared/schemas";
import * as io from "../../src/store/io";
import { openSessionStore } from "../../src/store/sessions";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "forge-journal-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const create = async () => {
  const store = await openSessionStore(directory);
  return {
    store,
    initial: await store.create({
      workspace: directory,
      title: "original",
      model: "fixture",
    }),
  };
};

it("appends only deltas, reopens from disk and lists summaries without loading bodies", async () => {
  const { store, initial } = await create();
  const path = join(directory, "sessions", `${initial.id}.json`);
  const before = await readFile(path, "utf8");
  let snapshot = initial;
  for (let index = 0; index < 12; index++) {
    snapshot = {
      ...snapshot,
      title: `turn ${index}`,
      messages: [
        ...snapshot.messages,
        { role: "user", content: `request ${index}` },
        { role: "assistant", content: "answer".repeat(1000) },
      ],
    };
    await store.save(snapshot);
  }
  expect(await readFile(path, "utf8")).toBe(before);
  const reopened = await openSessionStore(directory);
  expect(await reopened.get(initial.id)).toEqual(snapshot);
  const read = vi.spyOn(io, "readJson");
  expect((await (await openSessionStore(directory)).list())[0]?.title).toBe(
    "turn 11",
  );
  expect(read.mock.calls.every(([path]) => path.includes("/summaries/"))).toBe(
    true,
  );
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("checkpoints atomically and ignores incomplete uncommitted records", async () => {
  const { store, initial } = await create();
  let snapshot = initial;
  for (let index = 0; index < 67; index++) {
    snapshot = {
      ...snapshot,
      title: `save ${index}`,
      messages: [
        ...snapshot.messages,
        { role: "user", content: String(index) },
      ],
    };
    await store.save(snapshot);
  }
  const folder = join(directory, "sessions");
  expect(
    (await readdir(folder)).filter((name) => name.endsWith(".journal")).length,
  ).toBeGreaterThan(1);
  for (const name of (await readdir(folder)).filter((name) =>
    name.endsWith(".journal"),
  ))
    await writeFile(join(folder, name, "uncommitted.tmp"), "{", {
      mode: 0o600,
    });
  const reopened = await openSessionStore(directory);
  expect(await reopened.get(initial.id)).toEqual(snapshot);
  await reopened.save({ ...snapshot, title: "after recovery" });
  expect((await store.get(initial.id)).title).toBe("after recovery");
  expect((await store.list())[0]?.title).toBe("after recovery");
});

it("migrates legacy summaries lazily and isolates invalid, corrupt and symlink records", async () => {
  const { initial } = await create();
  const folder = join(directory, "sessions");
  await rm(join(folder, "summaries", `${initial.id}.json`));
  const damaged = parseSessionId(randomUUID());
  await writeFile(join(folder, `${damaged}.json`), "{", { mode: 0o600 });
  await writeFile(join(folder, "not-a-session.json"), "{", { mode: 0o600 });
  await symlink(
    join(folder, `${initial.id}.json`),
    join(folder, `${randomUUID()}.json`),
  );
  const reopened = await openSessionStore(directory);
  expect((await reopened.list()).map((item) => item.id)).toEqual([initial.id]);
  await expect(reopened.get(damaged)).rejects.toMatchObject({
    code: "storage",
  });
  expect(await readFile(join(folder, `${damaged}.json`), "utf8")).toBe("{");
  await writeFile(
    join(folder, `${initial.id}.json`),
    JSON.stringify({ ...initial, title: "externally changed" }),
  );
  expect((await reopened.list())[0]?.title).toBe("externally changed");
});

it("retains native tool pairs and rejects corrupt committed deltas", async () => {
  const { store, initial } = await create();
  const snapshot: SessionSnapshot = {
    ...initial,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call", content: "result" },
    ],
  };
  await store.save(snapshot);
  expect(await (await openSessionStore(directory)).get(initial.id)).toEqual(
    snapshot,
  );
  const folder = join(directory, "sessions");
  const generation = (await readdir(folder)).find((name) =>
    name.endsWith(".journal"),
  );
  if (!generation) throw new Error("Missing committed generation");
  await writeFile(join(folder, generation, "00000001.json"), "{", {
    mode: 0o600,
  });
  await expect(store.get(initial.id)).rejects.toMatchObject({
    code: "storage",
  });
});
it("publishes a complete base snapshot at run termination", async () => {
  const { store, initial } = await create();
  const running: SessionSnapshot = {
    ...initial,
    status: "running",
    messages: [{ role: "user", content: "accepted" }],
  };
  await store.save(running);
  const terminal: SessionSnapshot = {
    ...running,
    status: "completed",
    messages: [...running.messages, { role: "assistant", content: "done" }],
  };
  await store.save(terminal);
  expect(
    JSON.parse(
      await readFile(join(directory, "sessions", `${initial.id}.json`), "utf8"),
    ),
  ).toMatchObject(terminal);
  expect(await (await openSessionStore(directory)).get(initial.id)).toEqual(
    terminal,
  );
});
it("restores acknowledged deltas after a complete directory backup changes filesystem identities", async () => {
  const { store, initial } = await create();
  const current: SessionSnapshot = {
    ...initial,
    status: "running",
    messages: [{ role: "user", content: "durable request" }],
  };
  await store.save(current);
  const restored = await mkdtemp(join(tmpdir(), "forge-journal-restored-"));
  try {
    await cp(directory, restored, { recursive: true });
    const reopened = await openSessionStore(restored);
    expect(await reopened.get(initial.id)).toEqual(current);
    await reopened.save({ ...current, title: "restored and continued" });
    expect((await store.get(initial.id)).title).toBe(initial.title);
    expect((await reopened.get(initial.id)).title).toBe(
      "restored and continued",
    );
  } finally {
    await rm(restored, { recursive: true, force: true });
  }
});
