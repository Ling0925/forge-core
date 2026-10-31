import { pathToFileURL } from "node:url";
import { StdioLspClient } from "./lsp-client";

export interface LspServerConfig {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly extensions: readonly string[];
}

export class LspCleanupError extends Error {
  constructor() {
    super("LSP process cleanup failed; execution stopped.");
  }
}

interface Document {
  text: string;
  stamp: { size: number; mtimeMs: number; ino: number };
}

interface Server {
  workspace: string;
  identity: string;
  client: StdioLspClient;
  ready: Promise<void>;
  documents: Map<string, Document & { version: number; uses: number }>;
}

const identity = (config: LspServerConfig) =>
  JSON.stringify([config.id, config.command, config.args, config.extensions]);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class LspServerPool {
  private servers = new Map<string, Server>();
  private cleanups = new Set<Promise<void>>();
  private disposal: Promise<void> | undefined;

  private remove(
    key: string,
    client: StdioLspClient,
    reason?: Error,
  ): Promise<void> {
    if (this.servers.get(key)?.client === client) this.servers.delete(key);
    const cleanup = client.dispose(reason);
    this.cleanups.add(cleanup);
    // Keep failed cleanup for pool disposal, including failures while idle.
    void cleanup.then(
      () => this.cleanups.delete(cleanup),
      () => undefined,
    );
    return cleanup;
  }

  async reconcile(
    workspace: string,
    configs: readonly LspServerConfig[],
  ): Promise<void> {
    const identities = new Set(configs.map(identity));
    await Promise.all(
      [...this.servers].map(([key, server]) => {
        if (server.workspace === workspace && !identities.has(server.identity))
          return this.remove(key, server.client);
        return undefined;
      }),
    );
  }

  async request(
    workspace: string,
    config: LspServerConfig,
    document: Document & { absolute: string; languageId: string },
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw new Error("LSP invocation cancelled.");
    if (this.disposal) throw new Error("LSP client disposed.");
    const configIdentity = identity(config);
    const key = JSON.stringify([workspace, configIdentity]);
    let server = this.servers.get(key);
    if (!server) {
      const client = new StdioLspClient({
        command: config.command,
        args: config.args,
        cwd: workspace,
        onFailure: () => {
          void this.remove(key, client);
        },
      });
      // Initialization outlives any individual caller's cancellation.
      const ready = client
        .invoke(new AbortController().signal, async (request) => {
          client.start();
          const rootUri = pathToFileURL(workspace).href;
          const initialized = await request("initialize", {
            processId: null,
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: "workspace" }],
            capabilities: {
              general: { positionEncodings: ["utf-16"] },
              workspace: { applyEdit: false },
              textDocument: {
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              },
            },
          });
          if (!object(initialized) || !object(initialized.capabilities))
            throw new Error("Invalid LSP initialize result.");
          if (
            initialized.capabilities.positionEncoding !== undefined &&
            initialized.capabilities.positionEncoding !== "utf-16"
          )
            throw new Error("LSP server must use UTF-16 positions.");
          client.notify("initialized", {});
        })
        .catch(async (error) => {
          try {
            await this.remove(key, client, error);
          } catch {
            throw new LspCleanupError();
          }
          throw error;
        });
      server = {
        workspace,
        identity: configIdentity,
        client,
        ready,
        documents: new Map(),
      };
      this.servers.set(key, server);
    }
    const { client, ready, documents } = server;
    try {
      return await client.invoke(signal, async (request) => {
        await ready;
        if (signal.aborted) throw new Error("LSP invocation cancelled.");
        const uri = pathToFileURL(document.absolute).href;
        let opened = documents.get(uri);
        if (!opened) {
          client.notify("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: document.languageId,
              version: 1,
              text: document.text,
            },
          });
          opened = {
            text: document.text,
            stamp: document.stamp,
            version: 1,
            uses: 0,
          };
          documents.set(uri, opened);
        } else if (
          opened.text !== document.text ||
          opened.stamp.size !== document.stamp.size ||
          opened.stamp.mtimeMs !== document.stamp.mtimeMs ||
          opened.stamp.ino !== document.stamp.ino
        ) {
          const version = opened.version + 1;
          client.notify("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text: document.text }],
          });
          opened.text = document.text;
          opened.stamp = document.stamp;
          opened.version = version;
        }
        opened.uses++;
        try {
          return await request(method, { textDocument: { uri }, ...params });
        } finally {
          opened.uses--;
          if (opened.uses === 0) {
            documents.delete(uri);
            client.closeDocument(uri);
          }
        }
      });
    } catch (error) {
      try {
        await client.joinFailure();
      } catch {
        throw new LspCleanupError();
      }
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      for (const [key, server] of this.servers) this.remove(key, server.client);
      this.disposal = Promise.allSettled(this.cleanups).then((results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      });
    }
    return this.disposal;
  }
}
