export function isSensitivePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) =>
    /^(?:\.env.*|\.ssh|\.config|\.git|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(part) ||
    /credentials/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part),
  );
}

export function containsSensitiveText(text: string): boolean {
  return (
    /^\s*-----BEGIN [A-Z ]*PRIVATE KEY-----/m.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/.test(text) ||
    /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*=\s*(?:[A-Za-z0-9_-]{8,}|"[A-Za-z0-9_-]{8,}"|'[A-Za-z0-9_-]{8,}')\s*$/im.test(text)
  );
}
