#!/usr/bin/env node

/**
 * CLI entry point for running relay.yaml workflows.
 *
 * Usage:
 *   relay-workflow <yaml-path> [--workflow <name>]
 *   npx @agent-relay/sdk run <yaml-path> [--workflow <name>]
 */

import type { WorkflowEvent } from './runner.js';
import { WorkflowRunner } from './runner.js';

function printUsage(): void {
  console.log(
    `
Usage: relay-workflow <yaml-path> [options]

Run a relay.yaml workflow file.

Arguments:
  <yaml-path>              Path to the relay.yaml workflow file

Options:
  --workflow <name>        Run a specific workflow by name (default: first)
  --help                   Show this help message

Examples:
  relay-workflow workflows/daytona-migration.yaml
  relay-workflow workflows/feature-dev.yaml --workflow build-and-test
`.trim()
  );
}

function formatEvent(event: WorkflowEvent): string {
  switch (event.type) {
    case 'run:started':
      return `[run] started (${event.runId})`;
    case 'run:completed':
      return `[run] completed`;
    case 'run:failed':
      return `[run] failed: ${event.error}`;
    case 'run:cancelled':
      return `[run] cancelled`;
    case 'step:started':
      return `[step] ${event.stepName} started`;
    case 'step:completed':
      return `[step] ${event.stepName} completed`;
    case 'step:failed':
      return `[step] ${event.stepName} failed: ${event.error}`;
    case 'step:skipped':
      return `[step] ${event.stepName} skipped`;
    case 'step:retrying':
      return `[step] ${event.stepName} retrying (attempt ${event.attempt})`;
    case 'step:nudged':
      return `[step] ${event.stepName} nudged (nudge #${event.nudgeCount})`;
    case 'step:force-released':
      return `[step] ${event.stepName} force-released`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    printUsage();
    process.exit(args.includes('--help') ? 0 : 1);
  }

  const yamlPath = args[0];
  let workflowName: string | undefined;

  const workflowIdx = args.indexOf('--workflow');
  if (workflowIdx !== -1 && args[workflowIdx + 1]) {
    workflowName = args[workflowIdx + 1];
  }

  console.log(`Running workflow from ${yamlPath}...`);

  const isDryRun = !!process.env.DRY_RUN;

  // Wire up signal handlers so Ctrl+C / SIGTERM always shuts the broker down
  // cleanly rather than leaving an orphaned process behind.
  const runner = new WorkflowRunner();
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[workflow] ${signal} received — shutting down broker...`);
    await runner.relay?.shutdown().catch(() => undefined);
    process.exit(130);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const config = await runner.parseYamlFile(yamlPath);
  if (isDryRun) {
    const { formatDryRunReport } = await import('./dry-run-format.js');
    const report = runner.dryRun(config, workflowName);
    console.log(formatDryRunReport(report));
    process.exit(report.valid ? 0 : 1);
  }

  runner.on((event) => console.log(formatEvent(event)));
  const result = await runner.execute(config, workflowName);

  if (result.status === 'completed') {
    console.log(`\nWorkflow completed successfully.`);
    process.exit(0);
  } else {
    console.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
    process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
