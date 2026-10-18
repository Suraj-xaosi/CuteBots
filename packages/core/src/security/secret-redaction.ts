export function redactTextSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/([a-z][a-z0-9+.-]*):\/\/[^:/\s]+:[^@\s]+@/gi, "$1://[redacted]@")
    .replace(/(\b[\w.-]*(?:_KEY|_TOKEN|_PASSWORD|_SECRET|_CREDENTIALS?|_AUTHORIZATION)\b\s*[:=]\s*["']?)[^\s"',;}{]+/gi, "$1[redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;}{]+/gi, "$1[redacted]");
}

export function redactStructuredSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredSecrets);
  if (typeof value === "string") return redactTextSecrets(value);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(?:^|[_-])(?:api[_-]?key|key|token|password|secret|credentials?|authorization)(?:$|[_-])/i.test(key)
      ? "[redacted]"
      : redactStructuredSecrets(entry),
  ]));
}
