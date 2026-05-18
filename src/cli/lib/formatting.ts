export function formatRelativeTime(iso?: string): string {
  if (!iso) return 'unknown';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'unknown';
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 48) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/** Format an uptime expressed in whole seconds as a compact `1h 02m 03s`. */
export function formatUptimeSecs(totalSecs: number): string {
  if (!Number.isFinite(totalSecs) || totalSecs < 0) return '-';
  const secs = Math.floor(totalSecs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function parseSince(input?: string): number | undefined {
  if (!input) return undefined;
  const trimmed = String(input).trim();
  if (!trimmed) return undefined;

  const durationMatch = trimmed.match(/^(\d+)([smhd])$/i);
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return Date.now() - value * multipliers[unit];
  }

  if (
    !/^\d{4}-\d{2}-\d{2}(?:[Tt ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:[Zz]|[+-][0-2]\d:?[0-5]\d)?)?$/.test(
      trimmed
    )
  ) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

export function sanitizeForTerminal(input: string): string {
  /* eslint-disable no-control-regex -- intentionally matching ANSI/control bytes to strip them */
  return input
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9B[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0D\x0E-\x1F\x7F-\x9F]/g, '');
  /* eslint-enable no-control-regex */
}

export function sanitizeForTerminalLine(input: string): string {
  return sanitizeForTerminal(input.replace(/[\r\n\t]+/g, ' '));
}

export interface TableColumn {
  value: string;
  width?: number;
}

export function formatTableRow(columns: TableColumn[]): string {
  return columns
    .map((column) => (typeof column.width === 'number' ? column.value.padEnd(column.width) : column.value))
    .join(' ');
}
