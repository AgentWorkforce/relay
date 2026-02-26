/**
 * PTY stream utilities — ANSI stripping and line extraction.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][0-9A-Za-z]|[\x20-\x2f]*[\x40-\x7e])|\x1b/g;

// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD_CSI_RE = /\x1b\[(\d*)C/g;

// eslint-disable-next-line no-control-regex
const ORPHANED_CURSOR_FORWARD_CSI_RE = /\[(\d*)C/g;

function cursorForwardSpaces(countText: string | undefined): string {
  const count = Number.parseInt(countText || "1", 10);
  const width = Number.isFinite(count) && count > 0 ? count : 1;
  return " ".repeat(width);
}

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(s: string): string {
  let result = s.replace(CURSOR_FORWARD_CSI_RE, (_match, count: string) =>
    cursorForwardSpaces(count)
  );
  result = result.replace(ANSI_RE, "");
  result = result.replace(ORPHANED_CURSOR_FORWARD_CSI_RE, (_match, count: string) =>
    cursorForwardSpaces(count)
  );
  return result;
}

/** Strip ANSI, split on newlines, trim, and drop empty lines. */
export function cleanLines(raw: string): string[] {
  return stripAnsi(raw).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
}
