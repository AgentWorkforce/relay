import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Command, Option } from 'commander';
import { extract } from 'tar';

import {
  cloudWorkerStateDir,
  downloadCloudWorkerAssignmentStorage,
  registerCloudWorker,
  resolveCloudWorkerRecord,
  runCloudWorkerLoop,
  upsertCloudWorkerRecord,
  type CloudWorkerRecord,
  type ExecuteWorkerAssignment,
  type WorkerWorkflowPayload,
} from '@agent-relay/cloud';

import { defaultExit } from '../lib/exit.js';
import { prepareWorkerAuthoredRuntime } from '../lib/cloud-worker-authored-runtime.js';
import {
  readWorkerEnrollmentToken,
  type WorkerEnrollmentTokenOptions,
  type WorkerEnrollmentTokenStream,
} from '../lib/cloud-worker-enrollment-token.js';
import { buildRelayflowsRunArgs, resolveAgentRelayCliChildCommand } from '../lib/agent-relay-cli-reentry.js';
import {
  isCliCredentialsPayload,
  cliLoginHome,
  materializeCliCredentials,
  removeLoginHome,
  writeBackCliCredentials,
  type MaterializedCliCredentials,
} from '../lib/cloud-worker-cli-credentials.js';

type ExitFn = (code: number) => never;

export interface CloudWorkerDependencies {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  env: NodeJS.ProcessEnv;
  spawnProcess: typeof spawn;
  now: () => Date;
  cwd: () => string;
  fetchImpl: typeof fetch;
  stdin?: WorkerEnrollmentTokenStream;
  resolveAgentRelayCliEntrypoint: () => string;
}

