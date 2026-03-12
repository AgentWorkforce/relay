function maskSecret(value: string, visiblePrefix: number): string {
  const trimmed = value.trim();
  if (!trimmed) return '***';
  if (trimmed.length <= visiblePrefix) return '***';
  return `${trimmed.slice(0, visiblePrefix)}...`;
}

const RELAY_SECRET_PATTERNS = [
  /\brk_[A-Za-z0-9._-]{8,}\b/g,
  /\bat_[A-Za-z0-9._-]{8,}\b/g,
];

export function maskWorkspaceKey(value: string): string {
  return maskSecret(value, 12);
}

export function redactRelaySecrets(value: string): string {
  let redacted = value;
  for (const pattern of RELAY_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => maskWorkspaceKey(match));
  }

  return redacted.replace(
    /\b(Bearer\s+)([A-Za-z0-9._~-]{8,})\b/gi,
    (_, prefix: string, secret: string) => `${prefix}${maskSecret(secret, 8)}`
  );
}

export function redactErrorMessage(error: unknown): string {
  return redactRelaySecrets(error instanceof Error ? error.message : String(error));
}
