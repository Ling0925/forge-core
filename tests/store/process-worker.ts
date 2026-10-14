import { parseSessionId } from "../../src/shared/schemas";
import { openSessionStore } from "../../src/store/sessions";
import { openSettingsStore } from "../../src/store/settings";
const [directory, mode, value] = process.argv.slice(2);
if (!directory || !mode || !value) throw new Error("Missing test arguments");
if (mode === "session") {
  const store = await openSessionStore(directory);
  const release = await store.acquire(parseSessionId(value));
  process.stdout.write("ready\n");
  process.stdin.resume();
  process.stdin.once("data", async () => {
    await release();
    process.exit(0);
  });
} else {
  const store = await openSettingsStore(directory);
  await store.update({
    settings: mode === "theme" ? { theme: "dark" } : { model: value },
  });
}
