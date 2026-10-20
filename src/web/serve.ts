import { fileURLToPath } from "node:url";
import { createHarness } from "../core/harness";
import { createRuntimeHub } from "../host/runtime";
import { createLocalHost } from "../host/local-server";
import { validLanEndpoint } from "./lan";
import { createWebHost } from "./server";

const args = process.argv.slice(2);
function argument(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}
if (args.includes("--help")) {
  console.log("Forge Web: --host <IPv4> --port <1024..65535> --workspace <directory> [--socket <private Unix socket>]\nDefaults: host 127.0.0.1, port 5173. No password or TLS; LAN access is opt-in.");
} else {
  const host = argument("--host", "127.0.0.1")!;
  const port = Number(argument("--port", "5173"));
  const workspace = argument("--workspace");
  if (!workspace) throw new Error("Missing --workspace.");
  if (!validLanEndpoint(host, port))
    throw new Error("Use a specific IPv4 address (not 0.0.0.0) and a port between 1024 and 65535.");
  const rendererRoot = fileURLToPath(new URL("../renderer", import.meta.url));
  const runtime = createRuntimeHub(await createHarness());
  let local: Awaited<ReturnType<typeof createLocalHost>> | undefined;
  let web!: Awaited<ReturnType<typeof createWebHost>>;
  try {
    web = await createWebHost({ runtime, workspace, host, port, rendererRoot });
    const socketPath = argument("--socket");
    if (socketPath) local = await createLocalHost({ runtime, socketPath });
  } catch (error) {
    try { await web?.close(); } finally { await runtime.dispose(); }
    throw error;
  }
  const close = async () => {
    try {
      const results = await Promise.allSettled([web.close(), local?.close()]);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Host listeners did not close cleanly.");
    } finally { await runtime.dispose(); }
  };
  web.server.on("request", (request, response) => {
    void web.handle(request, response, () => {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }).catch(() => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(500); response.end("Web service unavailable"); }
    });
  });
  try {
    await new Promise<void>((done, reject) => {
      const fail = (error: Error): void => reject(error);
      web.server.once("error", fail);
      web.server.listen(port, host, () => { web.server.off("error", fail); done(); });
    });
  } catch (error) {
    await close();
    throw error;
  }
  console.log(`Forge Web: ${web.origin}`);
  console.log(`Workspace: ${web.workspace}`);
  console.log("No access password. HTTP LAN workbench; scan its address from Settings → 手机连接.");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void close().then(() => process.exit(0), () => process.exit(1));
  });
}
