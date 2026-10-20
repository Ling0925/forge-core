const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type RandomBytes = (length: number) => Uint8Array;

export const defaultRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array | undefined {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

export function randomToken(
  length: number,
  random: RandomBytes = defaultRandomBytes,
): string {
  return base64UrlEncode(random(length));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = Uint8Array.from(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
}

/** RFC 7636 S256 challenge; exported for the published test vector. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(encoder.encode(verifier)));
}

export async function generatePkce(
  random: RandomBytes = defaultRandomBytes,
): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48, random);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/**
 * Payload claims of a JWT without verifying it. These are the user's own
 * tokens and are read only for public identity and expiry, as Codex and
 * Magpie do; no claim is trusted for authorization decisions.
 */
export function decodeJwtClaims(
  token: string,
): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  const bytes = base64UrlDecode(payload);
  if (!bytes) return undefined;
  try {
    const claims = JSON.parse(decoder.decode(bytes)) as unknown;
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function claimString(
  claims: Record<string, unknown> | undefined,
  ...path: string[]
): string | undefined {
  let value: unknown = claims;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value ? value : undefined;
}

/** JWT `exp` as Unix milliseconds, absent when unreadable. */
export function jwtExpiresAt(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const exp = decodeJwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp)
    ? exp * 1000
    : undefined;
}
