import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError } from "../../../shared/errors";
import {
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserPluginConfig,
  browserPluginConfigSchema,
} from "../../../shared/plugins";
import { cliFor, createLayout, exists } from "./cli-layout";
import { createLifecycle } from "./lifecycle";
import { Session } from "./session";
import { createTools } from "./tools";

export interface AgentBrowserBackend {
  execute(
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult>;
  check(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export async function createAgentBrowserBackend(
  configInput: BrowserPluginConfig,
  options: { home: string; redactValues?: readonly string[] },
): Promise<AgentBrowserBackend> {
  // Re-parse the shared contract so a caller cannot smuggle extra keys past
  // the host's config parser.
  const config = browserPluginConfigSchema.parse(configInput);
  const layout = await createLayout(options.home);
  try {
    const cli = cliFor(config);
    if (cli.prefix.length && !(await exists(cli.prefix[0] ?? "")))
      throw new ForgeError(
        "tool",
        "The pinned agent-browser CLI entry was not found in this package.",
      );
    const secrets = options.redactValues ?? [];
    const allowedDomains = [...config.allowedDomains];
    const session = new Session(config, layout, cli, secrets);
    const lifecycle = createLifecycle(session, cli);
    const tools = createTools(session, lifecycle, allowedDomains);
    const backend: AgentBrowserBackend = {
      execute: tools.execute,
      check: tools.check,
      dispose: lifecycle.dispose,
    };
    // Fail construction early if the private HOME is unusable, so a broken
    // sandbox never reports a ready backend.
    await writeFile(join(layout.home, ".keep"), "", { mode: 0o600 });
    return backend;
  } catch (error) {
    await rm(layout.root, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (layout.socketRoot)
      await rm(layout.socketRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    if (layout.tmpRoot)
      await rm(layout.tmpRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      "tool",
      "Could not create the isolated agent-browser backend.",
    );
  }
}
