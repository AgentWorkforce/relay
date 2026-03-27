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
import chalk from 'chalk';

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
  --start-from <step>      Start from a specific step, skipping predecessors
  --previous-run-id <id>   Use cached outputs from a specific prior run (with --start-from)
  --validate               Validate workflow YAML for common issues without running
  --help                   Show this help message

Examples:
  relay-workflow workflows/daytona-migration.yaml
  relay-workflow workflows/feature-dev.yaml --workflow build-and-test
  relay-workflow --resume f409ce1d1788710bcc6abb55
`.trim()
  );
}

type RunnerConfig = Awaited<ReturnType<WorkflowRunner['parseYamlFile']>>;

type RunnerResult = Awaited<ReturnType<WorkflowRunner['execute']>>;

type ExecuteOptions = {
  startFrom: string;
  previousRunId?: string;
};

/** Flags that consume the next argument as their value. Single source of truth for CLI parsing. */
const FLAGS_WITH_VALUES = new Set(['--resume', '--workflow', '--start-from', '--previous-run-id']);

function getYamlPathArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (FLAGS_WITH_VALUES.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

interface RenderableTask {
  output?: string;
  title: string;
}

interface StepHandle {
  resolve: () => void;
  reject: (error: Error) => void;
  setOutput: (text: string) => void;
  markSkipped: () => void;
}

// Filter [broker] and [workflow HH:MM] noise while listr owns the terminal,
// but let the observer URL and channel name through.
function installOutputFilter(): () => void {
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const str = String(args[0] ?? '');
    if (str.includes('Observer:') || str.includes('agentrelay.dev') || str.includes('Channel: wf-')) {
      orig(...args);
      return;
    }
    if (/\[broker\]/.test(str) || /\[workflow\s+\d{2}:\d{2}\]/.test(str)) return;
    orig(...args);
  };
  return () => { console.log = orig; };
}

async function runWithListr(
  runner: WorkflowRunner,
  config: RunnerConfig,
  workflowName: string | undefined,
  executeOptions: ExecuteOptions | undefined,
): Promise<RunnerResult> {
  const stepHandles = new Map<string, StepHandle>();
  const restoreConsole = installOutputFilter();

  let resolveWorkflow!: () => void;
  let rejectWorkflow!: (error: Error) => void;
  const workflowDone = new Promise<void>((resolve, reject) => {
    resolveWorkflow = resolve;
    rejectWorkflow = reject;
  });
  workflowDone.catch(() => {});

  let setHeader: (text: string) => void = () => {};

  const { Listr } = await import('listr2');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listr = new (Listr as any)(
    [
      {
        title: chalk.dim('Workflow starting...'),
        task: async (_ctx: unknown, task: any): Promise<void> => {
          setHeader = (text: string): void => {
            task.title = text;
          };
          await workflowDone;
        },
      },
    ],
    {
      concurrent: true,
      renderer: process.stdout.isTTY ? 'default' : 'verbose',
      rendererOptions: {
        collapseErrors: false,
        showErrorMessage: true,
      },
    },
  );

  runner.on((event: WorkflowEvent) => {
    switch (event.type) {
      case 'run:started': {
        setHeader(chalk.dim(`[workflow] run ${event.runId.slice(0, 8)}...`));
        break;
      }

      case 'step:started': {
        let resolveStep!: () => void;
        let rejectStep!: (error: Error) => void;
        let taskRef: RenderableTask | null = null;
        let skipped = false;

        const done = new Promise<void>((resolve, reject) => {
          resolveStep = resolve;
          rejectStep = reject;
        });
        done.catch(() => {});

        stepHandles.set(event.stepName, {
          resolve: resolveStep,
          reject: rejectStep,
          setOutput: (text: string) => {
            if (taskRef) {
              taskRef.output = text;
            }
          },
          markSkipped: () => {
            skipped = true;
            if (taskRef) {
              taskRef.title = chalk.dim(`${event.stepName} (skipped)`);
            }
          },
        });

        listr.add({
          title: chalk.white(event.stepName),
          task: async (_ctx: unknown, task: any): Promise<void> => {
            taskRef = task as RenderableTask;
            if (skipped) {
              taskRef.title = chalk.dim(`${event.stepName} (skipped)`);
            }
            await done;
          },
          rendererOptions: {
            persistentOutput: true,
          },
        });
        break;
      }

      case 'step:owner-assigned': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.setOutput(
            chalk.dim(`> Owner: ${event.ownerName}`) +
              (event.specialistName ? chalk.dim(` - specialist: ${event.specialistName}`) : '')
          );
        }
        break;
      }

      case 'step:retrying': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.setOutput(chalk.yellow(`Retrying (attempt ${event.attempt})`));
        }
        break;
      }

      case 'step:nudged': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.setOutput(chalk.dim(`> Nudge #${event.nudgeCount}`));
        }
        break;
      }

      case 'step:force-released': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.setOutput(chalk.yellow('> Force-released'));
        }
        break;
      }

      case 'step:review-completed': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.setOutput(chalk.dim(`> Review: ${event.decision} by ${event.reviewerName}`));
        }
        break;
      }

      case 'step:owner-timeout': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.setOutput(chalk.red(`> Owner ${event.ownerName} timed out`));
        }
        break;
      }

      case 'step:agent-report': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          const model = event.report.model ? `:${event.report.model}` : '';
          handle.setOutput(chalk.dim(`> Report collected (${event.report.cli}${model})`));
        }
        break;
      }

      case 'step:completed': {
        stepHandles.get(event.stepName)?.resolve();
        break;
      }

      case 'step:skipped': {
        const handle = stepHandles.get(event.stepName);
        if (handle) {
          handle.markSkipped();
          handle.resolve();
        } else {
          // Step was skipped without ever being started (downstream of a failure).
          // Add an already-resolved task so it shows in the listr output.
          listr.add({
            title: chalk.dim(`${event.stepName} (skipped)`),
            task: async (): Promise<void> => {},
            rendererOptions: { persistentOutput: true },
          });
        }
        break;
      }

      case 'step:failed': {
        stepHandles.get(event.stepName)?.reject(new Error(event.error ?? 'Step failed'));
        break;
      }

      case 'run:completed': {
        setHeader(chalk.green('Workflow completed'));
        resolveWorkflow();
        break;
      }

      case 'run:failed': {
        setHeader(chalk.red(`Workflow failed: ${event.error}`));
        rejectWorkflow(new Error(event.error ?? 'Workflow failed'));
        break;
      }

      case 'run:cancelled': {
        setHeader(chalk.yellow('Workflow cancelled'));
        resolveWorkflow();
        break;
      }

      case 'broker:event':
        break;

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  });

  const [result] = await Promise.all([
    runner.execute(config, workflowName, undefined, executeOptions),
    listr.run().catch(() => {
      // Step failures are already represented in runner result.
    }),
  ]);

  restoreConsole();
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const yamlPath = getYamlPathArg(args);

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
      console.error(chalk.red('Error: --resume requires a run ID'));
      process.exit(1);
    }

    console.log(chalk.dim(`Resuming run ${runId}...`));
    runner.on((event: WorkflowEvent) => {
      const ts = new Date().toISOString().slice(11, 19);
      switch (event.type) {
        case 'step:started':
          console.log(chalk.dim(`[${ts}]`), chalk.white(event.stepName), chalk.dim('started'));
          break;
        case 'step:completed':
          console.log(chalk.dim(`[${ts}]`), chalk.green('✔'), event.stepName);
          break;
        case 'step:failed':
          console.log(chalk.dim(`[${ts}]`), chalk.red('✗'), event.stepName, chalk.red(event.error ?? ''));
          break;
        case 'step:skipped':
          console.log(chalk.dim(`[${ts}]`), chalk.dim('⊘'), chalk.dim(event.stepName));
          break;
        default:
          break;
      }
    });
    let result: RunnerResult;
    try {
      const resumeConfig = yamlPath ? await runner.parseYamlFile(yamlPath) : undefined;
      if (resumeConfig) {
        console.warn(
          chalk.yellow(
            '[workflow] warning: resuming with current config from disk — ' +
              'if the workflow YAML changed since the original run, behaviour may differ'
          )
        );
      }
      result = await runner.resume(runId, undefined, resumeConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRunNotFound = message.startsWith(`Run "${runId}" not found`);
      if (isRunNotFound) {
        if (fileDb.hasStepOutputs(runId)) {
          console.error(
            chalk.red(
              `Error: ${message}. Step outputs exist for this run, but persisted run state is missing from ${dbPath}. ` +
                `Use --start-from with --previous-run-id ${runId} to recover from the cached step outputs instead.`
            )
          );
        } else {
          console.error(chalk.red(`Error: ${message}`));
        }
      } else {
        console.error(chalk.red(`Error: ${message}`));
      }
      process.exit(1);
    }

    if (result.status === 'completed') {
      console.log(chalk.green('\nWorkflow completed successfully.'));
      process.exit(0);
    } else {
      console.error(chalk.red(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`));
      process.exit(1);
    }
    return;
  }

  // ── Normal / validate / dry-run mode ──────────────────────────────────────
  let workflowName: string | undefined;

  const workflowIdx = args.indexOf('--workflow');
  if (workflowIdx !== -1 && args[workflowIdx + 1]) {
    workflowName = args[workflowIdx + 1];
  }

  let startFromStep: string | undefined;
  const startFromIdx = args.indexOf('--start-from');
  if (startFromIdx !== -1 && args[startFromIdx + 1]) {
    startFromStep = args[startFromIdx + 1];
  }

  let previousRunId: string | undefined;
  const prevRunIdx = args.indexOf('--previous-run-id');
  if (prevRunIdx !== -1 && args[prevRunIdx + 1]) {
    previousRunId = args[prevRunIdx + 1];
  }

  if (!yamlPath) {
    console.error(chalk.red('Error: workflow YAML path is required'));
    printUsage();
    process.exit(1);
  }

  const isValidate = args.includes('--validate');
  const isDryRun = !!process.env.DRY_RUN;

  const config = await runner.parseYamlFile(yamlPath);

  if (isValidate) {
    const { validateWorkflow, formatValidationReport } = await import('./validator.js');
    const issues = validateWorkflow(config);
    console.log(formatValidationReport(issues, yamlPath));
    process.exit(issues.some((issue) => issue.severity === 'error') ? 1 : 0);
  }

  if (isDryRun) {
    const { formatDryRunReport } = await import('./dry-run-format.js');
    const report = runner.dryRun(config, workflowName);
    console.log(formatDryRunReport(report));
    process.exit(report.valid ? 0 : 1);
  }

  const executeOptions = startFromStep ? { startFrom: startFromStep, previousRunId } : undefined;
  const result = await runWithListr(runner, config, workflowName, executeOptions);

  if (result.status === 'completed') {
    console.log(chalk.green('\nWorkflow completed successfully.'));
    process.exit(0);
  } else {
    console.error(chalk.red(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`));
    process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(chalk.red(`Error: ${err.message}`));
  process.exit(1);
});
