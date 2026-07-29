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
  /(rk_live_|at_live_|nt_live_|ot_live_|cld_at_|rth_at_|ocl_node_enr_|br_)[A-Za-z0-9_%-]{5,}/g;

/** Replace every embedded live credential in `text` with its masked form. */
export function redactCredentialValues(text: string): string {
  return text.replace(LIVE_CREDENTIAL, (match, prefix: string) => `${prefix}…${match.slice(-4)}`);
}
