import path from 'node:path';
import readline from 'node:readline';
import { spawn as spawnProcess } from 'node:child_process';
import { Command } from 'commander';
import { getProjectPaths } from '@agent-relay/config';
import { readBrokerConnection } from '../lib/broker-lifecycle.js';
import {
  enableTelemetry,
  disableTelemetry,
  getStatus,
  isDisabledByEnv,
  track,
  type WorkflowFileType as TelemetryWorkflowFileType,
} from '@agent-relay/telemetry';
import {
  runWorkflow,
  runScriptWorkflow,
  ensureLocalSdkWorkflowRuntime,
  findLocalSdkWorkspace,
  parseTsxStderr,
  formatWorkflowParseError,
  type ParsedWorkflowError,
} from '@agent-relay/sdk/workflows';
import type { WorkflowEvent } from '@agent-relay/sdk/workflows';
import { CliExit, defaultExit } from '../lib/exit.js';
import { errorClassName } from '../lib/telemetry-helpers.js';

export {
  ensureLocalSdkWorkflowRuntime,
  findLocalSdkWorkspace,
  parseTsxStderr,
  formatWorkflowParseError,
  type ParsedWorkflowError,
};

type ExitFn = (code: number) => never;
type RunInitOptions = {
  yes?: boolean;
  skipBroker?: boolean;
};
type RunWorkflowOptions = {
  workflow?: string;
  dryRun?: boolean;
  resume?: string;
  startFrom?: string;
  previousRunId?: string;
};
type WorkflowRunResult = {
  id?: string;
  status: string;
  error?: string;
};

