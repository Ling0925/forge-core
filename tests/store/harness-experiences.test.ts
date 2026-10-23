import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ForgeError } from "../../src/shared/errors";
import type {
  HarnessExperience,
  HarnessExperienceInput,
  HarnessExperienceScope,
} from "../../src/shared/harness-adaptation";
import {
  MAX_HARNESS_EXPERIENCES,
  MAX_HARNESS_EXPERIENCE_BYTES,
  openHarnessExperienceStore,
} from "../../src/store/harness-experiences";

let home = "";
let workspace = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "forge-experience-home-"));
  workspace = await mkdtemp(join(tmpdir(), "forge-experience-workspace-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

const directory = () => join(home, "harness-experiences");
/** Mirrors the store key so tests can corrupt/replace one exact scope file. */
const pathFor = (scope: HarnessExperienceScope) =>
  join(
    directory(),
    `${createHash("sha256")
      .update(
        JSON.stringify([resolve(scope.workspace), scope.model, scope.domain]),
      )
      .digest("hex")}.json`,
  );
const scopeFor = (overrides: Partial<HarnessExperienceScope> = {}) =>
  ({
    workspace,
    model: "fixture-model",
    domain: "general",
    ...overrides,
  }) satisfies HarnessExperienceScope;
const inputFor = (
  scope: HarnessExperienceScope,
  reportId = randomUUID(),
  lesson = "Prefer a focused failing test before editing.",
): HarnessExperienceInput => ({
  scope,
  sessionId: randomUUID(),
  reportId,
  strategy: {
    planning: "Plan in one short pass.",
    toolGuidance: "Read before editing.",
    verification: "Run the focused test.",
  },
  lesson,
  evidence: ["turn 1: read_file src/store/io.ts"],
});

const isStorageFailure = (error: unknown) =>
  error instanceof ForgeError && error.code === "storage";

it("reopens persisted experiences in recent-first order", async () => {
  const scope = scopeFor();
  const store = await openHarnessExperienceStore(home);
  const saved: HarnessExperience[] = [];
  for (let index = 0; index < 3; index++)
    saved.push(await store.save(inputFor(scope, undefined, `lesson ${index}`)));
  expect(saved.map((entry) => entry.lesson)).toEqual([
    "lesson 0",
    "lesson 1",
    "lesson 2",
  ]);

  const reopened = await openHarnessExperienceStore(home);
  expect(await reopened.list(scope)).toEqual([...saved].reverse());
  expect((await reopened.list(scope))[0]).toEqual(saved[2]);
});

it("isolates exact workspace, model and domain scopes", async () => {
  const other = await mkdtemp(join(tmpdir(), "forge-experience-other-"));
  try {
    const store = await openHarnessExperienceStore(home);
    const general = scopeFor();
    const otherWorkspace = scopeFor({ workspace: other });
    const otherModel = scopeFor({ model: "second-model" });
    const otherDomain = scopeFor({ domain: "typescript" });
    const generalEntry = await store.save(inputFor(general));
    await store.save(inputFor(otherWorkspace));
    await store.save(inputFor(otherModel));
    await store.save(inputFor(otherDomain));

    expect((await store.list(general)).map((entry) => entry.id)).toEqual([
      generalEntry.id,
    ]);
    // Trailing separators resolve to the same canonical workspace key.
    const alias = scopeFor({ workspace: `${workspace}/` });
    expect(await store.list(alias)).toEqual([generalEntry]);
    expect(
      (await store.list(scopeFor({ domain: "typescript" })))[0]?.scope,
    ).toEqual(otherDomain);
    const names = (await readdir(directory())).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names).toHaveLength(4);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

it("deduplicates reportId and keeps concurrent saves without loss", async () => {
  const scope = scopeFor();
  const first = await openHarnessExperienceStore(home);
  const second = await openHarnessExperienceStore(home);
  const reportId = randomUUID();
  const original = inputFor(scope, reportId);
  const [left, right] = await Promise.all([
    first.save(original),
    second.save(original),
  ]);
  expect(left.id).toBe(right.id);
  expect(await first.list(scope)).toEqual([left]);

  const duplicate = await second.save(
    inputFor(scope, reportId, "other lesson"),
  );
  expect(duplicate).toEqual(left);

  const results = await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      (index % 2 === 0 ? first : second).save(
        inputFor(scope, undefined, `concurrent ${index}`),
      ),
    ),
  );
  const reopened = await openHarnessExperienceStore(home);
  const stored = await reopened.list(scope);
  const file = JSON.parse(await readFile(pathFor(scope), "utf8")) as {
    entries: HarnessExperience[];
  };
  expect(file.entries).toHaveLength(41);
  expect(new Set(file.entries.map((entry) => entry.reportId)).size).toBe(41);
  expect(
    results.every((entry) =>
      file.entries.some((retained) => retained.id === entry.id),
    ),
  ).toBe(true);
  // Concurrent saves interleave by lock acquisition, but every save is
  // retained and list returns exactly the newest four stored entries.
  expect(stored).toHaveLength(4);
  expect(stored).toEqual(file.entries.slice(-4).reverse());
  expect(new Set(stored.map((entry) => entry.reportId)).size).toBe(4);
  expect(file.entries.some((entry) => entry.lesson === "concurrent 39")).toBe(
    true,
  );
});

it("retains at most 64 entries per scope, evicting oldest first", async () => {
  const scope = scopeFor();
  const store = await openHarnessExperienceStore(home);
  const ids: string[] = [];
  for (let index = 0; index < MAX_HARNESS_EXPERIENCES + 6; index++)
    ids.push(
      (await store.save(inputFor(scope, undefined, `entry ${index}`))).id,
    );

  const file = JSON.parse(await readFile(pathFor(scope), "utf8")) as {
    version: number;
    entries: HarnessExperience[];
  };
  expect(file.version).toBe(1);
  expect(file.entries).toHaveLength(MAX_HARNESS_EXPERIENCES);
  expect(file.entries.map((entry) => entry.id)).toEqual(ids.slice(-64));
  expect(await store.list(scope)).toEqual(file.entries.slice(-4).reverse());
  for (const entry of file.entries) expect(entry.scope).toEqual(scope);
});

it("enforces the 2 MiB file bound by evicting oldest entries", async () => {
  const scope = scopeFor();
  const store = await openHarnessExperienceStore(home);
  const wide = "验".repeat(2048);
  const big = (index: number): HarnessExperienceInput => ({
    ...inputFor(scope, undefined, `large ${index}`),
    strategy: {
      planning: wide,
      toolGuidance: wide,
      verification: wide,
    },
    evidence: [wide, wide, wide, wide],
  });
  for (let index = 0; index < MAX_HARNESS_EXPERIENCES; index++)
    await store.save(big(index));

  const path = pathFor(scope);
  const bytes = (await readFile(path)).byteLength;
  expect(bytes).toBeLessThanOrEqual(MAX_HARNESS_EXPERIENCE_BYTES);
  const file = JSON.parse(await readFile(path, "utf8")) as {
    entries: HarnessExperience[];
  };
  expect(file.entries.length).toBeGreaterThan(0);
  expect(file.entries.length).toBeLessThan(MAX_HARNESS_EXPERIENCES);
  expect(file.entries.at(-1)?.lesson.endsWith("63")).toBe(true);
  expect(await store.list(scope)).toEqual(file.entries.slice(-4).reverse());
});

it("fails closed on corrupt, oversized, foreign-scope or non-strict files", async () => {
  const scope = scopeFor();
  const store = await openHarnessExperienceStore(home);
  const entry = await store.save(inputFor(scope));
  const path = pathFor(scope);
  const original = await readFile(path, "utf8");

  const variants = [
    "{not json",
    JSON.stringify({ version: 1, scope, entries: [entry], extra: true }),
    JSON.stringify({
      version: 1,
      scope: scopeFor({ model: "other" }),
      entries: [entry],
    }),
    JSON.stringify({ version: 1, scope, entries: [entry, entry] }),
    JSON.stringify({ version: 1, scope, entries: Array(65).fill(entry) }),
    `{"version":1,"scope":${JSON.stringify(scope)},"entries":[]}${" ".repeat(
      2 * 1024 * 1024,
    )}`,
  ];
  for (const variant of variants) {
    await writeFile(path, variant, "utf8");
    await chmod(path, 0o600);
    await expect(store.list(scope)).rejects.toSatisfy(isStorageFailure);
    await expect(store.save(inputFor(scope))).rejects.toSatisfy(
      isStorageFailure,
    );
    // Failures never silently reset the record.
    expect(await readFile(path, "utf8")).toBe(variant);
  }

  await writeFile(path, original, "utf8");
  await chmod(path, 0o600);
  expect(await store.list(scope)).toEqual([entry]);
});

it("rejects symlinked records and directories without writing through them", async () => {
  const scope = scopeFor();
  const store = await openHarnessExperienceStore(home);
  const entry = await store.save(inputFor(scope));
  const path = pathFor(scope);
  const target = join(home, "target.json");
  await writeFile(
    target,
    JSON.stringify({ version: 1, scope, entries: [entry] }),
    "utf8",
  );
  await chmod(target, 0o600);
  await rm(path);
  await symlink(target, path);

  await expect(store.list(scope)).rejects.toSatisfy(isStorageFailure);
  await expect(store.save(inputFor(scope))).rejects.toSatisfy(isStorageFailure);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
    version: 1,
    scope,
    entries: [entry],
  });

  const moved = join(home, "moved-experiences");
  await rm(path);
  await mkdir(moved, { recursive: true, mode: 0o700 });
  await rm(directory(), { recursive: true, force: true });
  await symlink(moved, directory());
  await expect(store.list(scope)).rejects.toSatisfy(isStorageFailure);
  await expect(store.save(inputFor(scope))).rejects.toSatisfy(isStorageFailure);
  expect(await readdir(moved)).toEqual([]);
});
