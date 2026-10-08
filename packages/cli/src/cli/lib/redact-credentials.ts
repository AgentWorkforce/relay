/**
 * Strip Relay credentials from text that may reach a log, stderr, or a tool
 * result. Upstream errors sometimes quote the request that failed, so any
 * message built from one goes through here first.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  // Relaycast agent tokens and workspace keys (live and test).
  /\b(?:at|rk)_(?:live|test)_[A-Za-z0-9_-]+/g,
  // JWTs, e.g. RelayAuth tokens.
  /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
  // Credentials embedded in a URL, e.g. https://user:secret@host.
  /(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi,
  // Authorization header values.
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
];

export function redactCredentials(text: string, known: Array<string | undefined> = []): string {
  let out = text;
  for (const secret of known) {
    if (secret && secret.length >= 8) out = out.split(secret).join('<redacted>');
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' && /^bearer$/i.test(prefix)
        ? `${prefix} <redacted>`
        : match.endsWith('@')
          ? '<redacted>@'
          : '<redacted>'
    );
  }
  return out;
}
