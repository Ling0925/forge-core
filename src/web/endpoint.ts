import { isIPv6 } from "node:net";

// Strict dotted-quad: URL parsing would accept short/octal forms.
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Canonical bare form of a concrete IP literal, or undefined.
 *
 * IPv4 must be a strict dotted quad. IPv6 may be bracketed (`[::1]`) and is
 * returned in the compressed lowercase form browsers send in Host/Origin, so
 * header checks compare equal. Zone IDs (`fe80::1%en0`) are refused because
 * browsers do not send them in Host headers. Hostnames are never accepted.
 */
export function canonicalIpHost(host: string): string | undefined {
  if (IPV4.test(host)) return host;
  const bare =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes("%") || !isIPv6(bare)) return undefined;
  return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
}

const unspecified = (host: string) => host === "0.0.0.0" || host === "::";

/** A concrete (not wildcard) IPv4/IPv6 literal and an unprivileged port. */
export function validListenEndpoint(host: string, port: number): boolean {
  const canonical = canonicalIpHost(host);
  return (
    canonical !== undefined &&
    !unspecified(canonical) &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535
  );
}

/** `host:port` as sent in a Host header; IPv6 literals are bracketed. */
export function hostAuthority(host: string, port: number): string {
  const canonical = canonicalIpHost(host) ?? host;
  return `${canonical.includes(":") ? `[${canonical}]` : canonical}:${port}`;
}

export function isLoopbackIp(host: string): boolean {
  const canonical = canonicalIpHost(host);
  return (
    canonical !== undefined &&
    ((canonical.startsWith("127.") && IPV4.test(canonical)) ||
      canonical === "::1")
  );
}

export const ENDPOINT_REQUIREMENT =
  "Use one concrete IPv4 or IPv6 address (not 0.0.0.0 or ::) and a port between 1024 and 65535.";
