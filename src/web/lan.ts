import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { DeviceAuthorization } from "../shared/device-authorization";
import type { RuntimeHost } from "../shared/runtime-host";
import { createWebHost } from "./server";

export interface LanHostOptions {
  trustedLan?: boolean;
  authorization?: DeviceAuthorization;
  stateDir?: string;
  runtime: RuntimeHost;
  /** A concrete IPv4 literal; `0.0.0.0` is never accepted. */
  host: string;
  port: number;
  workspace: string;
  /** Packaged renderer directory, normally `dist/renderer`. */
  rendererRoot: string;
  /** Desktop hosting is multi-workspace; the standalone Web server defaults to one. */
  restrictWorkspace?: boolean;
}

/** The subset a control message may choose; runtime and renderer are host-owned. */
export type LanStartRequest = Pick<
  LanHostOptions,
  "host" | "port" | "workspace"
>;

export interface LanHost {
  readonly url: string;
  readonly workspace: string;
  close(): Promise<void>;
}

/**
 * Worker teardown: stop the LAN listener first, then always release the one
 * shared runtime. A LAN close failure must not skip the runtime disposal, but it
 * does make the shutdown unclean so the parent can report it.
 */
export async function shutdownSharedRuntime(options: {
  closeLan: () => Promise<void>;
  disposeRuntime: () => Promise<void>;
  report: (message: string) => void;
}): Promise<boolean> {
  let clean = true;
  const detail = (error: unknown): string =>
    error instanceof Error && error.message ? `: ${error.message}` : "";
  try {
    await options.closeLan();
  } catch (error) {
    clean = false;
    options.report(`The LAN host did not close cleanly${detail(error)}`);
  }
  try {
    await options.disposeRuntime();
  } catch (error) {
    clean = false;
    options.report(
      `The shared runtime did not dispose cleanly${detail(error)}`,
    );
  }
  return clean;
}

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function validLanEndpoint(host: string, port: number): boolean {
  return (
    IPV4.test(host) &&
    host !== "0.0.0.0" &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535
  );
}

/**
 * LAN hosting for one already-running shared runtime.
 *
 * The listener is only created when this is called, and it is bound to one
 * concrete IPv4 address (no `0.0.0.0`, no hostnames, no TLS; paired device authorization by default).
 * Closing the host stops accepting new pages and releases this HTTP host's
 * subscriptions, but never disposes the injected runtime: active runs keep
 * running and remain controllable from the desktop.
 *
 * The host is returned unbound so the caller can bind and observe errors;
 * `startLanServer` below is the convenience wrapper that binds immediately.
 */
export async function createLanWebHost(options: LanHostOptions) {
  if (!validLanEndpoint(options.host, options.port))
    throw new Error(
      "Use one concrete IPv4 address (not 0.0.0.0) and a port between 1024 and 65535.",
    );
  const workspace = await realpath(resolve(options.workspace));
  const web = await createWebHost({
    runtime: options.runtime,
    workspace,
    host: options.host,
    port: options.port,
    rendererRoot: options.rendererRoot,
    restrictWorkspace: options.restrictWorkspace ?? false,
    ...(options.trustedLan === undefined
      ? {}
      : { trustedLan: options.trustedLan }),
    ...(options.authorization === undefined
      ? {}
      : { authorization: options.authorization }),
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  });
  // This host owns its server: everything is answered by `handle`, and an
  // unknown path is a plain 404 rather than a hanging request. A thrown
  // handler must never surface as an unhandled rejection.
  web.server.on("request", (request, response) => {
    void web
      .handle(request, response, () => {
        if (response.headersSent) return;
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Not found");
      })
      .catch(() => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Web service unavailable");
      });
  });
  return web;
}

/**
 * Serializes start/stop so concurrent desktop IPC requests cannot interleave a
 * half-bound listener with a teardown. Operations run in submission order; a
 * close failure is reported and rethrown rather than being reported as success.
 */
export function createLanHostController(options: {
  start: (input: LanStartRequest) => Promise<LanHost>;
  report: (message: string) => void;
}) {
  let current: LanHost | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  /** Closes `host`, always reporting and propagating a failure. */
  const closeHost = async (host: LanHost): Promise<void> => {
    try {
      await host.close();
    } catch (error) {
      const detail =
        error instanceof Error && error.message ? `: ${error.message}` : "";
      options.report(`LAN host did not close cleanly${detail}`);
      throw error;
    }
  };
  return {
    /** Starts (or replaces) the listener and resolves with its origin URL. */
    start(input: LanStartRequest): Promise<string> {
      return enqueue(async () => {
        if (disposed) throw new Error("The LAN host is closed.");
        const previous = current;
        current = undefined;
        // No `catch`: a listener that will not close must fail this operation.
        if (previous) await closeHost(previous);
        const created = await options.start(input);
        if (disposed) {
          await closeHost(created);
          throw new Error("The LAN host is closed.");
        }
        current = created;
        return created.url;
      });
    },
    stop(): Promise<null> {
      return enqueue(async () => {
        const previous = current;
        current = undefined;
        if (previous) await closeHost(previous);
        return null;
      });
    },
    /** Final close: stop the listener; never touches the shared runtime. */
    dispose(): Promise<void> {
      disposed = true;
      const previous = current;
      current = undefined;
      return enqueue(async () => {
        if (previous) await closeHost(previous);
      }).then(() => undefined);
    },
    status(): {
      readonly url: string | null;
      readonly workspace: string | null;
    } {
      return {
        url: current?.url ?? null,
        workspace: current?.workspace ?? null,
      };
    },
  };
}

/**
 * One-call LAN server: binds immediately, uses the shared runtime, and serves
 * the packaged renderer from `dist/renderer`.
 *
 * If binding fails the partially built Web host is closed before the error is
 * rethrown, so timers, subscriptions and sockets cannot leak from a failed
 * start.
 */
export async function startLanServer(
  options: LanHostOptions,
): Promise<LanHost & { readonly origin: string }> {
  // Renderer resolution and host construction can also throw; nothing exists
  // to clean up before `createLanWebHost` resolves.
  const web = await createLanWebHost(options);
  try {
    await new Promise<void>((done, reject) => {
      const fail = (error: Error): void => {
        web.server.off("error", fail);
        reject(error);
      };
      web.server.once("error", fail);
      web.server.listen(options.port, options.host, () => {
        web.server.off("error", fail);
        done();
      });
    });
  } catch (error) {
    try {
      await web.close();
    } catch (closeError) {
      // Never claim a clean failure: surface both the bind error and the
      // incomplete close so a leaked socket stays visible to the caller.
      throw new AggregateError(
        [error, closeError],
        "LAN host failed to bind and did not close cleanly.",
      );
    }
    throw error;
  }
  return {
    url: web.origin,
    workspace: web.workspace,
    origin: web.origin,
    close: () => web.close(),
  };
}
