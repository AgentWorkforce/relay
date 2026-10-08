import { redactCredentialValues } from '@agent-relay/cloud/redact';

/**
 * Strip Relay credentials from text that may reach a log, stderr, or a tool
 * result. Upstream errors sometimes quote the request that failed, so any
 * message built from one goes through here first.
 *
 * Live-credential prefixes (`rk_live_`, `at_live_`, `nt_live_`, `rjt_live_`,
 * `ocl_node_enr_`, ...) are masked by the shared cloud redactor; the patterns
 * below cover the shapes it does not.
 */
const EXTRA_PATTERNS: Array<[RegExp, string]> = [
  // Relaycast test-mode tokens and keys.
  [/\b(?:at|rk)_test_[A-Za-z0-9_-]+/g, '<redacted>'],
  // JWTs, e.g. RelayAuth tokens.
  [/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '<redacted>'],
  // Authorization header values.
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>'],
  // Credentials embedded in a URL, e.g. https://user:secret@host.
  [/(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '<redacted>@'],
  // Credential-bearing query or form parameters, e.g. ?api_key=... or &token=...
  [
    /([?&;]|\b)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|key|workspace[_-]?key|client[_-]?secret|sig|signature)=)[^\s&#;"']+/gi,
    '$1$2<redacted>',
  ],
];

export function redactCredentials(text: string, known: Array<string | null | undefined> = []): string {
  let out = text;
  for (const secret of known) {
    const value = secret?.trim();
    if (value) out = out.split(value).join('<redacted>');
  }
  out = redactCredentialValues(out);
  for (const [pattern, replacement] of EXTRA_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
