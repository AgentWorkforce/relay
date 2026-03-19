import type { CliSessionReport } from './cli-session-collector.js';
import type { StepOutcome } from './trajectory.js';

function formatCurrency(value: number | null | undefined): string {
  return typeof value === 'number' ? `$${value.toFixed(2)}` : '--';
}

function formatTokens(report: CliSessionReport | undefined): string {
  if (!report?.tokens) return '--';
  const total = report.tokens.input + report.tokens.output + report.tokens.cacheRead;
  return total.toLocaleString('en-US');
}

function formatDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '--';
  if (durationMs < 1000) return `${durationMs}ms`;

  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  if (length <= 1) return value.slice(0, length);
  return `${value.slice(0, length - 1)}…`;
}

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  return align === 'right' ? value.padStart(width, ' ') : value.padEnd(width, ' ');
}

function formatErrors(outcome: StepOutcome, report: CliSessionReport | undefined): string {
  const count = report?.errors.length ?? 0;
  if (count === 0) return outcome.status === 'failed' && outcome.error ? '1' : '--';
  if (outcome.status === 'completed') return `${count} (fixed)`;
  return String(count);
}

export function formatRunSummaryTable(
  outcomes: StepOutcome[],
  reports: Map<string, CliSessionReport>
): string {
  // Only show the Cost column when at least one report has reliable cost data
  // (currently only OpenCode populates cost; Claude and Codex return null)
  const hasCost = Array.from(reports.values()).some((r) => typeof r.cost === 'number' && r.cost > 0);

  const headers = hasCost
    ? ['Step', 'Status', 'Model', 'Cost', 'Tokens', 'Duration', 'Errors']
    : ['Step', 'Status', 'Model', 'Tokens', 'Duration', 'Errors'];
  const widths = hasCost
    ? [20, 6, 16, 8, 10, 10, 10]
    : [20, 6, 16, 10, 10, 10];
  const lines: string[] = [];

  lines.push(headers.map((h, i) => {
    const align = i <= 2 ? 'left' : 'right';
    return pad(h, widths[i], align);
  }).join('  '));

  let totalCost = 0;
  let totalTokens = 0;
  let totalDurationMs = 0;

  for (const outcome of outcomes) {
    const report = reports.get(outcome.name);
    const reportDuration = report?.durationMs ?? outcome.durationMs;
    const reportTokens = report?.tokens
      ? report.tokens.input + report.tokens.output + report.tokens.cacheRead
      : 0;

    if (typeof report?.cost === 'number') totalCost += report.cost;
    totalTokens += reportTokens;
    if (typeof reportDuration === 'number') totalDurationMs += reportDuration;

    const cols: string[] = [
      pad(truncate(outcome.name, widths[0]), widths[0]),
      pad(outcome.status === 'failed' ? 'FAIL' : outcome.status === 'completed' ? 'pass' : 'skip', widths[1]),
      pad(truncate(report?.model ?? '--', widths[2]), widths[2]),
    ];
    if (hasCost) cols.push(pad(formatCurrency(report?.cost), widths[3], 'right'));
    const tokenIdx = hasCost ? 4 : 3;
    cols.push(pad(formatTokens(report), widths[tokenIdx], 'right'));
    cols.push(pad(formatDuration(reportDuration), widths[tokenIdx + 1], 'right'));
    cols.push(pad(formatErrors(outcome, report), widths[tokenIdx + 2], 'right'));

    lines.push(cols.join('  '));

    if (outcome.status === 'failed') {
      const firstError = report?.errors[0];
      if (firstError) {
        lines.push(`  └─ Error [turn ${firstError.turn}] ${truncate(firstError.text, 120)}`);
      }
    }
  }

  const totalLabelWidth = widths[0] + widths[1] + widths[2] + 4;
  lines.push('─'.repeat(lines[0].length));

  const totalCols: string[] = [pad('Total', totalLabelWidth)];
  if (hasCost) totalCols.push(pad(formatCurrency(totalCost), widths[3], 'right'));
  const tokenIdx = hasCost ? 4 : 3;
  totalCols.push(pad(totalTokens > 0 ? totalTokens.toLocaleString('en-US') : '--', widths[tokenIdx], 'right'));
  totalCols.push(pad(formatDuration(totalDurationMs), widths[tokenIdx + 1], 'right'));
  totalCols.push(pad('', widths[tokenIdx + 2], 'right'));
  lines.push(totalCols.join('  '));

  return lines.map((line) => `  ${line}`).join('\n');
}
