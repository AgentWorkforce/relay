import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { Command } from 'commander';
import { transformSync } from 'esbuild';
import { getProjectPaths } from '@agent-relay/config';
import { readBrokerConnection } from '../lib/broker-lifecycle.js';
import { enableTelemetry, disableTelemetry, getStatus, isDisabledByEnv } from '@agent-relay/telemetry';
import { runWorkflow } from '@agent-relay/sdk/workflows';
import type { WorkflowEvent } from '@agent-relay/sdk/workflows';
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

type LocalSdkWorkspace = {
  rootDir: string;
  sdkDir: string;
};

type ExecFileSyncLike = typeof execFileSync;
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
  ) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
interface SetupIo {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}
function defaultExit(code: number): never {
  process.exit(code);
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
    runScriptWorkflow: runScriptFile,
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
export function findLocalSdkWorkspace(startDir: string): LocalSdkWorkspace | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    const sdkDir = path.join(current, 'packages', 'sdk');
    const sdkPackageJsonPath = path.join(sdkDir, 'package.json');

    try {
      if (fs.existsSync(packageJsonPath) && fs.existsSync(sdkPackageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: string };
        const sdkPkg = JSON.parse(fs.readFileSync(sdkPackageJsonPath, 'utf8')) as { name?: string };
        if (pkg.name === 'agent-relay' && sdkPkg.name === '@agent-relay/sdk') {
          return { rootDir: current, sdkDir };
        }
      }
    } catch {
      // Ignore parse/read errors and continue walking upward.
    }

    if (current === root) return null;
    current = path.dirname(current);
  }
}

export function ensureLocalSdkWorkflowRuntime(
  startDir: string,
  execRunner: ExecFileSyncLike = execFileSync
): void {
  const workspace = findLocalSdkWorkspace(startDir);
  if (!workspace) return;

  const workflowsEntry = path.join(workspace.sdkDir, 'dist', 'workflows', 'index.js');
  if (fs.existsSync(workflowsEntry)) return;

  console.log(
    '[agent-relay] Detected local @agent-relay/sdk workspace without built workflows runtime; building packages/sdk...'
  );
  execRunner('npm', ['run', 'build:sdk'], {
    cwd: workspace.rootDir,
    stdio: 'inherit',
    env: process.env,
  });

  if (!fs.existsSync(workflowsEntry)) {
    throw new Error(`Local SDK workflows runtime is still missing after build: ${workflowsEntry}`);
  }
}

/**
 * Pre-parse a TypeScript workflow file with esbuild to catch template-literal
 * and syntax errors before handing off to tsx. Wraps the raw esbuild error
 * with hints targeting the most common mistakes in workflow `command:` /
 * `task:` blocks — raw backticks in prose, unescaped `${...}` that was meant
 * as a shell variable, etc.
 *
 * These all produce cryptic esbuild errors (`Expected "}" but found "<word>"`,
 * `Unterminated template literal`) that don't hint at the actual cause when
 * you're writing workflow files.
 */