function withDefaults(overrides: Partial<CloudWorkerDependencies> = {}): CloudWorkerDependencies {
  return {
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    env: process.env,
    spawnProcess: spawn,
    now: () => new Date(),
    cwd: () => process.cwd(),
    fetchImpl: fetch,
    stdin: process.stdin,
    resolveAgentRelayCliEntrypoint: () => process.argv[1] ?? 'agent-relay',
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

async function writeSecretFile(filePath: string, content: string): Promise<void> {
  await fsp.writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  await fsp.chmod(filePath, 0o600).catch(() => undefined);
}

function safePathSegment(value: string): string {
  const cleaned = value.trim().replace(/\\/g, '/');
  const base = path.basename(cleaned || 'path');
  return base.replace(/[^A-Za-z0-9._-]/g, '_') || 'path';
}

function buildWorkerRuntimeEnv(
  payload: WorkerWorkflowPayload,
  deps: CloudWorkerDependencies,
  cliCredentialEnv: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...deps.env,
    ...payload.envSecrets,
    // Materialised subscription logins (CODEX_HOME/GROK_HOME pointing into the
    // run dir) win over anything inherited or delivered under those names.
    ...cliCredentialEnv,
    AGENT_RELAY_CLOUD_WORKER_RUN_ID: payload.runId,
    RELAY_WORKSPACE_ID: payload.relayWorkspaceId,
    RELAY_API_KEY: payload.relaycastApiKey,
    RELAYCAST_API_KEY: payload.relaycastApiKey,
    ...(payload.relaycastBaseUrl ? { RELAYCAST_BASE_URL: payload.relaycastBaseUrl } : {}),
    RELAYFILE_URL: payload.relayfileUrl,
    RELAYFILE_TOKEN: payload.relayfileToken,
  };
  if (payload.fileType === 'ts') {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!process.versions.bun && (major! < 22 || (major === 22 && minor! < 12))) {
      throw new Error('Authored worker assignments require Node.js 22.12 or newer, or Bun.');
    }
    // Node 22.14 needs this opt-in to import .flow.ts. Keep it scoped to
    // this assignment and inherited by the standalone Bun CLI's SDK Node child.
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --experimental-strip-types`.trim();
  }
  return env;
}

function assertFreshWorkerAssignment(payload: WorkerWorkflowPayload): void {
  const unsupportedSelectors = [
    payload.resumeRunId ? 'resumeRunId' : undefined,
    payload.startFrom ? 'startFrom' : undefined,
    payload.previousRunId ? 'previousRunId' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (unsupportedSelectors.length > 0) {
    throw new Error(
      `Cloud worker cannot execute state-bearing v2 assignment selectors: ${unsupportedSelectors.join(', ')}. ` +
        'Submit a fresh assignment; resume requires hosted v2 run state.'
    );
  }
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
    if (input.signal.aborted) {
      reject(new Error('The operation was aborted'));
      return;
    }

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

async function materializeArchive(input: {
  worker: CloudWorkerRecord;
  payload: WorkerWorkflowPayload;
  objectKey: string;
  destinationDir: string;
  archivePath: string;
  deps: CloudWorkerDependencies;
  signal: AbortSignal;
}): Promise<void> {
  const archive = await downloadCloudWorkerAssignmentStorage({
    worker: input.worker,
    runId: input.payload.runId,
    objectKey: input.objectKey,
    fetchImpl: input.deps.fetchImpl,
    signal: input.signal,
  });

  await fsp.mkdir(path.dirname(input.archivePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(input.archivePath, archive, { mode: 0o600 });
  await fsp.chmod(input.archivePath, 0o600).catch(() => undefined);
  await fsp.mkdir(input.destinationDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(input.destinationDir, 0o700).catch(() => undefined);
  await extract({
    file: input.archivePath,
    cwd: input.destinationDir,
    strict: true,
    preservePaths: false,
  });
}

async function materializeCodeMounts(input: {
  worker: CloudWorkerRecord;
  payload: WorkerWorkflowPayload;
  runDir: string;
  deps: CloudWorkerDependencies;
  signal: AbortSignal;
}): Promise<void> {
  const artifactsDir = path.join(input.runDir, '.cloud-worker-artifacts');
  if (input.payload.s3CodeKey) {
    await materializeArchive({
      ...input,
      objectKey: input.payload.s3CodeKey,
      destinationDir: input.runDir,
      archivePath: path.join(artifactsDir, 'code.tar.gz'),
    });
  }

  for (const entry of input.payload.paths ?? []) {
    await materializeArchive({
      ...input,
      objectKey: entry.s3CodeKey,
      destinationDir: path.join(input.runDir, 'paths', safePathSegment(entry.name)),
      archivePath: path.join(artifactsDir, 'paths', `${safePathSegment(entry.name)}.tar.gz`),
    });
  }
}

export function createDefaultAssignmentRunner(
  deps: CloudWorkerDependencies,
  options: { localAgent?: boolean } = {}
): ExecuteWorkerAssignment {
  return async ({ payload, worker, signal }) => {
    // Cloud owns assignment control-plane semantics. Relayflows owns execution.
    // This boundary materializes a fresh Cloud payload into a local workflow
    // directory/env and re-enters Relay's v2 `flows run` surface. State-bearing
    // assignments fail closed until the worker protocol carries hosted v2 state.
    assertFreshWorkerAssignment(payload);
    const runDir = path.join(cloudWorkerStateDir(deps.env), 'runs', payload.runId);
    const keepRunDir = deps.env.AGENT_RELAY_WORKER_KEEP_RUN_DIR === '1';
    const cliCredentials = isCliCredentialsPayload(payload.cliCredentials) ? payload.cliCredentials : null;
    let materialized: MaterializedCliCredentials | null = null;
    let writeBackDone = false;
    try {
      await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
      await fsp.chmod(runDir, 0o700).catch(() => undefined);
      await materializeCodeMounts({ worker, payload, runDir, deps, signal });

      const suppliedName = safeFileName(payload.workflowFileName);
      // The supported authored-flow SDK entrypoint recognizes *.flow.ts.
      // Control can supply an ordinary *.ts name; preserve its directory/body.
      const workflowName =
        payload.fileType === 'ts' ? `${suppliedName.replace(/(?:\.flow)?\.ts$/i, '')}.flow.ts` : suppliedName;
      const workflowPath = path.join(runDir, workflowName);
      await writeSecretFile(workflowPath, payload.workflow);
      if (payload.fileType === 'ts') await prepareWorkerAuthoredRuntime(workflowPath);

      if (cliCredentials) {
        materialized = await materializeCliCredentials({
          worker,
          credentials: cliCredentials,
          runDir,
          fetchImpl: deps.fetchImpl,
          signal,
          log: deps.log,
        });
      }

      const agentRelayCli = resolveAgentRelayCliChildCommand({
        execPath: process.execPath,
        cliEntrypoint: deps.resolveAgentRelayCliEntrypoint(),
        args: buildRelayflowsRunArgs(workflowPath, payload.fileType, options),
        cwd: deps.cwd(),
      });
      const result = await runChild({
        command: agentRelayCli.command,
        args: agentRelayCli.args,
        cwd: runDir,
        env: buildWorkerRuntimeEnv(payload, deps, materialized?.env),
        deps,
        signal,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Workflow runner exited with code ${result.exitCode}`);
      }

      const failedWriteBacks = await storeRefreshedLogins();
      return {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        summary: failedWriteBacks.length
          ? `Workflow ${payload.runId} completed. The refreshed ${failedWriteBacks.join(', ')} login could not be stored; sign in again if the next run fails.`
          : `Workflow ${payload.runId} completed.`,
      };
    } catch (error) {
      // A failed or cancelled run still stores a refreshed login (Grok rotates
      // its single-use refresh token), and says so when it could not.
      const failedWriteBacks = await storeRefreshedLogins();
      if (failedWriteBacks.length && error instanceof Error) {
        const warning = `The refreshed ${failedWriteBacks.join(', ')} login could not be stored; sign in again if the next run fails.`;
        // Assignment reports keep the first 500 characters: lead with the
        // warning when the original error would push it out.
        error.message =
          error.message.length + warning.length + 1 > 500
            ? `${warning} ${error.message}`
            : `${error.message} ${warning}`;
      }
      throw error;
    } finally {
      await storeRefreshedLogins();
      // The login files are removed even when the run directory is kept for
      // debugging, and even when materialisation failed partway.
      if (cliCredentials) {
        const loginHome = materialized?.home ?? cliLoginHome(runDir);
        await removeLoginHome(loginHome).catch(() => {
          deps.error("[cloud-worker] could not remove the run's CLI login directory; delete it manually");
        });
      }
      if (!keepRunDir) {
        await fsp.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    /** Writes back refreshed logins once; returns the CLIs whose login could not be stored. */
    async function storeRefreshedLogins(): Promise<string[]> {
      if (!cliCredentials || !materialized?.files.length || writeBackDone) return [];
      writeBackDone = true;
      const outcome = await writeBackCliCredentials({
        worker,
        credentials: cliCredentials,
        materialized,
        fetchImpl: deps.fetchImpl,
        log: deps.log,
      }).catch(() => ({ written: 0, failed: materialized?.files ?? [] }));
      return outcome.failed.map((file) => file.cli);
    }
  };
}

