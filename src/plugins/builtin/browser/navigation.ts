import { ForgeError } from "../../../shared/errors";

function hostAllowed(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const host = hostname.toLowerCase();
  return allowedDomains.some((pattern) => {
    const domain = pattern.toLowerCase();
    if (domain === "*") return true;
    if (domain.startsWith("*.")) {
      const base = domain.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === domain;
  });
}

export function assertNavigable(
  urlText: string,
  allowedDomains: readonly string[],
): void {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new ForgeError(
      "invalid_input",
      "Browser navigation requires a valid URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !hostAllowed(url.hostname, allowedDomains)
  )
    throw new ForgeError(
      "invalid_input",
      "Browser navigation requires a credential-free HTTP(S) URL on a configured allowed hostname.",
    );
}
