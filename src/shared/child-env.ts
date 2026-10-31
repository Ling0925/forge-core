export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  if (process.platform === "win32" && process.env.SYSTEMROOT)
    env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}
