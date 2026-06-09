/**
 * JSON report writing and cross-run comparison for the eval suite.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { EvalReport, MatrixReport, MetricSet } from '../types.js';
import { renderMatrixHtml, renderReportHtml } from './html.js';

/** Directory where reports are written (gitignored). */
export function reportsDir(): string {
  // Compiled location: dist/evals/report/ → scenario source lives under evals/.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'evals-reports');
}

/** Resolve the current git SHA, or "unknown" if unavailable. */
export function gitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Filesystem-safe ISO timestamp (colons replaced). */
export function isoStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a per-harness report. Returns the file path. */
export function writeReport(report: EvalReport, stamp: string): string {
  const dir = reportsDir();
  ensureDir(dir);
  const file = path.join(dir, `report-${stamp}-${report.harness}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

/** Write a per-harness HTML report. Returns the file path. */
export function writeReportHtml(report: EvalReport, stamp: string): string {
  const dir = reportsDir();
  ensureDir(dir);
  const file = path.join(dir, `report-${stamp}-${report.harness}.html`);
  fs.writeFileSync(file, renderReportHtml(report));
  return file;
}

/** Write the matrix roll-up across harnesses. Returns the file path. */
export function writeMatrix(matrix: MatrixReport, stamp: string): string {
  const dir = reportsDir();
  ensureDir(dir);
  const file = path.join(dir, `matrix-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(matrix, null, 2));
  return file;
}

/** Write the matrix HTML index linking to each harness's HTML report. */
export function writeMatrixHtml(matrix: MatrixReport, stamp: string): string {
  const dir = reportsDir();
  ensureDir(dir);
  const links: Record<string, string> = {};
  for (const harness of Object.keys(matrix.harnesses)) {
    links[harness] = `report-${stamp}-${harness}.html`;
  }
  const file = path.join(dir, `matrix-${stamp}.html`);
  fs.writeFileSync(file, renderMatrixHtml(matrix, links));
  return file;
}

/** Read a previously-written report from disk. */
export function readReport(file: string): EvalReport {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as EvalReport;
}

export interface MetricDelta {
  metric: keyof MetricSet;
  baseline: number;
  current: number;
  delta: number;
  /** True if the delta is a regression (worse). */
  regression: boolean;
}

/** Metrics where a higher value is better; the rest are better when lower. */
const HIGHER_IS_BETTER: Array<keyof MetricSet> = [
  'messageSentRate',
  'protocolAdherence',
  'deliverySuccessRate',
  'scenariosPassed',
];

/**
 * Compare two reports' metrics. A regression is flagged when a
 * higher-is-better metric drops or a lower-is-better metric rises beyond
 * `threshold`.
 */
export function compareReports(
  baseline: EvalReport,
  current: EvalReport,
  threshold = 0.0001
): MetricDelta[] {
  const keys: Array<keyof MetricSet> = [
    'messageSentRate',
    'phantomRate',
    'phantomCount',
    'protocolAdherence',
    'deliverySuccessRate',
    'wrongChannelReplies',
    'scenariosPassed',
  ];
  return keys.map((metric) => {
    const b = baseline.metrics[metric];
    const c = current.metrics[metric];
    const delta = c - b;
    const higherBetter = HIGHER_IS_BETTER.includes(metric);
    const regression = higherBetter ? delta < -threshold : delta > threshold;
    return { metric, baseline: b, current: c, delta, regression };
  });
}
