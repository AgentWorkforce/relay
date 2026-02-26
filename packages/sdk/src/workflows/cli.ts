#!/usr/bin/env node

/**
 * CLI entry point for running relay.yaml workflows.
 *
 * Usage:
 *   relay-workflow <yaml-path> [--workflow <name>]
 *   relay-workflow --resume <run-id>
 *   npx @agent-relay/sdk run <yaml-path> [--workflow <name>]
 */

import path from 'node:path';
import type { WorkflowEvent } from './runner.js';
import { WorkflowRunner } from './runner.js';
import { JsonFileWorkflowDb } from './file-db.js';

function printUsage(): void {
  console.log(
    `
Usage: relay-workflow <yaml-path> [options]
       relay-workflow --resume <run-id>

Run a relay.yaml workflow file.

Arguments:
  <yaml-path>              Path to the relay.yaml workflow file

Options:
  --workflow <name>        Run a specific workflow by name (default: first)
  --resume <run-id>        Resume a failed or interrupted run by its run ID
  --validate               Validate workflow YAML for common issues without running
  --help                   Show this help message

Examples:
  relay-workflow workflows/daytona-migration.yaml
  relay-workflow workflows/feature-dev.yaml --workflow build-and-test
  relay-workflow --resume f409ce1d1788710bcc6abb55
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

  // Use a file-backed DB so runs survive process restarts and --resume works.
  const dbPath = path.join(process.cwd(), '.agent-relay', 'workflow-runs.jsonl');
  const fileDb = new JsonFileWorkflowDb(dbPath);
  if (!fileDb.isWritable()) {
    console.warn(
      `[workflow] warning: cannot write to ${dbPath} — run state will not be persisted (--resume unavailable)`
    );
  }
  const runner = new WorkflowRunner({ db: fileDb });
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

  // ── Resume mode ────────────────────────────────────────────────────────────
  const resumeIdx = args.indexOf('--resume');
  if (resumeIdx !== -1) {
    const runId = args[resumeIdx + 1];
    if (!runId) {
      console.error('Error: --resume requires a run ID');
      process.exit(1);
    }
    console.log(`Resuming run ${runId}...`);
    runner.on((event) => console.log(formatEvent(event)));
    const result = await runner.resume(runId);
    if (result.status === 'completed') {
      console.log(`\nWorkflow completed successfully.`);
      process.exit(0);
    } else {
      console.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
      process.exit(1);
    }
    return;
  }

  // ── Normal / validate / dry-run mode ──────────────────────────────────────
  const yamlPath = args[0];
  let workflowName: string | undefined;

  const workflowIdx = args.indexOf('--workflow');
  if (workflowIdx !== -1 && args[workflowIdx + 1]) {
    workflowName = args[workflowIdx + 1];
  }

  const isValidate = args.includes('--validate');

  console.log(`Running workflow from ${yamlPath}...`);

  const isDryRun = !!process.env.DRY_RUN;

  const config = await runner.parseYamlFile(yamlPath);
  if (isValidate) {
    const { validateWorkflow, formatValidationReport } = await import('./validator.js');
    const issues = validateWorkflow(config);
    console.log(formatValidationReport(issues, yamlPath));
    process.exit(issues.some((i) => i.severity === 'error') ? 1 : 0);
  }
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
