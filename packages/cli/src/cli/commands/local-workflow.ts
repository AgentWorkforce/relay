import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Command, InvalidArgumentError } from 'commander';
import { build as esbuild } from 'esbuild';

import { defaultExit } from '../lib/exit.js';
import { errorClassName } from '../lib/telemetry-helpers.js';
import { track } from '../telemetry/index.js';

type ExitFn = (code: number) => never;

type LocalWorkflowFileType = 'ts' | 'js' | 'py' | 'sh' | 'yaml';
type LocalWorkflowRunStatus = 'starting' | 'running' | 'completed' | 'failed';

type LocalWorkflowRunRecord = {
  runId: string;
  status: LocalWorkflowRunStatus;
  workflow: string;
  workflowPath: string;
  fileType: LocalWorkflowFileType;
  cwd: string;
  runDir: string;
  logPath: string;
  metadataPath: string;
  command: string;
  args: string[];
  monitorPid?: number;
  childPid?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  syncMode: 'in-place';
};

type RunLocalWorkflowOptions = {
  fileType?: LocalWorkflowFileType;
};

export interface LocalWorkflowDependencies {
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  spawnProcess: typeof spawnProcess;
  buildTypeScriptEntrypoint: (entryPoint: string, outfile: string, cwd: string) => Promise<void>;
  randomRunId: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  isProcessRunning: (pid: number) => boolean;
  writeStdout: (text: string) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

const RUN_ID_RE = /^local_[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const TERMINAL_STATUSES = new Set<LocalWorkflowRunStatus>(['completed', 'failed']);

function withDefaults(overrides: Partial<LocalWorkflowDependencies> = {}): LocalWorkflowDependencies {
  return {
    cwd: () => process.cwd(),
    env: process.env,
    spawnProcess,
    buildTypeScriptEntrypoint: async (entryPoint, outfile, cwd) => {
      await esbuild({
        entryPoints: [entryPoint],
        outfile,
        absWorkingDir: cwd,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        packages: 'external',
        sourcemap: 'inline',
      });
    },
    randomRunId: () =>
      `local_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${randomBytes(4).toString('hex')}`,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isProcessRunning: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    writeStdout: (text) => process.stdout.write(text),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function parseLocalWorkflowFileType(value: string): LocalWorkflowFileType {
  if (value === 'ts' || value === 'js' || value === 'py' || value === 'sh' || value === 'yaml') {
    return value;
  }
  throw new InvalidArgumentError('Expected workflow type to be one of: ts, js, py, sh, yaml');
}

function inferLocalWorkflowFileType(filePath: string): LocalWorkflowFileType | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.py':
      return 'py';
    case '.sh':
      return 'sh';
    case '.yaml':
    case '.yml':
      return 'yaml';
    default:
      return null;
  }
}

function toTelemetryWorkflowFileType(
  fileType: LocalWorkflowFileType | null
): 'yaml' | 'ts' | 'py' | 'unknown' {
  if (fileType === 'yaml' || fileType === 'ts' || fileType === 'py') {
    return fileType;
  }
  return 'unknown';
}

function localRunsRoot(cwd: string): string {
  return path.join(cwd, '.agentworkforce', 'relay', 'local-runs');
}

function validateRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`Invalid local run id: ${runId}`);
  }
}

function runDirFor(cwd: string, runId: string): string {
  validateRunId(runId);
  return path.join(localRunsRoot(cwd), runId);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await fsp.rename(tmpPath, filePath);
}

async function readRunRecord(cwd: string, runId: string): Promise<LocalWorkflowRunRecord> {
  const metadataPath = path.join(runDirFor(cwd, runId), 'run.json');
  const raw = await fsp.readFile(metadataPath, 'utf-8').catch((error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`Local workflow run not found: ${runId}`);
    }
    throw error;
  });
  return JSON.parse(raw) as LocalWorkflowRunRecord;
}

async function refreshRunRecord(
  record: LocalWorkflowRunRecord,
  deps: LocalWorkflowDependencies
): Promise<LocalWorkflowRunRecord> {
  if (
    TERMINAL_STATUSES.has(record.status) ||
    !record.monitorPid ||
    deps.isProcessRunning(record.monitorPid)
  ) {
    return record;
  }

  const now = deps.now().toISOString();
  const next: LocalWorkflowRunRecord = {
    ...record,
    status: 'failed',
    exitCode: record.exitCode ?? null,
    signal: record.signal ?? null,
    error: record.error ?? 'Workflow monitor exited before recording completion.',
    updatedAt: now,
    finishedAt: record.finishedAt ?? now,
  };
  await writeJsonAtomic(record.metadataPath, next);
  return next;
}

