import { readFile } from 'node:fs/promises';
import { type Command } from 'commander';

import {
  clearBrokerLogs,
  getBrokerLogDir,
  listBrokerLogs,
  pruneBrokerLogs,
  tailBrokerLog,
  type BrokerLogFile,
} from '@agent-relay/sdk';

export interface LogCommandDependencies {
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
}

function defaults(overrides: Partial<LogCommandDependencies> = {}): LogCommandDependencies {
  return {
    log: overrides.log ?? ((m) => process.stdout.write(`${m}\n`)),
    error: overrides.error ?? ((m) => process.stderr.write(`${m}\n`)),
    exit: overrides.exit ?? ((code) => process.exit(code)),
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatFile(file: BrokerLogFile): string {
  const date = file.date ?? 'current';
  return `${file.name}\t${date}\t${formatSize(file.size)}\t${file.mtime.toISOString()}`;
}

async function runList(deps: LogCommandDependencies, brokerId?: string): Promise<number> {
  const files = await listBrokerLogs();
  const filtered = brokerId ? files.filter((f) => f.brokerId === brokerId) : files;
  if (filtered.length === 0) {
    deps.log(brokerId ? `No log files for broker '${brokerId}'.` : 'No broker log files.');
    deps.log(`Log directory: ${getBrokerLogDir()}`);
    return 0;
  }
  deps.log(`name\tdate\tsize\tmtime`);
  for (const file of filtered) deps.log(formatFile(file));
  return 0;
}

async function runView(
  deps: LogCommandDependencies,
  brokerId: string,
  opts: { lines?: string; file?: string }
): Promise<number> {
  const lines = opts.lines ? Number(opts.lines) : 200;
  if (!Number.isFinite(lines) || lines <= 0) {
    deps.error(`Invalid --lines value: ${opts.lines}`);
    return 2;
  }

  if (opts.file) {
    try {
      const content = await readFile(opts.file, 'utf-8');
      const split = content.split('\n');
      if (split.length > 0 && split[split.length - 1] === '') split.pop();
      deps.log(split.slice(-lines).join('\n'));
      return 0;
    } catch (err) {
      deps.error(`Failed to read ${opts.file}: ${(err as Error).message}`);
      return 1;
    }
  }

  const result = await tailBrokerLog(brokerId, { lines });
  if (!result) {
    const available = await listBrokerLogs();
    const ids = Array.from(new Set(available.map((f) => f.brokerId))).sort();
    deps.error(`No log file found for broker '${brokerId}'.`);
    if (ids.length > 0) deps.error(`Available broker ids: ${ids.join(', ')}`);
    else deps.error(`Log directory: ${getBrokerLogDir()}`);
    return 1;
  }
  deps.log(`# ${result.path}`);
  deps.log(result.content);
  return 0;
}

async function runRotate(
  deps: LogCommandDependencies,
  opts: { keepDays?: string; brokerId?: string; dryRun?: boolean }
): Promise<number> {
  const keepDays = opts.keepDays ? Number(opts.keepDays) : 7;
  if (!Number.isFinite(keepDays) || keepDays < 0) {
    deps.error(`Invalid --keep-days value: ${opts.keepDays}`);
    return 2;
  }
  const { removed, kept } = await pruneBrokerLogs({
    keepDays,
    brokerId: opts.brokerId,
    dryRun: opts.dryRun,
  });
  const action = opts.dryRun ? 'Would remove' : 'Removed';
  deps.log(`${action} ${removed.length} rotated file(s); kept ${kept.length}.`);
  for (const file of removed) deps.log(`  - ${file.name}\t${formatSize(file.size)}`);
  return 0;
}

async function runClear(
  deps: LogCommandDependencies,
  opts: { brokerId?: string; force?: boolean; dryRun?: boolean }
): Promise<number> {
  if (!opts.brokerId && !opts.force && !opts.dryRun) {
    deps.error('Refusing to delete all broker logs without --force. Pass --broker-id <id> or --force.');
    return 2;
  }
  const removed = await clearBrokerLogs({ brokerId: opts.brokerId, dryRun: opts.dryRun });
  const action = opts.dryRun ? 'Would remove' : 'Removed';
  deps.log(`${action} ${removed.length} file(s).`);
  for (const file of removed) deps.log(`  - ${file.name}`);
  return 0;
}

/** Register `agent-relay log <subcommand>` on the supplied commander program. */
export function registerLogCommands(program: Command, overrides: Partial<LogCommandDependencies> = {}): void {
  const deps = defaults(overrides);
  const log = program.command('log').description('Inspect and manage broker tracing logs');

  log
    .command('path')
    .description('Print the broker log directory')
    .action(() => {
      deps.log(getBrokerLogDir());
    });

  log
    .command('list')
    .description('List broker log files')
    .argument('[brokerId]', 'Restrict to a single broker id')
    .action(async (brokerId?: string) => {
      const code = await runList(deps, brokerId);
      if (code !== 0) deps.exit(code);
    });

  log
    .command('view')
    .description("Tail a broker's tracing log")
    .argument('<brokerId>', 'Broker id (filename prefix before .log)')
    .option('-n, --lines <count>', 'Number of trailing lines to show', '200')
    .option('--file <path>', 'Read a specific log file instead of the latest one')
    .action(async (brokerId: string, opts: { lines?: string; file?: string }) => {
      const code = await runView(deps, brokerId, opts);
      if (code !== 0) deps.exit(code);
    });

  log
    .command('rotate')
    .description('Prune rotated log files older than --keep-days')
    .option('--keep-days <days>', 'Retain rotated files newer than this (default 7)', '7')
    .option('--broker-id <id>', 'Restrict to a single broker id')
    .option('--dry-run', 'List candidates without deleting', false)
    .action(async (opts: { keepDays?: string; brokerId?: string; dryRun?: boolean }) => {
      const code = await runRotate(deps, opts);
      if (code !== 0) deps.exit(code);
    });

  log
    .command('clear')
    .description('Delete broker log files (including the active one)')
    .option('--broker-id <id>', 'Restrict to a single broker id')
    .option('--force', 'Required to delete all logs without --broker-id', false)
    .option('--dry-run', 'List candidates without deleting', false)
    .action(async (opts: { brokerId?: string; force?: boolean; dryRun?: boolean }) => {
      const code = await runClear(deps, opts);
      if (code !== 0) deps.exit(code);
    });
}
