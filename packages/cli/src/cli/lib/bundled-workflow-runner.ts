import path from 'node:path';

import { runScriptWorkflow, runWorkflow } from '@relayflows/core';

type WorkflowOptions = {
  workflow?: string;
  dryRun?: boolean;
  resume?: string;
  startFrom?: string;
  previousRunId?: string;
};

function parseRunOptions(args: readonly string[]): { filePath: string; options: WorkflowOptions } {
  if (args[0] !== 'run' || !args[1]) {
    throw new Error('Expected bundled workflow invocation: run <file>');
  }

  const options: WorkflowOptions = {};
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--workflow' || arg === '-w') {
      options.workflow = args[++index];
    } else if (arg === '--resume') {
      options.resume = args[++index];
    } else if (arg === '--start-from') {
      options.startFrom = args[++index];
    } else if (arg === '--previous-run-id') {
      options.previousRunId = args[++index];
    } else {
      throw new Error(`Unknown bundled workflow option: ${arg}`);
    }
  }

  return { filePath: path.resolve(args[1]), options };
}

function logWorkflowEvent(event: { type: string; stepName?: string; error?: string }): void {
  if (event.type === 'broker:event') return;
  const prefix = event.type.startsWith('run:') ? '[run]' : '[step]';
  const name = event.stepName ? `${event.stepName} ` : '';
  const status = event.type.split(':')[1] ?? event.type;
  const detail = event.error ? `: ${event.error}` : '';
  console.log(`${prefix} ${name}${status}${detail}`);
}

/** Run a Cloud workflow with the relayflows core bundled into the standalone binary. */
export async function runBundledWorkflowCli(args: readonly string[]): Promise<void> {
  const { filePath, options } = parseRunOptions(args);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    const result = await runWorkflow(filePath, {
      workflow: options.workflow,
      dryRun: options.dryRun,
      resume: options.resume,
      startFrom: options.startFrom,
      previousRunId: options.previousRunId,
      onEvent: logWorkflowEvent,
    });
    if (options.dryRun) return;
    if ('status' in result && result.status === 'completed') return;
    const detail = 'error' in result && result.error ? `: ${result.error}` : '';
    throw new Error(`Workflow failed${detail}`);
  }

  if (ext === '.ts' || ext === '.tsx' || ext === '.py') {
    await runScriptWorkflow(filePath, {
      dryRun: options.dryRun,
      resume: options.resume,
      startFrom: options.startFrom,
      previousRunId: options.previousRunId,
    });
    return;
  }

  throw new Error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
}
