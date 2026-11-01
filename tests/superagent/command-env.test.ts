import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sessionIdSchema } from "../../src/shared";
import { call, fixture } from "./fixture";

it("isolates Worker foreground and background descendants while keeping Router and ordinary commands unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-worker-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("GH_TOKEN", "fixture-host-gh-token");
  vi.stubEnv("GITHUB_TOKEN", "fixture-host-github-token");
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "fixture-host-enterprise-token");
  vi.stubEnv("GH_HOST", "github.example.invalid");
  await mkdir(join(home, ".config/gh"), { recursive: true });
  await writeFile(
    join(home, ".config/gh/hosts.yml"),
    "github.com:\n  user: fixture-user\n  oauth_token: fixture-config-token\n",
  );
  const marker = join(home, "helper-calls");
  const gh = join(home, "gh");
  await writeFile(
    gh,
    `#!/bin/sh\nprintf 'called\\n' >> '${marker}'\nprintf 'username=fixture\\npassword=fixture-password\\n'\n`,
    { mode: 0o700 },
  );
  const helper = `!${gh} auth git-credential`;
  await writeFile(
    join(home, ".gitconfig"),
    `[user]\nname = Fixture User\nemail = fixture@example.invalid\n[core]\neditor = fixture-editor\n[credential]\nhelper = ${helper}\n[credential "https://github.com"]\nhelper = ${helper}\n[credential "https://gist.github.com"]\nhelper = ${helper}\n`,
  );
  const f = await fixture({ localTools: true, approve: true });
  try {
    const work = await f.createWork();
    const worker = sessionIdSchema.parse(work.workerSessionId);
    const router = (await f.router()).id;
    const ordinary = await f.harness.createSession({ workspace: f.workspace });
    for (const [id, workspace, isolated] of [
      [worker, work.worktree!, true],
      [router, f.workspace, false],
      [ordinary.id, f.workspace, false],
    ] as const) {
      if (id !== worker)
        await f.inputQueue.notify(
          {
            inputId: randomUUID(),
            input: { sessionId: id, prompt: "Inspect commands" },
          },
          "superagent",
        );
      const steps = [false, true].map((background) => {
        const file = `credentials-${id}-${background}.json`;
        const code = `
          const { spawnSync } = require('node:child_process');
          const { writeFileSync } = require('node:fs');
          const git = (args, input) => {
            const { status, stdout, stderr } = spawnSync('git', args, { input, encoding: 'utf8' });
            return { status, stdout, stderr };
          };
          const descendant = spawnSync(process.execPath,
            ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { encoding: 'utf8' });
          writeFileSync(${JSON.stringify(file)}, JSON.stringify({
            env: process.env,
            descendant: JSON.parse(descendant.stdout),
            helpers: git(['config', '--get-all', 'credential.helper']),
            githubHelpers: git(['config', '--get-all', 'credential.https://github.com.helper']),
            gistHelpers: git(['config', '--get-all', 'credential.https://gist.github.com.helper']),
            github: git(['credential', 'fill'], 'protocol=https\\nhost=github.com\\n\\n'),
            gist: git(['credential', 'fill'], 'protocol=https\\nhost=gist.github.com\\n\\n'),
            name: git(['config', 'user.name']),
            email: git(['config', 'user.email']),
            editor: git(['config', 'core.editor'])
          }));
        `;
        return call("run_command", {
          argv: [process.execPath, "-e", code],
          timeout_ms: 5000,
          background,
        });
      });
      const completed = await f.runNext(id, steps);
      expect(completed.status).toBe("completed");
      for (const background of [false, true]) {
        const observed = JSON.parse(
          await readFile(
            join(workspace, `credentials-${id}-${background}.json`),
            "utf8",
          ),
        );
        for (const env of [observed.env, observed.descendant]) {
          expect(env.HOME).toBe(home);
          expect(env).not.toHaveProperty("GIT_CONFIG_GLOBAL");
          for (const name of [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GH_HOST",
          ])
            expect(env).not.toHaveProperty(name);
          if (isolated) {
            expect(env.GH_CONFIG_DIR).toBe(
              join(f.directory, "state/github-isolated"),
            );
            expect(await readdir(env.GH_CONFIG_DIR)).toEqual([]);
            expect((await stat(env.GH_CONFIG_DIR)).mode & 0o777).toBe(0o700);
            expect(env.GIT_TERMINAL_PROMPT).toBe("0");
          } else {
            expect(env).not.toHaveProperty("GH_CONFIG_DIR");
            expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
            expect(env).not.toHaveProperty("GIT_TERMINAL_PROMPT");
          }
        }
        for (const key of ["helpers", "githubHelpers", "gistHelpers"])
          expect(observed[key].stdout).toBe(
            `${helper}\n${isolated ? "\n" : ""}`,
          );
        for (const host of ["github", "gist"]) {
          expect(observed[host].status).toBe(isolated ? 128 : 0);
          if (isolated) expect(observed[host].stdout).toBe("");
          else
            expect(observed[host].stdout).toContain(
              "password=fixture-password",
            );
        }
        expect(observed.name.stdout).toBe("Fixture User\n");
        expect(observed.email.stdout).toBe("fixture@example.invalid\n");
        expect(observed.editor.stdout).toBe("fixture-editor\n");
      }
      if (isolated)
        await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(marker, "utf8")).toContain("called");
    }
    expect(process.env.GH_TOKEN).toBe("fixture-host-gh-token");
    expect(process.env.GITHUB_TOKEN).toBe("fixture-host-github-token");
    expect(process.env).not.toHaveProperty("GIT_CONFIG_KEY_0");
  } finally {
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