export interface SetupDependencies {
  runInit: (options: RunInitOptions) => Promise<void>;
  runTelemetry: (action?: string) => Promise<void> | void;
  runYamlWorkflow: (
    filePath: string,
    options: {
      workflow?: string;
      dryRun?: boolean;
      resume?: string;
      startFrom?: string;
      previousRunId?: string;
      onEvent: (event: WorkflowEvent) => void;
    }
  ) => Promise<WorkflowRunResult>;
  runScriptWorkflow: (
    filePath: string,
    options?: { dryRun?: boolean; resume?: string; startFrom?: string; previousRunId?: string }
  ) => void | Promise<void>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
interface SetupIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
function withDefaults(overrides: Partial<SetupDependencies> = {}): SetupDependencies {
  const log = overrides.log ?? ((...args: unknown[]) => console.log(...args));
  const error = overrides.error ?? ((...args: unknown[]) => console.error(...args));
  const exit = overrides.exit ?? defaultExit;
  const io: SetupIo = { log, error, exit };
  return {
    runInit: overrides.runInit ?? ((options: RunInitOptions) => runInitDefault(options, io)),
    runTelemetry: overrides.runTelemetry ?? ((action?: string) => runTelemetryDefault(action, io)),
    runYamlWorkflow: runYamlWorkflowDefault,
    runScriptWorkflow,
    log,
    error,
    exit,
    ...overrides,
  };
}
function logWorkflowEvent(event: WorkflowEvent, log: (...args: unknown[]) => void): void {
  if (event.type === 'broker:event') return;
  const prefix = event.type.startsWith('run:') ? '[run]' : '[step]';
  const name = 'stepName' in event ? `${event.stepName} ` : '';
  const status = event.type.split(':')[1];
  const detail = 'error' in event ? `: ${event.error}` : '';
  log(`${prefix} ${name}${status}${detail}`);
}
async function runYamlWorkflowDefault(
  filePath: string,
  options: {
    workflow?: string;
    dryRun?: boolean;
    resume?: string;
    startFrom?: string;
    previousRunId?: string;
    onEvent: (event: WorkflowEvent) => void;
  }
): Promise<WorkflowRunResult> {
  const result = await runWorkflow(filePath, options);
  // DryRunReport has 'valid' instead of 'status'
  if ('valid' in result) {
    const report = result as unknown as { valid: boolean; errors: string[] };
    return { status: report.valid ? 'dry-run' : 'failed', error: report.errors.join('; ') || undefined };
  }
  return result;
}
async function runInitDefault(options: RunInitOptions, io: SetupIo): Promise<void> {
  const prompt = async (question: string, defaultYes = true): Promise<boolean> => {
    if (options.yes) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} ${suffix} `, resolve);
    });
    rl.close();
    const normalized = answer.toLowerCase().trim();
    if (!normalized) return defaultYes;
    return normalized === 'y' || normalized === 'yes';
  };
  const yesFlag = Boolean(options.yes);
  const skipBrokerFlag = Boolean(options.skipBroker);
  io.log('');
  io.log('  ╭─────────────────────────────────────╮');
  io.log('  │                                     │');
  io.log('  │   🚀 Agent Relay - First Time Setup │');
  io.log('  │                                     │');
  io.log('  │   Real-time AI agent communication  │');
  io.log('  │                                     │');
  io.log('  ╰─────────────────────────────────────╯');
  io.log('');
  const isCloud = !!process.env.WORKSPACE_ID;
  if (isCloud) {
    io.log('  ℹ  Detected: Cloud workspace');
    io.log('     MCP tools are pre-configured in cloud environments.');
    io.log('');
    track('setup_init', {
      is_cloud: true,
      broker_was_running: false,
      user_started_broker: false,
      yes_flag: yesFlag,
      skip_broker: skipBrokerFlag,
    });
    return;
  }
  io.log('  ℹ  Detected: Local environment');
  io.log('');
  const paths = getProjectPaths();
  let brokerRunning = false;
  const conn = readBrokerConnection(paths.dataDir);
  if (conn && conn.pid > 0) {
    try {
      process.kill(conn.pid, 0);
      brokerRunning = true;
    } catch {
      // Process dead — stale connection file
    }
  }
  const brokerWasRunning = brokerRunning;
  let userStartedBroker = false;
  if (brokerRunning) {
    io.log('  ✓  Broker is already running');
  } else {
    io.log('  ○  Broker is not running');
  }
  io.log('');
  const skipBrokerStartup = options.skipBroker ?? false;
  if (!brokerRunning && !skipBrokerStartup) {
    io.log('  ┌─ Start the Relay Broker ──────────────────────────────────┐');
    io.log('  │                                                          │');
    io.log('  │  The broker manages agent connections and message        │');
    io.log('  │  routing. It runs in the background.                     │');
    io.log('  │                                                          │');
    io.log('  └──────────────────────────────────────────────────────────┘');
    io.log('');
    const shouldStartBroker = await prompt('  Start the relay broker now?');
    if (shouldStartBroker) {
      io.log('');
      io.log('  Starting broker...');
      const brokerProcess = spawnProcess(process.execPath, [process.argv[1], 'up', '--background'], {
        detached: true,
        stdio: 'ignore',
      });
      brokerProcess.unref();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      io.log('  ✓  Broker started in background');
      io.log('');
      brokerRunning = true;
      userStartedBroker = true;
    }
  }
  io.log('  ╭─────────────────────────────────────────────────────────╮');
  io.log('  │                    Setup Complete!                      │');
  io.log('  ╰─────────────────────────────────────────────────────────╯');
  io.log('');
  if (brokerRunning) {
    io.log('  Status:');
    io.log('    ✓  Broker running');
    io.log('');
  }
  io.log('  Quick Start:');
  io.log('');
  io.log('    1. Open Claude Code (or Cursor)');
  io.log('');
  io.log('    2. The relay tools are ready! Try asking Claude:');
  io.log('       "Use mcp__relaycast__agent_list to see online agents"');
  io.log('');
  io.log('    3. Spawn a worker agent:');
  io.log('       "Spawn a worker named TestRunner to run the tests"');
  io.log('');
  io.log('  Commands:');
  io.log('    agent-relay up        Start broker with dashboard');
  io.log('    agent-relay status    Check broker status');
  io.log('    agent-relay who       List online agents');
  io.log('');
  io.log('  Dashboard: http://localhost:3888 (when broker is running)');
  io.log('');
  track('setup_init', {
    is_cloud: false,
    broker_was_running: brokerWasRunning,
    user_started_broker: userStartedBroker,
    yes_flag: yesFlag,
    skip_broker: skipBrokerFlag,
  });
}
function runTelemetryDefault(action: string | undefined, io: SetupIo): void {
  if (action === 'enable') {
    if (isDisabledByEnv()) {
      io.log('Cannot enable: AGENT_RELAY_TELEMETRY_DISABLED or DO_NOT_TRACK is set');
      io.log('Remove the environment variable to enable telemetry.');
      return;
    }
    enableTelemetry();
    io.log('Telemetry enabled');
    io.log('Anonymous usage data will be collected to improve Agent Relay.');
    return;
  }
  if (action === 'disable') {
    disableTelemetry();
    io.log('Telemetry disabled');
    io.log('No usage data will be collected.');
    return;
  }
  const status = getStatus();
  io.log('Telemetry Status');
  io.log('================');
  io.log(`Enabled: ${status.enabled ? 'Yes' : 'No'}`);
  if (status.disabledByEnv) {
    io.log('(Disabled via AGENT_RELAY_TELEMETRY_DISABLED or DO_NOT_TRACK environment variable)');
  }
  io.log(`Anonymous ID: ${status.anonymousId}`);
  if (status.notifiedAt) {
    io.log(`First run notice shown: ${new Date(status.notifiedAt).toLocaleString()}`);
  }
  io.log('');
  io.log('Commands:');
  io.log('  agent-relay telemetry enable   - Opt in to telemetry');
  io.log('  agent-relay telemetry disable  - Opt out of telemetry');
  io.log('');
  io.log('Learn more: https://agentrelay.com/telemetry');
}
export function registerSetupCommands(program: Command, overrides: Partial<SetupDependencies> = {}): void {
  const deps = withDefaults(overrides);
  program
    .command('init', { hidden: true })
    .description('First-time setup wizard - start broker')
    .option('-y, --yes', 'Accept all defaults (non-interactive)')
    .option('--skip-broker', 'Skip broker startup prompt')
    .addHelpText('after', '\nBREAKING CHANGE: daemon options were removed. Use broker terminology only.')
    .action(async (options: RunInitOptions) => {
      await deps.runInit(options);
    });
  program
    .command('setup', { hidden: true })
    .description('Alias for "init" - first-time setup wizard')
    .option('-y, --yes', 'Accept all defaults')
    .option('--skip-broker', 'Skip broker startup')
    .addHelpText('after', '\nBREAKING CHANGE: daemon options were removed. Use broker terminology only.')
    .action(async (options: RunInitOptions) => {
      await deps.runInit(options);
    });
  program
    .command('telemetry')
    .description('Manage anonymous telemetry (enable/disable/status)')
    .argument('[action]', 'Action: enable, disable, or status (default: status)')
    .action(async (action?: string) => {
      await deps.runTelemetry(action);
    });
  program
    .command('run')
    .description('Run a workflow file (YAML, TypeScript, or Python)')
    .argument('<file>', 'Path to workflow file (.yaml, .yml, .ts, or .py)')
    .option('-w, --workflow <name>', 'Run a specific workflow by name (default: first, YAML only)')
    .option('--dry-run', 'Validate workflow and show execution plan without running')
    .option('--resume <runId>', 'Resume a previously failed workflow run from where it left off')
    .option('--start-from <step>', 'Start from a specific step and skip predecessor steps')
    .option('--previous-run-id <runId>', 'Use cached outputs from a previous run when starting from a step')
    .action(async (filePath: string, options: RunWorkflowOptions) => {
      const ext = path.extname(filePath).toLowerCase();
      const isScriptWorkflow = ext === '.ts' || ext === '.tsx' || ext === '.py';
      const fileType: TelemetryWorkflowFileType =
        ext === '.yaml' || ext === '.yml'
          ? 'yaml'
          : ext === '.ts' || ext === '.tsx'
            ? 'ts'
            : ext === '.py'
              ? 'py'
              : 'unknown';
      const started = Date.now();
      let tracked = false;
      const emit = (result: { success: boolean; errorClass?: string }): void => {
        if (tracked) return;
        tracked = true;
        track('workflow_run', {
          file_type: fileType,
          is_dry_run: Boolean(options.dryRun),
          is_resume: Boolean(options.resume),
          is_start_from: Boolean(options.startFrom),
          is_script: isScriptWorkflow,
          success: result.success,
          duration_ms: Date.now() - started,
          ...(result.errorClass ? { error_class: result.errorClass } : {}),
        });
      };

      try {
        if (ext === '.yaml' || ext === '.yml') {
          if (options.resume) {
            deps.log(`Resuming workflow run ${options.resume} from ${filePath}...`);
            const result = await deps.runYamlWorkflow(filePath, {
              workflow: options.workflow,
              resume: options.resume,
              onEvent: (event: WorkflowEvent) => logWorkflowEvent(event, deps.log),
            });
            if (result.status === 'completed') {
              deps.log('\nWorkflow resumed and completed successfully.');
              emit({ success: true });
            } else {
              deps.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
              deps.error(
                `Run ID: ${result.id} — resume with: agent-relay run ${filePath} --resume ${result.id}`
              );
              emit({ success: false, errorClass: 'WorkflowNotCompleted' });
              deps.exit(1);
            }
            return;
          }
          if (options.dryRun) {
            deps.log(`Dry run: validating workflow from ${filePath}...`);
          } else {
            deps.log(`Running workflow from ${filePath}...`);
          }
          const result = await deps.runYamlWorkflow(filePath, {
            workflow: options.workflow,
            dryRun: options.dryRun,
            resume: options.resume,
            startFrom: options.startFrom,
            previousRunId: options.previousRunId,
            onEvent: (event: WorkflowEvent) => logWorkflowEvent(event, deps.log),
          });
          if (options.dryRun) {
            // Report was already printed by runWorkflow
            emit({ success: true });
            return;
          }
          if (result.status === 'completed') {
            deps.log('\nWorkflow completed successfully.');
            emit({ success: true });
          } else {
            deps.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
            deps.error(
              `Run ID: ${result.id} — resume with: agent-relay run ${filePath} --resume ${result.id}`
            );
            emit({ success: false, errorClass: 'WorkflowNotCompleted' });
            deps.exit(1);
          }
          return;
        }
        if (ext === '.ts' || ext === '.tsx' || ext === '.py') {
          deps.log(`Running workflow script ${filePath}...`);
          await deps.runScriptWorkflow(filePath, {
            dryRun: options.dryRun,
            resume: options.resume,
            startFrom: options.startFrom,
            previousRunId: options.previousRunId,
          });
          emit({ success: true });
          return;
        }
        deps.error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
        emit({ success: false, errorClass: 'UnsupportedFileType' });
        deps.exit(1);
      } catch (err: any) {
        // `deps.exit(1)` above throws `CliExit` in production so runCli can
        // flush telemetry — let that bubble straight through instead of
        // treating it as an unexpected error (which would print the internal
        // "cli-exit:1" message and clobber `error_class` with 'CliExit').
        if (err instanceof CliExit) throw err;
        emit({ success: false, errorClass: errorClassName(err) });
        deps.error(`Error: ${err.message}`);
        if (isScriptWorkflow) {
          const runIdMatch = typeof err?.message === 'string' ? err.message.match(/Run ID:\s*(\S+)/) : null;
          if (runIdMatch?.[1]) {
            deps.error(
              `Run ID: ${runIdMatch[1]} — resume with: agent-relay run ${filePath} --resume ${runIdMatch[1]}`
            );
          }
          deps.error(
            `Script workflows can be retried with:
` +
              `  agent-relay run ${filePath} --resume <run-id>
` +
              `or start from a specific step with:
` +
              `  agent-relay run ${filePath} --start-from <step> [--previous-run-id <run-id>]`
          );
        }
        deps.exit(1);
      }
    });
}
