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

export function parseSince(input?: string): number | undefined {
  if (!input) return undefined;
  const trimmed = String(input).trim();
  if (!trimmed) return undefined;

  const durationMatch = trimmed.match(/^(-?\d+)([smhd])$/i);
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

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
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
