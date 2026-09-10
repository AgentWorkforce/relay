/**
 * Value-pattern credential redaction for error and log text.
 *
 * Endpoint URLs put workspace keys in paths and query strings, and server
 * error payloads are free to echo whatever was sent, so key-name redaction
 * cannot help here — the only safe boundary is the text itself. Any
 * live-credential token embedded in the string collapses to its prefix plus
 * the last four characters, keeping the message actionable without carrying
 * a usable secret.
 */
const LIVE_CREDENTIAL =
  /(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|rk_live_|rjt_live_|at_live_|nt_live_|ot_live_|cld_at_|rth_at_|ocl_node_enr_|br_)([A-Za-z0-9_%-]+(?:\.[A-Za-z0-9_%-]+)*)/g;

/**
 * Replace every embedded live credential in `text` with its masked form —
 * the same rule as the CLI's `maskSecret`: prefix plus the last four BODY
 * characters, and a body too short for a safe suffix masks entirely. Bodies
 * may be dot-chained (JWT-shaped) so a token's tail segments never survive.
 */
export function redactCredentialValues(text: string): string {
  return text.replace(LIVE_CREDENTIAL, (_match, prefix: string, body: string) =>
    body.length <= 8 ? `${prefix}…` : `${prefix}…${body.slice(-4)}`
  );
}