function buildMonitorScript(input: {
  metadataPath: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}): string {
  return `import fs from 'node:fs';
import { spawn } from 'node:child_process';

const metadataPath = ${JSON.stringify(input.metadataPath)};
const command = ${JSON.stringify(input.command)};
const args = ${JSON.stringify(input.args)};
const cwd = ${JSON.stringify(input.cwd)};
const extraEnv = ${JSON.stringify(input.env)};

function readRecord() {
  return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
}

function writeRecord(patch) {
  const current = readRecord();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  const tmpPath = metadataPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\\n', 'utf-8');
  fs.renameSync(tmpPath, metadataPath);
}

writeRecord({ status: 'running', monitorPid: process.pid });

const child = spawn(command, args, {
  cwd,
  env: { ...process.env, ...extraEnv },
  stdio: 'inherit',
});

writeRecord({ childPid: child.pid ?? undefined });

function stopChild(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

process.on('SIGTERM', () => stopChild('SIGTERM'));
process.on('SIGINT', () => stopChild('SIGINT'));

child.on('error', (error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  writeRecord({
    status: 'failed',
    exitCode: 1,
    error: error instanceof Error ? error.message : String(error),
    finishedAt: new Date().toISOString(),
  });
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  writeRecord({
    status: exitCode === 0 ? 'completed' : 'failed',
    exitCode,
    signal: signal ?? null,
    finishedAt: new Date().toISOString(),
  });
  process.exit(exitCode);
});
`;
}

async function resolveLocalWorkflowCommand(
  workflowPath: string,
  fileType: LocalWorkflowFileType,
  runDir: string,
  cwd: string,
  deps: LocalWorkflowDependencies
): Promise<{ command: string; args: string[] }> {
  if (fileType === 'yaml') {
    throw new Error(
      'Local YAML workflow execution is not available in this CLI package yet. Use `agent-relay cloud run <file>` for YAML workflows, or use an executable TypeScript, JavaScript, Python, or shell workflow file locally.'
    );
  }

  if (fileType === 'ts') {
    const outfile = path.join(runDir, 'workflow-entry.mjs');
    await deps.buildTypeScriptEntrypoint(workflowPath, outfile, cwd);
    return { command: process.execPath, args: [outfile] };
  }

  if (fileType === 'js') {
    return { command: process.execPath, args: [workflowPath] };
  }

  if (fileType === 'py') {
    return { command: deps.env.PYTHON?.trim() || 'python3', args: [workflowPath] };
  }

  return { command: deps.env.SHELL?.trim() || '/bin/sh', args: [workflowPath] };
}

async function runLocalWorkflow(
  workflowArg: string,
  options: RunLocalWorkflowOptions,
  deps: LocalWorkflowDependencies
): Promise<LocalWorkflowRunRecord> {
  const cwd = deps.cwd();
  const workflowPath = path.resolve(cwd, workflowArg);
  const stat = await fsp.stat(workflowPath).catch((error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error(`Workflow file not found: ${workflowArg}`);
    }
    throw error;
  });
  if (!stat.isFile()) {
    throw new Error(`Workflow path is not a file: ${workflowArg}`);
  }

  const fileType = options.fileType ?? inferLocalWorkflowFileType(workflowPath);
  if (!fileType) {
    throw new Error(`Could not infer workflow type from ${workflowArg}. Use --file-type.`);
  }

  const runId = deps.randomRunId();
  const runDir = runDirFor(cwd, runId);
  await fsp.mkdir(runDir, { recursive: true });

  const { command, args } = await resolveLocalWorkflowCommand(workflowPath, fileType, runDir, cwd, deps);
  const now = deps.now().toISOString();
  const logPath = path.join(runDir, 'workflow.log');
  const metadataPath = path.join(runDir, 'run.json');
  const runnerPath = path.join(runDir, 'monitor.mjs');

  const record: LocalWorkflowRunRecord = {
    runId,
    status: 'starting',
    workflow: workflowArg,
    workflowPath,
    fileType,
    cwd,
    runDir,
    logPath,
    metadataPath,
    command,
    args,
    startedAt: now,
    updatedAt: now,
    syncMode: 'in-place',
  };

  await writeJsonAtomic(metadataPath, record);
  await fsp.writeFile(logPath, '', { flag: 'a' });
  await fsp.writeFile(
    runnerPath,
    buildMonitorScript({
      metadataPath,
      command,
      args,
      cwd,
      env: {
        AGENT_RELAY_LOCAL_RUN_ID: runId,
        AGENT_RELAY_WORKFLOW_FILE: workflowPath,
        AGENT_RELAY_WORKFLOW_RUN_DIR: runDir,
      },
    }),
    'utf-8'
  );

  const logFd = fs.openSync(logPath, 'a');
  let monitor: ChildProcess;
  try {
    monitor = deps.spawnProcess(process.execPath, [runnerPath], {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: deps.env,
    });
  } finally {
    fs.closeSync(logFd);
  }
  monitor.unref();

  const current = await readRunRecord(cwd, runId).catch(() => record);
  const next: LocalWorkflowRunRecord = {
    ...current,
    status: current.status === 'starting' ? 'running' : current.status,
    monitorPid: monitor.pid,
    updatedAt: deps.now().toISOString(),
  };
  await writeJsonAtomic(metadataPath, next);
  return next;
}

