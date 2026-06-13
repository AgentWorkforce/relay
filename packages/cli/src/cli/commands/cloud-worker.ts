import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { Command, Option } from 'commander';

import {
  cloudWorkerStateDir,
  registerCloudWorker,
  resolveCloudWorkerRecord,
  runCloudWorkerLoop,
  upsertCloudWorkerRecord,
  type CloudWorkerRecord,
  type ExecuteWorkerAssignment,
  type WorkerWorkflowPayload,
} from '@agent-relay/cloud';

import { defaultExit } from '../lib/exit.js';

type ExitFn = (code: number) => never;

export interface CloudWorkerDependencies {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  env: NodeJS.ProcessEnv;
  spawnProcess: typeof spawn;
  now: () => Date;
  cwd: () => string;
  resolveRelayflowsCliEntrypoint: () => string;
}

const nodeRequire = createRequire(import.meta.url);

function withDefaults(overrides: Partial<CloudWorkerDependencies> = {}): CloudWorkerDependencies {
  return {
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    env: process.env,
    spawnProcess: spawn,
    now: () => new Date(),
    cwd: () => process.cwd(),
    resolveRelayflowsCliEntrypoint: () => nodeRequire.resolve('@relayflows/cli'),
    ...overrides,
  };
}

function safeFileName(value: string): string {
  const base = path.basename(value.trim() || 'workflow.yaml');
  return base.replace(/[^A-Za-z0-9._-]/g, '_') || 'workflow.yaml';
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function unsupportedReasons(payload: WorkerWorkflowPayload): string[] {
  const reasons: string[] = [];
  if (payload.s3CodeKey) {
    reasons.push('s3CodeKey code mount');
  }
  if (payload.paths?.length) {
    reasons.push('multi-path code mounts');
  }
  return reasons;
}

async function writeSecretFile(filePath: string, content: string): Promise<void> {
  await fsp.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  await fsp.chmod(filePath, 0o600).catch(() => undefined);
}

function buildWorkerRuntimeEnv(
  payload: WorkerWorkflowPayload,
  deps: CloudWorkerDependencies
): NodeJS.ProcessEnv {
  return {
    ...deps.env,
    ...payload.envSecrets,
    AGENT_RELAY_CLOUD_WORKER_RUN_ID: payload.runId,
    RELAY_WORKSPACE_ID: payload.relayWorkspaceId,
    RELAY_API_KEY: payload.relaycastApiKey,
    RELAYCAST_API_KEY: payload.relaycastApiKey,
    ...(payload.relaycastBaseUrl ? { RELAYCAST_BASE_URL: payload.relaycastBaseUrl } : {}),
    RELAYFILE_URL: payload.relayfileUrl,
    RELAYFILE_TOKEN: payload.relayfileToken,
  };
}

function relayflowsArgs(
  relayflowsCli: string,
  workflowPath: string,
  payload: WorkerWorkflowPayload
): string[] {
  return [
    relayflowsCli,
    'run',
    workflowPath,
    ...(payload.resumeRunId ? ['--resume', payload.resumeRunId] : []),
    ...(payload.startFrom ? ['--start-from', payload.startFrom] : []),
    ...(payload.previousRunId ? ['--previous-run-id', payload.previousRunId] : []),
  ];
}

async function runChild(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  deps: CloudWorkerDependencies;
  signal: AbortSignal;
}): Promise<{ exitCode: number; durationMs: number }> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = input.deps.spawnProcess(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: 'inherit',
    });

    const stop = () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    };

    input.signal.addEventListener('abort', stop, { once: true });

    child.on('error', (error) => {
      input.signal.removeEventListener('abort', stop);
      reject(error);
    });

    child.on('exit', (code, signal) => {
      input.signal.removeEventListener('abort', stop);
      const exitCode = code ?? (signal ? 1 : 0);
      resolve({ exitCode, durationMs: Date.now() - startedAt });
    });
  });
}

