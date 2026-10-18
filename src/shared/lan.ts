import { z } from "zod";

/**
 * Desktop → main-process channel for Android LAN pairing.
 *
 * This is a separate channel (not an RPC method) so the preload bridge can
 * validate both directions with one small contract, and so the renderer never
 * learns a path, token or socket detail: the host only ever answers with a
 * plain HTTP URL plus the concrete IPv4 addresses it can bind.
 */
export const LAN_CHANNEL = "forge:lan";

/** A concrete, non-unspecified IPv4 literal. Hostnames and CIDR are rejected. */
export const lanIpv4Schema = z
  .string()
  .max(15)
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
    "需要一个具体的 IPv4 地址",
  )
  .refine(value => value !== "0.0.0.0", "不能使用 0.0.0.0");

const lanPortSchema = z.number().int().min(1024).max(65535);
const lanWorkspaceSchema = z.string().min(1).max(4096);

export const lanRequestSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("status") }).strict(),
    z
      .object({
        action: z.literal("start"),
        host: lanIpv4Schema,
        port: lanPortSchema,
        workspace: lanWorkspaceSchema,
      })
      .strict(),
    z.object({ action: z.literal("stop") }).strict(),
  ])
  .readonly();
export type LanRequest = z.infer<typeof lanRequestSchema>;

/**
 * The public status DTO. `url` is a plain HTTP URL without credentials, tokens
 * or query parameters; `addresses` only ever holds concrete IPv4 literals.
 */
export const lanStatusSchema = z
  .object({
    url: z.string().url().max(2048).nullable(),
    addresses: z.array(lanIpv4Schema).max(64).readonly(),
  })
  .strict()
  .readonly();
export type LanStatus = z.infer<typeof lanStatusSchema>;

export interface LanStartInput {
  readonly host: string;
  readonly port: number;
  readonly workspace: string;
}

export interface ForgeLanBridge {
  status(): Promise<LanStatus>;
  start(input: LanStartInput): Promise<LanStatus>;
  stop(): Promise<LanStatus>;
  readonly canControl: boolean;
}

export interface LanBridgeTransport {
  request(request: LanRequest): Promise<unknown>;
}

/**
 * Builds the validated bridge used by the preload script (and by web-hosts that
 * need the same shape). Requests are validated before they reach the host and
 * responses are validated before they reach the renderer. A failed call is
 * surfaced once and never replayed: the caller must ask for `status` again.
 */
export function createForgeLanBridge(
  transport: LanBridgeTransport,
  options: { readonly canControl?: boolean } = {},
): ForgeLanBridge {
  const call = async (request: LanRequest): Promise<LanStatus> => {
    const parsed = lanRequestSchema.parse(request);
    let raw: unknown;
    try {
      raw = await transport.request(parsed);
    } catch (error) {
      if (error instanceof Error && error.message) throw new Error(error.message);
      throw new Error("局域网服务不可用，请检查状态后重试。");
    }
    const status = lanStatusSchema.safeParse(raw);
    if (!status.success) throw new Error("桌面返回的局域网状态无效。");
    return status.data;
  };
  const bridge: ForgeLanBridge = {
    canControl: options.canControl ?? true,
    status: () => call({ action: "status" }),
    start: (input: LanStartInput) =>
      call({
        action: "start",
        host: input.host,
        port: input.port,
        workspace: input.workspace,
      }),
    stop: () => call({ action: "stop" }),
  };
  return Object.freeze(bridge);
}

declare global {
  interface Window {
    readonly forgeLan?: ForgeLanBridge;
  }
}
