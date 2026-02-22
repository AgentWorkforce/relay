/**
 * PTY stream utilities — ANSI stripping and line extraction.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][0-9A-Za-z]|[\x20-\x2f]*[\x40-\x7e])|\x1b/g;

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Strip ANSI, split on newlines, trim, and drop empty lines. */
export function cleanLines(raw: string): string[] {
  return stripAnsi(raw).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
}