export function createDefaultAssignmentRunner(deps: CloudWorkerDependencies): ExecuteWorkerAssignment {
  return async ({ payload, signal }) => {
    const unsupported = unsupportedReasons(payload);
    if (unsupported.length > 0) {
      throw new Error(`Unsupported worker assignment payload: ${unsupported.join(', ')}`);
    }

    // Cloud owns assignment control-plane semantics. relayflows owns execution.
    // This boundary only materializes the Cloud payload into a local workflow
    // file/env and then invokes relayflows with the equivalent run flags.
    const runDir = path.join(cloudWorkerStateDir(deps.env), 'runs', payload.runId);
    await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(runDir, 0o700).catch(() => undefined);

    const workflowPath = path.join(runDir, safeFileName(payload.workflowFileName));
    await writeSecretFile(workflowPath, payload.workflow);

    const relayflowsCli = deps.resolveRelayflowsCliEntrypoint();
    const keepRunDir = deps.env.AGENT_RELAY_WORKER_KEEP_RUN_DIR === '1';
    try {
      const result = await runChild({
        command: process.execPath,
        args: relayflowsArgs(relayflowsCli, workflowPath, payload),
        cwd: runDir,
        env: buildWorkerRuntimeEnv(payload, deps),
        deps,
        signal,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Workflow runner exited with code ${result.exitCode}`);
      }

      return {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        summary: `Workflow ${payload.runId} completed.`,
      };
    } finally {
      if (!keepRunDir) {
        await fsp.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

async function startDaemon(input: {
  worker: CloudWorkerRecord;
  options: { baseUrl?: string; workerId?: string; name?: string; once?: boolean };
  deps: CloudWorkerDependencies;
}): Promise<CloudWorkerRecord> {
  const stateDir = cloudWorkerStateDir(input.deps.env);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, `${input.worker.workerId}.log`);
  const logFd = fs.openSync(logPath, 'a');
  let child: ChildProcess;
  const args = [
    process.argv[1] ?? 'agent-relay',
    'cloud',
    'worker',
    'start',
    '--worker-id',
    input.worker.workerId,
    '--base-url',
    input.worker.baseUrl,
    '--foreground-child',
    ...(input.options.once ? ['--once'] : []),
  ];

  try {
    child = input.deps.spawnProcess(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: input.deps.env,
    });
  } finally {
    fs.closeSync(logFd);
  }

  child.unref();
  const next: CloudWorkerRecord = {
    ...input.worker,
    pid: child.pid,
    logPath,
    updatedAt: input.deps.now().toISOString(),
  };
  upsertCloudWorkerRecord(next, input.deps.env);
  return next;
}

async function tailLog(
  filePath: string,
  input: { follow?: boolean; deps: CloudWorkerDependencies }
): Promise<void> {
  let offset = 0;
  while (true) {
    const handle = await fsp.open(filePath, 'r').catch((error: unknown) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      throw error;
    });
    if (handle) {
      try {
        const stat = await handle.stat();
        if (stat.size > offset) {
          const buffer = Buffer.alloc(stat.size - offset);
          const read = await handle.read(buffer, 0, buffer.length, offset);
          process.stdout.write(buffer.subarray(0, read.bytesRead).toString('utf-8'));
          offset = stat.size;
        }
      } finally {
        await handle.close();
      }
    }
    if (!input.follow) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export function registerCloudWorkerCommands(
  cloudCommand: Command,
  overrides: Partial<CloudWorkerDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  const workerCommand = cloudCommand.command('worker').description('Manage Agent Relay Cloud workers');

  workerCommand
    .command('register')
    .description('Register this machine as an Agent Relay Cloud worker')
    .requiredOption('--token <token>', 'Worker enrollment token')
    .requiredOption('--name <name>', 'Worker name')
    .option('--base-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(async (options: { token: string; name: string; baseUrl?: string; json?: boolean }) => {
      const record = await registerCloudWorker({
        enrollmentToken: options.token,
        name: options.name,
        baseUrl: options.baseUrl,
        env: deps.env,
        hostInfo: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          node: process.version,
        },
      });

      if (options.json) {
        deps.log(JSON.stringify({ ...record, workerToken: undefined }, null, 2));
        return;
      }

      deps.log(`Registered worker ${record.name} (${record.workerId})`);
      deps.log(`Start: agent-relay cloud worker start --worker-id ${record.workerId}`);
    });

  workerCommand
    .command('start')
    .description('Start the Cloud worker loop')
    .option('--base-url <url>', 'Cloud API base URL')
    .option('--worker-id <id>', 'Stored worker id to start')
    .option('--name <name>', 'Stored worker name to start')
    .option('--daemon', 'Run in the background and write local daemon logs', false)
    .option('--once', 'Process one assignment, then exit', false)
    .addOption(new Option('--foreground-child', 'Internal flag used by --daemon').hideHelp().default(false))
    .action(
      async (options: {
        baseUrl?: string;
        workerId?: string;
        name?: string;
        daemon?: boolean;
        once?: boolean;
        foregroundChild?: boolean;
      }) => {
        const worker = resolveCloudWorkerRecord({
          baseUrl: options.baseUrl,
          workerId: options.workerId,
          name: options.name,
          env: deps.env,
        });

        if (options.daemon && !options.foregroundChild) {
          const daemonRecord = await startDaemon({ worker, options, deps });
          deps.log(`Cloud worker daemon started: ${daemonRecord.pid}`);
          deps.log(`Logs: ${daemonRecord.logPath}`);
          return;
        }

        deps.log(`Starting cloud worker ${worker.name} (${worker.workerId})`);
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        try {
          await runCloudWorkerLoop({
            worker,
            once: options.once,
            signal: controller.signal,
            executeAssignment: createDefaultAssignmentRunner(deps),
            log: (message) => deps.log(message),
          });
        } finally {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
        }
      }
    );

  workerCommand
    .command('status')
    .description('Show local Cloud worker status')
    .option('--base-url <url>', 'Cloud API base URL')
    .option('--worker-id <id>', 'Stored worker id')
    .option('--name <name>', 'Stored worker name')
    .option('--json', 'Print raw JSON response', false)
    .action(async (options: { baseUrl?: string; workerId?: string; name?: string; json?: boolean }) => {
      const record = resolveCloudWorkerRecord({
        baseUrl: options.baseUrl,
        workerId: options.workerId,
        name: options.name,
        env: deps.env,
      });
      const localDaemonRunning = isProcessRunning(record.pid);
      const payload = {
        baseUrl: record.baseUrl,
        workerId: record.workerId,
        name: record.name,
        localDaemon: {
          pid: record.pid,
          running: localDaemonRunning,
          logPath: record.logPath,
        },
        cloudLiveness: 'unknown' as const,
      };
      if (options.json) {
        deps.log(JSON.stringify(payload, null, 2));
        return;
      }
      deps.log(`Worker: ${payload.name} (${payload.workerId})`);
      deps.log(`API URL: ${payload.baseUrl}`);
      deps.log(`Local daemon: ${localDaemonRunning ? `running (pid ${record.pid})` : 'not running'}`);
      if (record.logPath) deps.log(`Logs: ${record.logPath}`);
      deps.log(
        'Cloud liveness: unknown (worker-token status only; heartbeat/queue update Cloud when running)'
      );
    });

  workerCommand
    .command('logs')
    .description('Read local Cloud worker daemon logs')
    .option('--base-url <url>', 'Cloud API base URL')
    .option('--worker-id <id>', 'Stored worker id')
    .option('--name <name>', 'Stored worker name')
    .option('--follow', 'Follow local daemon logs', false)
    .action(async (options: { baseUrl?: string; workerId?: string; name?: string; follow?: boolean }) => {
      const record = resolveCloudWorkerRecord({
        baseUrl: options.baseUrl,
        workerId: options.workerId,
        name: options.name,
        env: deps.env,
      });
      if (!record.logPath) {
        throw new Error('No local daemon log path is stored for this worker.');
      }
      await tailLog(record.logPath, { follow: options.follow, deps });
    });
}
