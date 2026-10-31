export function isSensitivePath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (part) =>
        /^(?:\.env.*|\.ssh|\.config|\.git|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(
          part,
        ) ||
        /credentials/i.test(part) ||
        /\.(?:pem|key|p12|pfx)$/i.test(part),
    );
}

export function containsSensitiveText(text: string): boolean {
  return (
    /^\s*-----BEGIN [A-Z ]*PRIVATE KEY-----/m.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/.test(
      text,
    ) ||
    /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*(?:[A-Za-z0-9_-]{8,}|"[A-Za-z0-9_-]{8,}"|'[A-Za-z0-9_-]{8,}')\s*$/im.test(
      text,
    )
  );
}

/** Known credentials and common secret shapes only; not arbitrary-secret detection. */
export function redactMemoryText(
  text: string,
  secrets: readonly string[] = [],
): string {
  let value = text;
  for (const secret of secrets)
    if (secret) value = value.split(secret).join("[REDACTED]");
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[^\s"\\]+)/gi,
      "[REDACTED]",
    )
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}]+)/gi,
      "$1[REDACTED]",
    );
}
