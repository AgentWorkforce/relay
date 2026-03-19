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
  const headers = ['Step', 'Status', 'Model', 'Cost', 'Tokens', 'Duration', 'Errors'];
  const widths = [20, 6, 16, 8, 10, 10, 10];
  const lines: string[] = [];

  lines.push(
    [
      pad(headers[0], widths[0]),
      pad(headers[1], widths[1]),
      pad(headers[2], widths[2]),
      pad(headers[3], widths[3], 'right'),
      pad(headers[4], widths[4], 'right'),
      pad(headers[5], widths[5], 'right'),
      pad(headers[6], widths[6], 'right'),
    ].join('  ')
  );

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

    lines.push(
      [
        pad(truncate(outcome.name, widths[0]), widths[0]),
        pad(outcome.status === 'failed' ? 'FAIL' : outcome.status === 'completed' ? 'pass' : 'skip', widths[1]),
        pad(truncate(report?.model ?? '--', widths[2]), widths[2]),
        pad(formatCurrency(report?.cost), widths[3], 'right'),
        pad(formatTokens(report), widths[4], 'right'),
        pad(formatDuration(reportDuration), widths[5], 'right'),
        pad(formatErrors(outcome, report), widths[6], 'right'),
      ].join('  ')
    );

    if (outcome.status === 'failed') {
      const firstError = report?.errors[0];
      if (firstError) {
        lines.push(`  └─ Error [turn ${firstError.turn}] ${truncate(firstError.text, 120)}`);
      }
    }
  }

  const totalLabelWidth = widths[0] + widths[1] + widths[2] + 4;
  lines.push('─'.repeat(lines[0].length));
  lines.push(
    [
      pad('Total', totalLabelWidth),
      pad(formatCurrency(totalCost), widths[3], 'right'),
      pad(totalTokens > 0 ? totalTokens.toLocaleString('en-US') : '--', widths[4], 'right'),
      pad(formatDuration(totalDurationMs), widths[5], 'right'),
      pad('', widths[6], 'right'),
    ].join('  ')
  );

  return lines.map((line) => `  ${line}`).join('\n');
}
