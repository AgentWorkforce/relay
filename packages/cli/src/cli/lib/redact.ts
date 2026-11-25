/**
 * Structural secret redaction for anything that gets printed or logged.
 *
 * The broker session carries the node token and workspace key; command output
 * (e.g. `fleet status`) and any future debug dump must never surface them. Run
 * the value through {@link redactSecrets} at the serialization boundary so the
 * redaction is a property of the display path, not a promise that a given field
 * "isn't printed today".
 */

/** Keys whose values are credentials and must be redacted before display. */
const SECRET_KEY = /token|secret|password|api[_-]?key|workspace[_-]?key|authorization/i;

/** Known live-credential prefixes, kept visible so a masked value still identifies its kind. */
const SECRET_PREFIXES =
  'rk_live_|rjt_live_|at_live_|nt_live_|ot_live_|ar_ws_|ar_ag_|br_|rth_at_|cld_at_|ocl_node_enr_';
const SECRET_PREFIX = new RegExp(`^(${SECRET_PREFIXES})`);

/**
 * A live credential embedded in free text. The prefix must start a token, so
 * an ordinary word that merely contains one (`cobr_worker`) is left alone.
 */
const EMBEDDED_SECRET = new RegExp(`(?<![A-Za-z0-9])(?:${SECRET_PREFIXES})[A-Za-z0-9_%.-]+`, 'g');

/**
 * Well-known third-party credential formats. Each pairs a fixed prefix with a
 * long random body, so a readable name (`sk-reviewer`, `ghp_bot`) never
 * matches. Not exhaustive: a credential in any other shape is not detected.
 */
const THIRD_PARTY_SECRETS = [
  'gh[pousr]_[A-Za-z0-9]{36}', // GitHub tokens
  'github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}', // GitHub fine-grained tokens
  'xox[abposr]-[0-9]{8,}-(?:[0-9]+-){1,2}[A-Za-z0-9]{24,}', // Slack tokens
  '(?:AKIA|ASIA)[0-9A-Z]{16}', // AWS access key IDs
  'sk-(?:ant|proj)-[A-Za-z0-9_-]{80,}', // Anthropic and OpenAI project keys
  'sk-[A-Za-z0-9]{32,}', // OpenAI legacy keys
  'eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*', // JWTs
].join('|');
const EMBEDDED_THIRD_PARTY_SECRET = new RegExp(
  `(?<![A-Za-z0-9])(?:${THIRD_PARTY_SECRETS})(?![A-Za-z0-9])`,
  'g'
);

/**
 * URL userinfo (`https://user:pass@host`); fetch echoes the URL when it rejects
 * one. Masked through the authority's last `@`, where a URL parser splits it.
 */
const URL_USERINFO = /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#]+@/g;

/**
 * Mask a credential for display: the known prefix (if any) and the last four
 * characters stay visible, everything else collapses to `…`. Values too short
 * to safely show a suffix mask entirely. Use this wherever a command prints a
 * key on purpose — the masked form still identifies which credential it is
 * without being usable.
 */
export function maskSecret(value: string): string {
  const prefix = value.match(SECRET_PREFIX)?.[1] ?? '';
  const body = value.slice(prefix.length);
  if (body.length <= 8) {
    return `${prefix}…`;
  }
  return `${prefix}…${body.slice(-4)}`;
}

/**
 * Mask credentials inside text bound for stderr or a log. `knownSecrets` are
 * the caller's own credentials, masked wherever they appear whatever their
 * shape (a RelayAuth JWT has no known prefix); anything else that starts with
 * a known live-credential prefix or matches a well-known third-party format
 * is masked too, as is URL userinfo. A credential in an unrecognised shape
 * still passes through.
 * @param text - The text about to be printed.
 * @param knownSecrets - Credentials the caller holds; values under 8 characters are ignored.
 * @returns The text with every credential in it masked by {@link maskSecret}.
 */
export function maskSecretsInText(
  text: string,
  knownSecrets: ReadonlyArray<string | undefined> = []
): string {
  let masked = text;
  const secrets = knownSecrets.filter(
    (secret): secret is string => typeof secret === 'string' && secret.length >= 8
  );
  // Longest first, so a secret that contains another is masked whole.
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    masked = masked.split(secret).join(maskSecret(secret));
  }
  return masked
    .replace(EMBEDDED_SECRET, (match) => maskSecret(match))
    .replace(EMBEDDED_THIRD_PARTY_SECRET, (match) => maskSecret(match))
    .replace(URL_USERINFO, '$1…@');
}

const REDACTED = '[redacted]';

const CIRCULAR = '[circular]';

/**
 * Deep-copy `value`, replacing the value of any credential-named key with
 * `[redacted]`. Non-secret keys are preserved and recursed into. A value that
 * references one of its own ancestors is emitted as `[circular]` so a cyclic
 * debug dump redacts instead of overflowing the stack.
 */
export function redactSecrets<T>(value: T): T {
  return redact(value, new WeakSet<object>());
}

function redact<T>(value: T, ancestors: WeakSet<object>): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const node = value as object;
  if (ancestors.has(node)) {
    return CIRCULAR as unknown as T;
  }
  ancestors.add(node);
  const result = Array.isArray(value)
    ? (value.map((item) => redact(item, ancestors)) as unknown as T)
    : (Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) =>
          SECRET_KEY.test(key) ? [key, child == null ? child : REDACTED] : [key, redact(child, ancestors)]
        )
      ) as T);
  ancestors.delete(node);
  return result;
}
