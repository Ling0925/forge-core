import { join } from "node:path";
import { privateDirectory } from "./io";

export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

export async function isolateGithubCredentials(
  env: Record<string, string | undefined>,
  stateDirectory: string,
): Promise<Record<string, string | undefined>> {
  const isolated = { ...env };
  for (const name of Object.keys(isolated))
    if (/^(GH|GITHUB)_(.*_)?(TOKEN|HOST)(_|$)/.test(name))
      delete isolated[name];
  isolated.GH_CONFIG_DIR = await privateDirectory(
    join(stateDirectory, "github-isolated"),
  );
  let count = Number(isolated.GIT_CONFIG_COUNT ?? 0);
  for (const key of [
    "credential.helper",
    "credential.https://github.com.helper",
    "credential.https://gist.github.com.helper",
  ]) {
    isolated[`GIT_CONFIG_KEY_${count}`] = key;
    isolated[`GIT_CONFIG_VALUE_${count}`] = "";
    count++;
  }
  isolated.GIT_CONFIG_COUNT = String(count);
  isolated.GIT_TERMINAL_PROMPT = "0";
  return isolated;
}