export function preParseWorkflowFile(filePath: string): void {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read workflow file ${filePath}: ${(err as Error).message}`);
  }

  try {
    transformSync(source, {
      loader: 'ts',
      sourcemap: false,
      logLevel: 'silent',
    });
    return;
  } catch (err) {
    const errors = (err as { errors?: EsbuildError[] }).errors;
    if (!Array.isArray(errors) || errors.length === 0) {
      throw err;
    }
    throw formatWorkflowParseError(filePath, errors[0]!);
  }
}

interface EsbuildError {
  text: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
    lineText?: string;
  };
}

function formatWorkflowParseError(filePath: string, e: EsbuildError): Error {
  const loc = e.location ?? {};
  const where =
    loc.line !== undefined
      ? `${filePath}:${loc.line}${loc.column !== undefined ? `:${loc.column}` : ''}`
      : filePath;

  const hints: string[] = [];
  const text = e.text ?? '';

  if (/Expected "\}" but found/i.test(text) || /Unterminated template literal/i.test(text)) {
    hints.push(
      'Likely a JavaScript template literal metacharacter inside a `command:` or `task:` block. ' +
        'Inside workflow .ts files every `command: \\`...\\`` is a JavaScript template literal — ' +
        'backticks terminate it and `${...}` triggers JS interpolation before the shell ever sees the string.',
      'Fixes: use single quotes instead of backticks in prose/commit messages; ' +
        'for shell variables use `$VAR` (no braces) or escape as `\\${VAR}`; ' +
        'never write literal `\\n` inside a shell comment (it becomes a real newline).'
    );
  }

  if (/Unexpected "\$"/.test(text)) {
    hints.push(
      'Unexpected `$` inside a template literal usually means `${...}` was interpreted as JS interpolation. ' +
        'Escape it as `\\${...}` or drop the braces and use plain `$VAR`.'
    );
  }

  if (/Expected identifier/.test(text) && /template/i.test(text)) {
    hints.push(
      'A template literal interpolation `${...}` needs a valid JS expression inside. ' +
        'If you meant a shell variable, escape the `$` or drop the braces.'
    );
  }

  const lines = ['', `Workflow file failed to parse: ${where}`, `  ${text}`];
  if (loc.lineText) {
    lines.push(`  | ${loc.lineText}`);
    if (loc.column !== undefined && loc.column >= 0) {
      lines.push(`  | ${' '.repeat(loc.column)}^`);
    }
  }
  if (hints.length > 0) {
    lines.push('');
    for (const hint of hints) {
      lines.push(`Hint: ${hint}`);
    }
  }
  lines.push('');

  const wrapped = new Error(lines.join('\n'));
  (wrapped as Error & { code?: string }).code = 'WORKFLOW_PARSE_ERROR';
  return wrapped;
}

function runScriptFile(
  filePath: string,
  options: { dryRun?: boolean; resume?: string; startFrom?: string; previousRunId?: string } = {}
): void {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  const runIdFile = path.join(
    process.cwd(),
    '.agent-relay',
    `script-run-id-${process.pid}-${Date.now()}.txt`
  );
  try {
    fs.mkdirSync(path.dirname(runIdFile), { recursive: true });
  } catch {
    // Run-id hint is optional — don't abort if directory is not writable
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_RELAY_RUN_ID_FILE: runIdFile };
  if (options.dryRun) childEnv.DRY_RUN = 'true';
  if (options.resume) childEnv.RESUME_RUN_ID = options.resume;
  if (options.startFrom) childEnv.START_FROM = options.startFrom;
  if (options.previousRunId) childEnv.PREVIOUS_RUN_ID = options.previousRunId;

  const augmentErrorWithRunId = (err: any): never => {
    try {
      if (fs.existsSync(runIdFile)) {
        const runId = fs.readFileSync(runIdFile, 'utf8').trim();
        if (runId && typeof err?.message === 'string' && !err.message.includes('Run ID:')) {
          err.message += `
Run ID: ${runId}`;
        }
      }
    } catch {
      // Ignore run-id hint failures and preserve the original error.
    } finally {
      try {
        fs.rmSync(runIdFile, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
    }
    throw err;
  };
  const cleanupRunIdFile = () => {
    try {
      fs.rmSync(runIdFile, { force: true });
    } catch {
      /* ignore */
    }
  };

  if (ext === '.ts' || ext === '.tsx') {
    ensureLocalSdkWorkflowRuntime(path.dirname(resolved));

    // Pre-parse the file with esbuild so template-literal mistakes (raw
    // backticks inside prose, unescaped ${} in shell commands, etc.) fail
    // fast with an actionable error message instead of a cryptic tsx
    // TransformError dumped mid-run.
    try {
      preParseWorkflowFile(resolved);
    } catch (err) {
      cleanupRunIdFile();
      throw err;
    }

    const runners = ['tsx', 'ts-node'];
    for (const runner of runners) {
      try {
        execFileSync(runner, [resolved], { stdio: 'inherit', env: childEnv });
        cleanupRunIdFile();
        return;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          return augmentErrorWithRunId(err);
        }
      }
    }
    try {
      execFileSync('npx', ['tsx', resolved], { stdio: 'inherit', env: childEnv });
      cleanupRunIdFile();
    } catch (err: any) {
      return augmentErrorWithRunId(err);
    }
    return;
  }
  if (ext === '.py') {
    const runners = ['python3', 'python'];
    for (const runner of runners) {
      try {
        execFileSync(runner, [resolved], { stdio: 'inherit', env: childEnv });
        cleanupRunIdFile();
        return;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          return augmentErrorWithRunId(err);
        }
      }
    }
    cleanupRunIdFile();
    throw new Error('Python not found. Install Python 3.10+ to run .py workflow files.');
  }
  try {
    fs.rmSync(runIdFile, { force: true });
  } catch {
    // Ignore cleanup failure.
  }
  throw new Error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
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
}
function runTelemetryDefault(action: string | undefined, io: SetupIo): void {
  if (action === 'enable') {
    if (isDisabledByEnv()) {
      io.log('Cannot enable: AGENT_RELAY_TELEMETRY_DISABLED is set');
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
    io.log('(Disabled via AGENT_RELAY_TELEMETRY_DISABLED environment variable)');
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
      let isScriptWorkflow = false;
      try {
        const ext = path.extname(filePath).toLowerCase();
        isScriptWorkflow = ext === '.ts' || ext === '.tsx' || ext === '.py';
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
            } else {
              deps.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
              deps.error(
                `Run ID: ${result.id} — resume with: agent-relay run ${filePath} --resume ${result.id}`
              );
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
            return;
          }
          if (result.status === 'completed') {
            deps.log('\nWorkflow completed successfully.');
          } else {
            deps.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
            deps.error(
              `Run ID: ${result.id} — resume with: agent-relay run ${filePath} --resume ${result.id}`
            );
            deps.exit(1);
          }
          return;
        }
        if (ext === '.ts' || ext === '.tsx' || ext === '.py') {
          deps.log(`Running workflow script ${filePath}...`);
          deps.runScriptWorkflow(filePath, {
            dryRun: options.dryRun,
            resume: options.resume,
            startFrom: options.startFrom,
            previousRunId: options.previousRunId,
          });
          return;
        }
        deps.error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
        deps.exit(1);
      } catch (err: any) {
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