async function startDaemon(input: {
  worker: CloudWorkerRecord;
  options: { baseUrl?: string; workerId?: string; name?: string; once?: boolean; localAgent?: boolean };
  deps: CloudWorkerDependencies;
}): Promise<CloudWorkerRecord> {
  const stateDir = cloudWorkerStateDir(input.deps.env);
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDir, `${input.worker.workerId}.log`);
  const logFd = fs.openSync(logPath, 'a');
  let child: ChildProcess;
  const launch = resolveAgentRelayCliChildCommand({
    execPath: process.execPath,
    cliEntrypoint: input.deps.resolveAgentRelayCliEntrypoint(),
    args: [
      'cloud',
      'worker',
      'start',
      '--worker-id',
      input.worker.workerId,
      '--base-url',
      input.worker.baseUrl,
      '--foreground-child',
      ...(input.options.once ? ['--once'] : []),
      ...(input.options.localAgent ? ['--local-agent'] : []),
    ],
    cwd: input.deps.cwd(),
  });

  try {
    child = input.deps.spawnProcess(launch.command, launch.args, {
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
        if (stat.size < offset) {
          offset = 0;
        }
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
    .option('--token <token>', 'Worker enrollment token (choose exactly one token source)')
    .option('--token-file <path>', 'Read the enrollment token from a regular file (maximum 16 KiB)')
    .option('--token-stdin', 'Read the enrollment token from non-interactive stdin (maximum 16 KiB)')
    .requiredOption('--name <name>', 'Worker name')
    .option('--base-url <url>', 'Cloud API base URL')
    .option('--json', 'Print raw JSON response', false)
    .action(
      async (options: WorkerEnrollmentTokenOptions & { name: string; baseUrl?: string; json?: boolean }) => {
        const enrollmentToken = await readWorkerEnrollmentToken(options, deps.stdin);
        const record = await registerCloudWorker({
          enrollmentToken,
          name: options.name,
          baseUrl: options.baseUrl,
          env: deps.env,
          fetchImpl: deps.fetchImpl,
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
      }
    );

  workerCommand
    .command('start')
    .description('Start the Cloud worker loop')
    .option('--base-url <url>', 'Cloud API base URL')
    .option('--worker-id <id>', 'Stored worker id to start')
    .option('--name <name>', 'Stored worker name to start')
    .option('--daemon', 'Run in the background and write local daemon logs', false)
    .option('--once', 'Process one assignment, then exit', false)
    .option(
      '--local-agent',
      'Attach the supported local Relayflows agent worker; provider setup is separate',
      false
    )
    .addOption(new Option('--foreground-child', 'Internal flag used by --daemon').hideHelp().default(false))
    .action(
      async (options: {
        baseUrl?: string;
        workerId?: string;
        name?: string;
        daemon?: boolean;
        once?: boolean;
        localAgent?: boolean;
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
            executeAssignment: createDefaultAssignmentRunner(deps, { localAgent: options.localAgent }),
            fetchImpl: deps.fetchImpl,
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