async function readLocalRunLogs(
  runId: string,
  options: { offset: number },
  deps: LocalWorkflowDependencies
): Promise<{
  content: string;
  offset: number;
  totalSize: number;
  done: boolean;
  record: LocalWorkflowRunRecord;
}> {
  const record = await refreshRunRecord(await readRunRecord(deps.cwd(), runId), deps);
  const stat = await fsp.stat(record.logPath).catch((error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { size: 0 };
    }
    throw error;
  });
  const totalSize = stat.size;
  const offset = Math.min(options.offset, totalSize);
  const length = Math.max(0, totalSize - offset);
  const handle = await fsp.open(record.logPath, 'r').catch((error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw error;
  });

  let content = '';
  if (handle && length > 0) {
    try {
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, offset);
      content = buffer.subarray(0, result.bytesRead).toString('utf-8');
    } finally {
      await handle.close();
    }
  }

  return {
    content,
    offset: totalSize,
    totalSize,
    done: TERMINAL_STATUSES.has(record.status),
    record,
  };
}

async function syncLocalRun(
  runId: string,
  deps: LocalWorkflowDependencies
): Promise<{ runId: string; status: LocalWorkflowRunStatus; hasChanges: false; message: string }> {
  const record = await refreshRunRecord(await readRunRecord(deps.cwd(), runId), deps);
  if (!TERMINAL_STATUSES.has(record.status)) {
    throw new Error(`Run is still ${record.status}. Wait for completion before syncing.`);
  }
  return {
    runId: record.runId,
    status: record.status,
    hasChanges: false,
    message: 'Local workflow ran in this checkout; no patch sync is required.',
  };
}

export function registerLocalWorkflowCommands(
  program: Command,
  overrides: Partial<LocalWorkflowDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  program
    .command('run')
    .description('Run an executable workflow file locally')
    .argument('<workflow>', 'Workflow file path (.ts, .js, .py, or .sh)')
    .option('--file-type <type>', 'Workflow type: ts, js, py, sh, or yaml', parseLocalWorkflowFileType)
    .option('--json', 'Print raw JSON response', false)
    .action(async (workflow: string, options: { fileType?: LocalWorkflowFileType; json?: boolean }) => {
      const started = Date.now();
      let success = false;
      let errorClass: string | undefined;
      try {
        const result = await runLocalWorkflow(workflow, options, deps);
        if (options.json) {
          deps.log(JSON.stringify(result, null, 2));
        } else {
          deps.log(`Run created: ${result.runId}`);
          deps.log(`Status: ${result.status}`);
          deps.log(`Logs: ${result.logPath}`);
          deps.log(`\nView logs:  agent-relay local logs ${result.runId} --follow`);
          deps.log(`Sync code:  agent-relay local sync ${result.runId}`);
        }
        success = true;
      } catch (err) {
        errorClass = errorClassName(err);
        throw err;
      } finally {
        track('workflow_run', {
          file_type: toTelemetryWorkflowFileType(options.fileType ?? inferLocalWorkflowFileType(workflow)),
          is_dry_run: false,
          is_resume: false,
          is_start_from: false,
          is_script: true,
          success,
          duration_ms: Date.now() - started,
          ...(errorClass ? { error_class: errorClass } : {}),
        });
      }
    });

  program
    .command('logs')
    .description('Read local workflow run logs')
    .argument('<runId>', 'Local workflow run id')
    .option('--follow', 'Poll until the run is done', false)
    .option('--poll-interval <seconds>', 'Polling interval while following', parsePositiveInteger, 2)
    .option('--offset <bytes>', 'Start reading logs from a byte offset', parseNonNegativeInteger, 0)
    .option('--json', 'Print raw JSON responses', false)
    .action(
      async (
        runId: string,
        options: { follow?: boolean; pollInterval?: number; offset?: number; json?: boolean }
      ) => {
        let offset = options.offset ?? 0;
        while (true) {
          const result = await readLocalRunLogs(runId, { offset }, deps);
          if (options.json) {
            deps.log(
              JSON.stringify(
                {
                  content: result.content,
                  offset: result.offset,
                  totalSize: result.totalSize,
                  done: result.done,
                  status: result.record.status,
                },
                null,
                2
              )
            );
          } else if (result.content) {
            deps.writeStdout(result.content);
          }

          offset = result.offset;
          if (!options.follow || result.done) {
            break;
          }

          await deps.sleep((options.pollInterval ?? 2) * 1000);
        }
      }
    );

  program
    .command('sync')
    .description('Finalize a local workflow run and report local sync state')
    .argument('<runId>', 'Local workflow run id')
    .option('--dry-run', 'Report sync state without taking action', false)
    .option('--json', 'Print raw JSON response', false)
    .action(async (runId: string, options: { dryRun?: boolean; json?: boolean }) => {
      const result = await syncLocalRun(runId, deps);
      if (options.json) {
        deps.log(JSON.stringify({ ...result, dryRun: Boolean(options.dryRun) }, null, 2));
        return;
      }
      deps.log(result.message);
    });
}
