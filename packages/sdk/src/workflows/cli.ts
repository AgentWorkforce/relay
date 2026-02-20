#!/usr/bin/env node

/**
 * CLI entry point for running relay.yaml workflows.
 *
 * Usage:
 *   relay-workflow <yaml-path> [--workflow <name>]
 *   npx @agent-relay/sdk run <yaml-path> [--workflow <name>]
 */

import type { WorkflowEvent } from './runner.js';
import { runWorkflow } from './run.js';

function printUsage(): void {
  console.log(`
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
`.trim());
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

  const result = await runWorkflow(yamlPath, {
    workflow: workflowName,
    onEvent(event) {
      console.log(formatEvent(event));
    },
  });

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
