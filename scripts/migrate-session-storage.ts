import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ForgeError } from "../src/shared/errors";
import { sessionIdSchema } from "../src/shared/schemas";
import { atomicJson, privateDirectory, syncDirectory } from "../src/store/io";
import { fileLock } from "../src/store/lock";
import { openSessionStore } from "../src/store/sessions";

async function syncTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink())
    throw new ForgeError("storage", "Migration refuses symlink backups.");
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await syncTree(join(path, entry));
    await syncDirectory(path);
  } else if (info.isFile()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else
    throw new ForgeError(
      "storage",
      "Migration refuses special backup entries.",
    );
}

/** Run with hosts stopped. Locks exclude concurrent CLI writers; originals and
 * settings are durably backed up before any session checkpoint is replaced. */
export async function migrateSessionStorage(home: string) {
  const root = await realpath(home);
  const store = await openSessionStore(root);
  const folder = join(root, "sessions");
  const ids = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    const id = sessionIdSchema.safeParse(entry.name.slice(0, -5));
    if (id.success) {
      if (!entry.isFile())
        throw new ForgeError(
          "storage",
          "Migration requires regular session files.",
        );
      ids.push(id.data);
    }
  }
  const releases: (() => Promise<void>)[] = [];
  try {
    releases.push(await fileLock(join(root, "settings", "state.lock")));
    for (const id of ids) releases.push(await store.acquire(id));
    const snapshots = [];
    for (const id of ids) {
      const snapshot = await store.get(id);
      if (["running", "awaiting_approval"].includes(snapshot.status))
        throw new ForgeError(
          "busy",
          "Stop active runs before migrating storage.",
        );
      snapshots.push(snapshot);
    }
    const backups = await privateDirectory(
      join(root, "storage-migration-backups"),
    );
    const backup = await privateDirectory(join(backups, randomUUID()));
    for (const name of ["sessions", "settings"]) {
      await syncTree(join(root, name));
      await cp(join(root, name), join(backup, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
    await syncTree(backup);
    await syncDirectory(backups);
    for (const snapshot of snapshots) {
      await store.save(snapshot);
      if (
        JSON.stringify(await store.get(snapshot.id)) !==
        JSON.stringify(snapshot)
      )
        throw new ForgeError(
          "storage",
          "Migration verification failed; original backup retained.",
        );
    }
    const listed = await store.list();
    if (listed.length !== snapshots.length)
      throw new ForgeError(
        "storage",
        "Migration summary verification failed; original backup retained.",
      );
    await atomicJson(join(backup, "migration.json"), {
      version: 1,
      completedAt: new Date().toISOString(),
      sessions: snapshots.length,
      settingsUnchanged: true,
    });
    return { sessions: snapshots.length, backup, settingsUnchanged: true };
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--home");
  const home = index >= 0 ? args[index + 1] : undefined;
  if (!home || !args.includes("--apply"))
    throw new Error("Use --home PATH --apply after stopping hosts.");
  console.log(JSON.stringify(await migrateSessionStorage(home)));
}
