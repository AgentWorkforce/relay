import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { create as createTar } from 'tar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cloudMocks = vi.hoisted(() => ({
  runWorkflow: vi.fn(),
  scheduleWorkflow: vi.fn(),
  listWorkflowSchedules: vi.fn(),
  getRunStatus: vi.fn(),
  syncWorkflowPatch: vi.fn(),
  downloadCloudWorkerAssignmentStorage: vi.fn(),
  registerCloudWorker: vi.fn(),
  resolveCloudWorkerRecord: vi.fn(),
  runCloudWorkerLoop: vi.fn(),
  enrollFleetNode: vi.fn(),
  upsertFleetNodeEnrollment: vi.fn(),
  isHeadlessEnvironment: vi.fn(() => false),
}));

vi.mock('@agent-relay/cloud', async (importOriginal) => ({
  AUTH_FILE_PATH: '/tmp/cloud-auth.json',
  REFRESH_WINDOW_MS: 5 * 60_000,
  authorizedApiFetch: vi.fn(),
  cancelWorkflow: vi.fn(),
  clearStoredAuth: vi.fn(),
  connectProvider: vi.fn(),
  defaultApiUrl: () => 'https://cloud.test',
  enrollFleetNode: (...args: unknown[]) => cloudMocks.enrollFleetNode(...args),
  upsertFleetNodeEnrollment: (...args: unknown[]) => cloudMocks.upsertFleetNodeEnrollment(...args),
  ensureAuthenticated: vi.fn(),
  ensureCloudSession: vi.fn(),
  isHeadlessEnvironment: (...args: unknown[]) => cloudMocks.isHeadlessEnvironment(...args),
  getProviderHelpText: () =>
    'anthropic (alias: claude), openai (alias: codex), google (alias: gemini), cursor, opencode, droid',
  getRunLogs: vi.fn(),
  getRunStatus: (...args: unknown[]) => cloudMocks.getRunStatus(...args),
  downloadCloudWorkerAssignmentStorage: (...args: unknown[]) =>
    cloudMocks.downloadCloudWorkerAssignmentStorage(...args),
  listWorkflowSchedules: (...args: unknown[]) => cloudMocks.listWorkflowSchedules(...args),
  readStoredAuth: vi.fn(),
  // The real redactor, not a copy: `looksLikeCredential` keys off its exact
  // prefix set, so a copy here would let production drift past these tests.
  redactCredentialValues: (await importOriginal<typeof import('@agent-relay/cloud')>())
    .redactCredentialValues,
  registerCloudWorker: (...args: unknown[]) => cloudMocks.registerCloudWorker(...args),
  resolveCloudWorkerRecord: (...args: unknown[]) => cloudMocks.resolveCloudWorkerRecord(...args),
  runWorkflow: (...args: unknown[]) => cloudMocks.runWorkflow(...args),
  runCloudWorkerLoop: (...args: unknown[]) => cloudMocks.runCloudWorkerLoop(...args),
  scheduleWorkflow: (...args: unknown[]) => cloudMocks.scheduleWorkflow(...args),
  syncWorkflowPatch: (...args: unknown[]) => cloudMocks.syncWorkflowPatch(...args),
  upsertCloudWorkerRecord: vi.fn(),
  IDENTITY_FILE_PATH: '/tmp/cloud-identity.json',
  toCloudIdentity: () => null,
  writeStoredIdentity: vi.fn(),
  cloudWorkerStateDir: (env?: NodeJS.ProcessEnv) =>
    env?.AGENT_RELAY_HOME ? path.join(env.AGENT_RELAY_HOME, 'cloud-workers') : '/tmp/cloud-workers',
}));

vi.mock('../telemetry/index.js', () => ({
  track: vi.fn(),
}));

import {
  authorizedApiFetch,
  ensureAuthenticated,
  ensureCloudSession,
  readStoredAuth,
} from '@agent-relay/cloud';
import { track } from '../telemetry/index.js';

import { buildCloudSyncPatchExcludeArgs, registerCloudCommands, type CloudDependencies } from './cloud.js';
import { createDefaultAssignmentRunner } from './cloud-worker.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function createHarness(overrides?: Partial<CloudDependencies>) {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as CloudDependencies['exit'];

  const deps: CloudDependencies = {
    log: vi.fn(() => undefined),
    warn: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
    ensureCloudSession: vi.mocked(ensureCloudSession),
    authorizedApiFetch: vi.mocked(authorizedApiFetch),
    enrollFleetNode: cloudMocks.enrollFleetNode as unknown as CloudDependencies['enrollFleetNode'],
    upsertFleetNodeEnrollment:
      cloudMocks.upsertFleetNodeEnrollment as unknown as CloudDependencies['upsertFleetNodeEnrollment'],
    writeEnrollmentRecoveryFile: vi.fn(() => '/tmp/cloud-enrollment-recovery.json'),
    // Stubbed by default so no test can reach the real checkout's workspace pin.
    linkEnrolledNodeToProjectPin: vi.fn(() => ({
      status: 'no-pin',
    })) as unknown as CloudDependencies['linkEnrolledNodeToProjectPin'],
    ...overrides,
  };

  const program = new Command();
  program.exitOverride();
  registerCloudCommands(program, deps);

  return { program, deps };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

async function createTarBuffer(entries: Record<string, string>): Promise<Buffer> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-worker-archive-'));
  try {
    const sourceDir = path.join(tmp, 'src');
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const [name, content] of Object.entries(entries)) {
      const filePath = path.join(sourceDir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    const archivePath = path.join(tmp, 'archive.tgz');
    await createTar({ cwd: sourceDir, file: archivePath, gzip: true }, Object.keys(entries));
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('registerCloudCommands', () => {
  it('registers cloud subcommands on the program', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');

    expect(cloud).toBeDefined();
    expect(cloud?.commands.map((command) => command.name())).toEqual([
      'worker',
      'room',
      'integration',
      'login',
      'logout',
      'session',
      'whoami',
      'workspaces',
      'connect',
      'enroll',
      'run',
      'schedule',
      'schedules',
      'status',
      'logs',
      'sync',
      'cancel',
    ]);
  });

  describe('cloud login', () => {
    beforeEach(() => {
      vi.mocked(readStoredAuth).mockResolvedValue(null);
      vi.mocked(ensureAuthenticated).mockResolvedValue({} as never);
      cloudMocks.isHeadlessEnvironment.mockReturnValue(false);
    });

    it('exposes --device for headless hosts', () => {
      const { program } = createHarness();
      const login = program.commands
        .find((command) => command.name() === 'cloud')
        ?.commands.find((command) => command.name() === 'login');

      expect(login?.options.map((option) => option.long)).toContain('--device');
    });

    it('requests the device flow when --device is passed', async () => {
      const { program } = createHarness();
      await program.parseAsync(['cloud', 'login', '--device'], { from: 'user' });

      expect(vi.mocked(ensureAuthenticated)).toHaveBeenCalledWith(
        'https://cloud.test',
        expect.objectContaining({ device: true })
      );
    });

    it('leaves the browser flow alone by default', async () => {
      const { program } = createHarness();
      await program.parseAsync(['cloud', 'login'], { from: 'user' });

      expect(vi.mocked(ensureAuthenticated)).toHaveBeenCalledWith(
        'https://cloud.test',
        expect.objectContaining({ device: undefined })
      );
    });

    it('short-circuits when a live session already exists', async () => {
      vi.mocked(readStoredAuth).mockResolvedValue({
        apiUrl: 'https://cloud.test',
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const { program, deps } = createHarness();
      await program.parseAsync(['cloud', 'login', '--device'], { from: 'user' });

      expect(vi.mocked(ensureAuthenticated)).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith('Already logged in to https://cloud.test');
    });

    it('re-authenticates on --force even with a live session', async () => {
      vi.mocked(readStoredAuth).mockResolvedValue({
        apiUrl: 'https://cloud.test',
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const { program } = createHarness();
      await program.parseAsync(['cloud', 'login', '--device', '--force'], { from: 'user' });

      expect(vi.mocked(ensureAuthenticated)).toHaveBeenCalledWith(
        'https://cloud.test',
        expect.objectContaining({ device: true, force: true })
      );
    });

    it('records the method that actually ran', async () => {
      const { program } = createHarness();
      await program.parseAsync(['cloud', 'login', '--device'], { from: 'user' });

      expect(vi.mocked(track)).toHaveBeenCalledWith(
        'cloud_auth',
        expect.objectContaining({ action: 'login', method: 'device', success: true })
      );
    });

    it('attributes an auto-selected device login to the device flow', async () => {
      // The point of the field is headless adoption, and the auto fallback
      // means counting `--device` alone would undercount it.
      cloudMocks.isHeadlessEnvironment.mockReturnValue(true);

      const { program } = createHarness();
      await program.parseAsync(['cloud', 'login'], { from: 'user' });

      expect(vi.mocked(track)).toHaveBeenCalledWith(
        'cloud_auth',
        expect.objectContaining({ method: 'device' })
      );
    });

    it('omits the method when the live-session short-circuit ran no flow', async () => {
      // Reporting `method: 'device'` for an invocation that logged nobody in
      // inflates exactly the headless-adoption metric the field exists to
      // measure — and it is the kind of number that later gets trusted.
      vi.mocked(readStoredAuth).mockResolvedValue({
        apiUrl: 'https://cloud.test',
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const { program } = createHarness();
      await program.parseAsync(['cloud', 'login', '--device'], { from: 'user' });

      expect(vi.mocked(ensureAuthenticated)).not.toHaveBeenCalled();
      const [, payload] = vi.mocked(track).mock.calls.at(-1) as [string, Record<string, unknown>];
      expect(payload).toMatchObject({ action: 'login', success: true });
      expect(payload).not.toHaveProperty('method');
    });
  });

  it('registers cloud worker subcommands', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const worker = cloud?.commands.find((command) => command.name() === 'worker');

    expect(worker).toBeDefined();
    expect(worker?.commands.map((command) => command.name())).toEqual([
      'register',
      'start',
      'status',
      'logs',
    ]);
  });

  it('cloud worker register stores returned credentials without printing the token', async () => {
    const { program, deps } = createHarness();
    cloudMocks.registerCloudWorker.mockResolvedValueOnce({
      baseUrl: 'https://cloud.test',
      workerId: 'wrk_1',
      workerToken: 'ocl_wrk_secret',
      name: 'demo',
      heartbeatIntervalMs: 30_000,
      registeredAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'worker',
      'register',
      '--token',
      'ocl_wrk_enr_secret',
      '--name',
      'demo',
    ]);

    expect(cloudMocks.registerCloudWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        enrollmentToken: 'ocl_wrk_enr_secret',
        name: 'demo',
      })
    );
    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('Registered worker demo (wrk_1)');
    expect(output).not.toContain('ocl_wrk_secret');
    expect(output).not.toContain('ocl_wrk_enr_secret');
  });

  it('cloud worker start wires the stored worker into the control loop', async () => {
    const { program } = createHarness();
    const worker = {
      baseUrl: 'https://cloud.test',
      workerId: 'wrk_1',
      workerToken: 'ocl_wrk_secret',
      name: 'demo',
      heartbeatIntervalMs: 30_000,
      registeredAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    };
    cloudMocks.resolveCloudWorkerRecord.mockReturnValueOnce(worker);
    cloudMocks.runCloudWorkerLoop.mockResolvedValueOnce(undefined);

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'worker', 'start', '--once']);

    expect(cloudMocks.runCloudWorkerLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        worker,
        once: true,
        executeAssignment: expect.any(Function),
      })
    );
  });

  it('materializes Cloud assignments into relayflows args and child env without persisting secrets', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-worker-relayflows-'));
    const spawnCalls: Array<{
      command: string;
      args: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }> = [];
    const spawnProcess = vi.fn(
      (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
        const child = new EventEmitter() as EventEmitter & {
          killed: boolean;
          kill: ReturnType<typeof vi.fn>;
        };
        child.killed = false;
        child.kill = vi.fn(() => {
          child.killed = true;
          return true;
        });
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      }
    ) as never;

    try {
      cloudMocks.downloadCloudWorkerAssignmentStorage.mockImplementation(
        async (input: { objectKey: string }) => {
          if (input.objectKey === 'code/archive.tgz') {
            return createTarBuffer({
              'lib/helper.txt': 'helper from main archive',
            });
          }
          if (input.objectKey === 'paths/shared.tgz') {
            return createTarBuffer({
              'shared.txt': 'shared path archive',
            });
          }
          throw new Error(`unexpected object key ${input.objectKey}`);
        }
      );

      const worker = {
        baseUrl: 'https://cloud.test',
        workerId: 'wrk_1',
        workerToken: 'ocl_wrk_secret',
        name: 'demo',
        heartbeatIntervalMs: 30_000,
        registeredAt: '2026-06-13T00:00:00.000Z',
        updatedAt: '2026-06-13T00:00:00.000Z',
      };
      const runner = createDefaultAssignmentRunner({
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
        env: {
          AGENT_RELAY_HOME: tmpHome,
          AGENT_RELAY_WORKER_KEEP_RUN_DIR: '1',
          BASE_ENV: 'kept',
        },
        spawnProcess,
        now: () => new Date('2026-06-13T00:00:00.000Z'),
        cwd: () => tmpHome,
        fetchImpl: vi.fn() as never,
        resolveRelayflowsCliEntrypoint: () => '/opt/relayflows/dist/cli.js',
      });

      await runner({
        assignment: { runId: 'run_relayflows' } as never,
        payload: {
          runId: 'run_relayflows',
          workspaceId: 'rw_1',
          relayWorkspaceId: 'rw_relay',
          relaycastApiKey: 'rk_live_secret',
          relaycastBaseUrl: 'https://relaycast.test',
          relayfileUrl: 'https://relayfile.test',
          relayfileToken: 'relayfile_secret',
          workflow: 'version: "1.0"\nworkflows: []\n',
          fileType: 'yaml',
          sourceFileType: 'yaml',
          workflowFileName: '../workflow.yaml',
          s3CodeKey: 'code/archive.tgz',
          paths: [
            {
              name: '../shared path',
              s3CodeKey: 'paths/shared.tgz',
            },
          ],
          envSecrets: {
            OPENAI_API_KEY: 'sk-secret',
          },
          resumeRunId: 'run_previous',
          startFrom: 'repair',
          previousRunId: 'run_cache',
        },
        worker,
        signal: new AbortController().signal,
      });

      expect(cloudMocks.downloadCloudWorkerAssignmentStorage).toHaveBeenCalledWith(
        expect.objectContaining({
          worker,
          runId: 'run_relayflows',
          objectKey: 'code/archive.tgz',
        })
      );
      expect(cloudMocks.downloadCloudWorkerAssignmentStorage).toHaveBeenCalledWith(
        expect.objectContaining({
          worker,
          runId: 'run_relayflows',
          objectKey: 'paths/shared.tgz',
        })
      );
      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      const workflowPath = path.join(tmpHome, 'cloud-workers', 'runs', 'run_relayflows', 'workflow.yaml');
      expect(call.command).toBe(process.execPath);
      expect(call.args).toEqual([
        '/opt/relayflows/dist/cli.js',
        'run',
        workflowPath,
        '--resume',
        'run_previous',
        '--start-from',
        'repair',
        '--previous-run-id',
        'run_cache',
      ]);
      expect(call.cwd).toBe(path.dirname(workflowPath));
      expect(call.env).toMatchObject({
        BASE_ENV: 'kept',
        OPENAI_API_KEY: 'sk-secret',
        AGENT_RELAY_CLOUD_WORKER_RUN_ID: 'run_relayflows',
        RELAY_WORKSPACE_ID: 'rw_relay',
        RELAY_API_KEY: 'rk_live_secret',
        RELAYCAST_API_KEY: 'rk_live_secret',
        RELAYCAST_BASE_URL: 'https://relaycast.test',
        RELAYFILE_URL: 'https://relayfile.test',
        RELAYFILE_TOKEN: 'relayfile_secret',
      });

      const workflowFile = fs.readFileSync(workflowPath, 'utf-8');
      expect(workflowFile).toBe('version: "1.0"\nworkflows: []\n');
      expect(fs.readFileSync(path.join(path.dirname(workflowPath), 'lib', 'helper.txt'), 'utf-8')).toBe(
        'helper from main archive'
      );
      expect(
        fs.readFileSync(path.join(path.dirname(workflowPath), 'paths', 'shared_path', 'shared.txt'), 'utf-8')
      ).toBe('shared path archive');
      const persisted = fs.readFileSync(workflowPath, 'utf-8');
      expect(persisted).not.toContain('sk-secret');
      expect(persisted).not.toContain('relayfile_secret');
      expect(persisted).not.toContain('rk_live_secret');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('prints the canonical cloud session as JSON without interactive login', async () => {
    const { program, deps } = createHarness();
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({
      auth: {
        apiUrl: 'https://cloud.test',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
        refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
      },
      client: {} as never,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'session',
      '--json',
      '--refresh-timeout',
      '25',
    ]);

    expect(ensureCloudSession).toHaveBeenCalledWith({
      apiUrl: 'https://cloud.test',
      interactive: false,
      refreshTimeoutMs: 25,
    });
    const sessionJson = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(sessionJson).toEqual({
      apiUrl: 'https://cloud.test',
      accessToken: '…oken',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
    });
    expect(sessionJson).not.toHaveProperty('refreshToken');
  });

  it('writes the session JSON through the default stdout logger when stdout is not a TTY', async () => {
    // Regression: scripted callers (`cloud session --json | parser`, `$(...)`)
    // got empty stdout. The command must not gate its output on a TTY, and the
    // production logger — not just an injected test double — must emit it.
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({
      auth: {
        apiUrl: 'https://cloud.test',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      },
      client: {} as never,
    });

    const program = new Command();
    program.exitOverride();
    // No dependency overrides: this exercises the production `console.log` path.
    registerCloudCommands(program);

    const chunks: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map((arg) => String(arg)).join(' '));
    });
    const originalIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      await program.parseAsync(['node', 'agent-relay', 'cloud', 'session', '--json']);
    } finally {
      log.mockRestore();
      if (originalIsTty) {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTty);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    }

    expect(JSON.parse(chunks.join(''))).toEqual({
      apiUrl: 'https://cloud.test',
      accessToken: '…oken',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    });
  });

  it('includes the raw access token in JSON output only with --reveal-token', async () => {
    const { program, deps } = createHarness();
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({
      auth: {
        apiUrl: 'https://cloud.test',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
        refreshTokenExpiresAt: '2999-04-01T00:00:00.000Z',
      },
      client: {} as never,
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'session', '--json', '--reveal-token']);

    const sessionJson = JSON.parse(String(vi.mocked(deps.log).mock.calls[0][0]));
    expect(sessionJson.accessToken).toBe('access-token');
    expect(sessionJson).not.toHaveProperty('refreshToken');
  });

  it('connect requires a provider argument', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const connect = cloud?.commands.find((command) => command.name() === 'connect');

    expect(connect).toBeDefined();
    expect(connect?.description()).toContain('interactive SSH session');
    expect(connect?.registeredArguments[0]?.argChoices).toBeUndefined();
    expect(connect?.registeredArguments[0]?.description).toContain('anthropic (alias: claude)');
    expect(connect?.registeredArguments[0]?.description).toContain('openai (alias: codex)');
    expect(connect?.registeredArguments[0]?.description).toContain('google (alias: gemini)');
  });

  it('run requires a workflow argument', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const run = cloud?.commands.find((command) => command.name() === 'run');

    expect(run).toBeDefined();
    expect(run?.description()).toContain('workflow run');
    const optionNames = run?.options.map((option) => option.long);
    expect(optionNames).toContain('--resume');
    expect(optionNames).toContain('--start-from');
    expect(optionNames).toContain('--previous-run-id');
    expect(optionNames).toContain('--relayflow-version');
  });

  it('cloud run rejects a mistyped relayflow generation before submission', async () => {
    const { program } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'run',
        'workflow.yaml',
        '--relayflow-version',
        'V2',
      ])
    ).rejects.toThrow(/v1, v2/);
    expect(cloudMocks.runWorkflow).not.toHaveBeenCalled();
  });

  it('cloud run defaults new CLI submissions to the v1 engine', async () => {
    const { program } = createHarness();
    cloudMocks.runWorkflow.mockResolvedValueOnce({ runId: 'run-v1', status: 'pending' });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'run', 'workflow.yaml']);

    expect(cloudMocks.runWorkflow).toHaveBeenCalledWith(
      'workflow.yaml',
      expect.objectContaining({ relayflowVersion: 'v1' })
    );
  });

  it('status requires a runId argument', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const status = cloud?.commands.find((command) => command.name() === 'status');

    expect(status).toBeDefined();
    expect(status?.description()).toContain('workflow run status');
    const optionNames = status?.options.map((option) => option.long);
    expect(optionNames).toContain('--json');
  });

  it('schedule creates repeatable workflow schedules', async () => {
    const { program, deps } = createHarness();
    cloudMocks.scheduleWorkflow.mockResolvedValueOnce({
      id: 'sched-1',
      name: 'Hourly eval',
      scheduleType: 'cron',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
      status: 'active',
      lastTriggeredRunId: null,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'schedule',
      'workflow.yaml',
      '--cron',
      '0 * * * *',
      '--name',
      'Hourly eval',
      '--relayflow-version',
      'v2',
      '--env',
      'AI_CLI_UPDATES_DRY_RUN=true',
      '--env',
      'AI_CLI_UPDATES_ONLY=codex',
    ]);

    expect(cloudMocks.scheduleWorkflow).toHaveBeenCalledWith(
      'workflow.yaml',
      expect.objectContaining({
        cron: '0 * * * *',
        name: 'Hourly eval',
        relayflowVersion: 'v2',
        envSecrets: {
          AI_CLI_UPDATES_DRY_RUN: 'true',
          AI_CLI_UPDATES_ONLY: 'codex',
        },
      })
    );
    expect(deps.log).toHaveBeenCalledWith('Schedule created: sched-1');
  });

  it('schedule rejects malformed environment assignments', async () => {
    const { program } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'schedule',
        'workflow.yaml',
        '--cron',
        '0 * * * *',
        '--env',
        'not-an-assignment',
      ])
    ).rejects.toThrow();

    expect(cloudMocks.scheduleWorkflow).not.toHaveBeenCalled();
  });

  it('schedule creates one-time workflow schedules', async () => {
    const { program, deps } = createHarness();
    cloudMocks.scheduleWorkflow.mockResolvedValueOnce({
      id: 'sched-at-1',
      name: 'One-off eval',
      scheduleType: 'once',
      scheduledAt: '2026-05-10T09:00:00.000Z',
      timezone: 'UTC',
      status: 'active',
      lastTriggeredRunId: null,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'schedule',
      'workflow.yaml',
      '--at',
      '2026-05-10T09:00:00Z',
      '--name',
      'One-off eval',
    ]);

    expect(cloudMocks.scheduleWorkflow).toHaveBeenCalledWith(
      'workflow.yaml',
      expect.objectContaining({
        at: '2026-05-10T09:00:00Z',
        name: 'One-off eval',
        relayflowVersion: 'v1',
      })
    );
    expect(cloudMocks.scheduleWorkflow.mock.calls[0][1]).not.toHaveProperty('cron');
    expect(deps.log).toHaveBeenCalledWith('Schedule created: sched-at-1');
  });

  it('schedules lists repeatable workflow schedules', async () => {
    const { program, deps } = createHarness();
    cloudMocks.listWorkflowSchedules.mockResolvedValueOnce([
      {
        id: 'sched-1',
        name: 'Hourly eval',
        scheduleType: 'cron',
        cronExpression: '0 * * * *',
        timezone: 'UTC',
        status: 'active',
        lastTriggeredRunId: 'run-1',
      },
    ]);

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'schedules']);

    expect(cloudMocks.listWorkflowSchedules).toHaveBeenCalledWith(expect.objectContaining({}));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('sched-1'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('run-1'));
  });

  it('logs has --follow and --poll-interval options', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const logs = cloud?.commands.find((command) => command.name() === 'logs');

    expect(logs).toBeDefined();
    const optionNames = logs?.options.map((option) => option.long);
    expect(optionNames).toContain('--follow');
    expect(optionNames).toContain('--poll-interval');
  });

  it('sync has --dry-run option', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const sync = cloud?.commands.find((command) => command.name() === 'sync');

    expect(sync).toBeDefined();
    const optionNames = sync?.options.map((option) => option.long);
    expect(optionNames).toContain('--dry-run');
  });

  it('sync excludes volatile workflow bookkeeping files when applying patches', () => {
    const args = buildCloudSyncPatchExcludeArgs();

    expect(args).toContain('--exclude=".agent-bin/**"');
    expect(args).toContain('--exclude=".relayfile.acl"');
    expect(args).toContain('--exclude=".relayfile-mount-state.json"');
    expect(args).toContain('--exclude=".relayfile-mount-state.json.tmp-*"');
    expect(args).toContain('--exclude=".trajectories/**"');
    expect(args).toContain('--exclude=".workflow-context/**"');
  });

  it('registers cloud cancel subcommand', () => {
    const { program } = createHarness();
    const cloud = program.commands.find((command) => command.name() === 'cloud');
    const cancel = cloud?.commands.find((command) => command.name() === 'cancel');

    expect(cancel).toBeDefined();
    expect(cancel?.registeredArguments[0]?.required).toBe(true);
    expect(cancel?.registeredArguments[0]?.name()).toBe('runId');
  });

  it('cloud run renders pushed PR and push errors for patches', async () => {
    const { program, deps } = createHarness();
    cloudMocks.runWorkflow.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'completed',
      patches: {
        cloud: {
          s3Key: 'user/run/changes-cloud.patch',
          pushedTo: {
            branch: 'agent-relay/run-run-1',
            prUrl: 'https://github.com/acme/cloud/pull/12',
            sha: 'abc123',
            base: { branch: 'main', sha: 'base123' },
          },
        },
        relay: {
          s3Key: 'user/run/changes-relay.patch',
          pushError: {
            code: 'base_branch_moved',
            message: 'Base branch moved',
          },
        },
      },
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'run',
      'workflow.yaml',
      '--relayflow-version',
      'v2',
    ]);

    expect(cloudMocks.runWorkflow).toHaveBeenCalledWith(
      'workflow.yaml',
      expect.objectContaining({ relayflowVersion: 'v2' })
    );

    expect(deps.log).toHaveBeenCalledWith('Patches:');
    expect(deps.log).toHaveBeenCalledWith(
      '  cloud: https://github.com/acme/cloud/pull/12 (agent-relay/run-run-1)'
    );
    expect(deps.log).toHaveBeenCalledWith('  relay: push failed: base_branch_moved: Base branch moved');
  });

  it('cloud sync refuses to apply multi-path responses (no silent data loss)', async () => {
    const { program, deps } = createHarness();
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      patches: {
        cloud: { patch: 'diff --git a/x b/x\n', hasChanges: true },
        relay: { patch: 'diff --git a/y b/y\n', hasChanges: true },
      },
    });

    await expect(program.parseAsync(['node', 'agent-relay', 'cloud', 'sync', 'run-42'])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('2 per-path patches (cloud, relay)'));
    expect(deps.log).not.toHaveBeenCalledWith('No changes to sync — the workflow did not modify any files.');
  });

  it('cloud sync --dry-run prints each multi-path patch', async () => {
    const { program, deps } = createHarness();
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      patches: {
        cloud: { patch: 'CLOUD_PATCH_BODY', hasChanges: true },
        relay: { patch: '', hasChanges: false },
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'sync', 'run-42', '--dry-run']);

    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Patch for "cloud" (dry run)'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('Patch for "relay"'));
  });

  it('cloud sync reports no-changes when multi-path response has all empty patches', async () => {
    const { program, deps } = createHarness();
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      patches: {
        cloud: { patch: '', hasChanges: false },
        relay: { patch: '', hasChanges: false },
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'sync', 'run-42']);

    expect(deps.log).toHaveBeenCalledWith('No changes to sync — the workflow did not modify any files.');
  });

  it('cloud status renders pending patch push state', async () => {
    const { program, deps } = createHarness();
    cloudMocks.getRunStatus.mockResolvedValueOnce({
      runId: 'run-1',
      status: 'completed',
      patches: {
        cloud: {
          s3Key: 'user/run/changes-cloud.patch',
        },
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'status', 'run-1']);

    expect(deps.log).toHaveBeenCalledWith('Patches:');
    expect(deps.log).toHaveBeenCalledWith('  cloud: patch pending - run still active');
  });

  it('cloud enroll --workspace resolves a supported workspace selector before minting', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    const resolvedAuth = {
      ...auth,
      accessToken: 'refreshed-access-secret',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            workspaceId: 'rw_7ccfea89',
            cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
            relaycastWorkspaceId: 'rw_7ccfea89',
            relayfileWorkspaceId: 'rw_7ccfea89',
            relayauthWorkspaceId: 'rw_7ccfea89',
            urls: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
        auth: resolvedAuth,
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            token: 'ocl_node_enr_minted_secret',
            enrollmentUrl: 'https://cloud.test/api/v1/fleet/register',
            enrollCommand: 'agent-relay cloud enroll --token redacted',
            relayWorkspaceId: 'rw_7ccfea89',
            expiresAt: '2999-01-01T00:05:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
        auth: resolvedAuth,
      });
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_relay_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const { program, deps } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'enroll',
      '--workspace',
      'rw_7ccfea89',
      '--name',
      'kjglaptop',
      '--max-agents',
      '4',
    ]);

    expect(ensureCloudSession).toHaveBeenCalledWith({
      apiUrl: 'https://cloud.test',
      interactive: false,
    });
    expect(authorizedApiFetch).toHaveBeenNthCalledWith(
      1,
      auth,
      '/api/v1/workspaces/rw_7ccfea89/resolve',
      { method: 'GET' },
      { interactive: false }
    );
    expect(authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      resolvedAuth,
      '/api/v1/fleet/enrollment-tokens',
      {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
          name: 'kjglaptop',
          maxAgents: 4,
        }),
      },
      { interactive: false }
    );
    expect(cloudMocks.enrollFleetNode).toHaveBeenCalledWith({
      enrollmentToken: 'ocl_node_enr_minted_secret',
      enrollmentUrl: 'https://cloud.test/api/v1/fleet/register',
      name: 'kjglaptop',
      maxAgents: 4,
    });
    const output = [
      ...vi.mocked(deps.log).mock.calls.flat(),
      ...vi.mocked(deps.error).mock.calls.flat(),
    ].join('\n');
    expect(output).not.toContain('ocl_node_enr_minted_secret');
    expect(output).not.toContain('access-secret');
    expect(output).not.toContain('refresh-secret');
  });

  it('cloud enroll --workspace tells logged-out users how to log in', async () => {
    vi.mocked(ensureCloudSession).mockRejectedValueOnce(
      Object.assign(new Error('Cloud login required'), { code: 'AUTH_BROWSER_REQUIRED' })
    );
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith('Cloud login required. Run `agent-relay cloud login` and retry.');
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 403,
      body: { error: 'Forbidden' },
      message: 'You do not have permission to enroll nodes in workspace rw_7ccfea89',
    },
    {
      status: 404,
      body: { error: 'Workspace not found' },
      message: 'Workspace rw_7ccfea89 was not found',
    },
  ])('cloud enroll --workspace maps a $status mint response', async ({ status, body, message }) => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        auth,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
        auth,
      });
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it('cloud enroll --workspace surfaces the Retry-After value on rate limits', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        auth,
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '180' },
        }),
        auth,
      });
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('Retry-After: 180 seconds'));
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 403,
      body: { error: 'Forbidden: rw_7ccfea89' },
      message: 'You do not have access to that Cloud workspace.',
    },
    {
      status: 404,
      body: { error: 'Workspace rw_7ccfea89 was not found' },
      message:
        'The workspace identifier was not found by Agent Relay Cloud. Use a Cloud workspace UUID or unified rw_ workspace ID.',
    },
  ])(
    'cloud enroll --workspace maps a $status resolver response without minting',
    async ({ status, body, message }) => {
      const workspaceId = 'rw_7ccfea89';
      const auth = {
        apiUrl: 'https://cloud.test',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      };
      vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
      vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
        response: new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
        auth,
      });
      const { program, deps } = createHarness();

      await expect(
        program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', workspaceId])
      ).rejects.toThrow('exit:1');

      expect(deps.error).toHaveBeenCalledWith(message);
      expect(deps.error.mock.calls.flat().join('\n')).not.toContain(workspaceId);
      expect(authorizedApiFetch).toHaveBeenCalledTimes(1);
      expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
    }
  );

  it('cloud enroll --workspace preserves Retry-After from the resolver without minting', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '90' },
      }),
      auth,
    });
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('Retry-After: 90 seconds'));
    expect(authorizedApiFetch).toHaveBeenCalledTimes(1);
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it.each([
    new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ workspaceId: 'rw_7ccfea89' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ])('cloud enroll --workspace rejects an invalid resolver descriptor without minting', async (response) => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({ response, auth });
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith('Cloud workspace resolver returned an invalid response.');
    expect(authorizedApiFetch).toHaveBeenCalledTimes(1);
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it.each(['rk_live_SECRET', 'ocl_node_enr_SECRET'])(
    'cloud enroll --workspace rejects credential %s without transmitting or disclosing it',
    async (workspaceId) => {
      const auth = {
        apiUrl: 'https://cloud.test',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
      };
      vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
      vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
        response: jsonResponse({ workspaces: [{ id: 'ws-1', slug: 'chief', name: 'Chief HQ' }] }),
        auth,
      });
      const { program, deps } = createHarness();

      await expect(
        program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', workspaceId])
      ).rejects.toThrow('exit:1');

      expect(deps.error).toHaveBeenCalledWith(
        'That value looks like a credential, not a workspace. Pass a workspace name, Cloud workspace UUID, ' +
          "or unified rw_ workspace ID. Run 'agent-relay cloud workspaces' to list the workspaces this login can use."
      );
      // The selector is matched locally against the listing, so it must never
      // reach an outbound request or the terminal.
      expect(deps.error.mock.calls.flat().join('\n')).not.toContain(workspaceId);
      expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).not.toContain(workspaceId);
      expect(authorizedApiFetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vi.mocked(authorizedApiFetch).mock.calls)).not.toContain(workspaceId);
      expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
    }
  );

  it('cloud enroll --workspace accepts a listed name that looks credential-like', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce({
        // `br_` is one of the redactor's deliberately broad prefixes, so this
        // name must resolve on the strength of being in the listing.
        response: jsonResponse({ workspaces: [{ id: 'ws-1', slug: 'br-team', name: 'br_team' }] }),
        auth,
      })
      .mockResolvedValueOnce({
        response: jsonResponse({
          workspaceId: 'rw_7ccfea89',
          cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
        }),
        auth,
      })
      .mockResolvedValueOnce({
        response: jsonResponse({
          token: 'ocl_node_enr_minted_secret',
          enrollmentUrl: 'https://cloud.test/api/v1/fleet/register',
        }),
        auth,
      });
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'br',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_7ccfea89',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const { program } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'br_team']);

    expect(authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      auth,
      '/api/v1/workspaces/ws-1/resolve',
      { method: 'GET' },
      { interactive: false }
    );
    expect(cloudMocks.enrollFleetNode).toHaveBeenCalled();
  });

  it('cloud enroll --workspace resolves a workspace name against the login listing', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce({
        response: jsonResponse({
          workspaces: [
            { id: '50587328-441d-4acb-b8f3-dbe1b3c5de99', slug: 'chief', name: 'Chief HQ' },
            { id: 'a1b2c3d4-0000-4000-8000-000000000000', slug: 'scratch', name: 'Scratch' },
          ],
        }),
        auth,
      })
      .mockResolvedValueOnce({
        response: jsonResponse({
          workspaceId: 'rw_7ccfea89',
          cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
        }),
        auth,
      })
      .mockResolvedValueOnce({
        response: jsonResponse({
          token: 'ocl_node_enr_minted_secret',
          enrollmentUrl: 'https://cloud.test/api/v1/fleet/register',
        }),
        auth,
      });
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'chief',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_7ccfea89',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const { program } = createHarness();

    // Case-insensitive: the listing is the source of truth, not the casing typed.
    await program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'chief hq']);

    expect(authorizedApiFetch).toHaveBeenNthCalledWith(
      1,
      auth,
      '/api/v1/workspaces',
      { method: 'GET' },
      { interactive: false }
    );
    expect(authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      auth,
      '/api/v1/workspaces/50587328-441d-4acb-b8f3-dbe1b3c5de99/resolve',
      { method: 'GET' },
      { interactive: false }
    );
    expect(cloudMocks.enrollFleetNode).toHaveBeenCalledWith({
      enrollmentToken: 'ocl_node_enr_minted_secret',
      enrollmentUrl: 'https://cloud.test/api/v1/fleet/register',
    });
  });

  it('cloud enroll --workspace matches an ID or slug ahead of another workspace name', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch)
      .mockResolvedValueOnce({
        response: jsonResponse({
          workspaces: [
            { id: 'ws-1', slug: 'chief', name: 'Decoy' },
            { id: 'ws-2', slug: 'scratch', name: 'chief' },
          ],
        }),
        auth,
      })
      .mockResolvedValueOnce({
        response: jsonResponse({
          workspaceId: 'rw_7ccfea89',
          cloudWorkspaceId: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
        }),
        auth,
      })
      .mockResolvedValueOnce({
        response: jsonResponse({
          token: 'ocl_node_enr_minted_secret',
          enrollmentUrl: 'https://cloud.test/api/v1/fleet/register',
        }),
        auth,
      });
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'chief',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_7ccfea89',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const { program } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'chief']);

    expect(authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      auth,
      '/api/v1/workspaces/ws-1/resolve',
      { method: 'GET' },
      { interactive: false }
    );
  });

  it('cloud enroll --workspace reports an unmatched name without echoing it', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({ workspaces: [{ id: 'ws-1', slug: 'chief', name: 'Chief HQ' }] }),
      auth,
    });
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', '204337648549896192'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(
      "No Cloud workspace matched that name. Run 'agent-relay cloud workspaces' to list the workspaces this login can use."
    );
    expect(deps.error.mock.calls.flat().join('\n')).not.toContain('204337648549896192');
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it('cloud enroll --workspace refuses an ambiguous name and names the candidates', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        workspaces: [
          { id: 'ws-1', slug: 'chief-a', name: 'Chief' },
          { id: 'ws-2', slug: 'chief-b', name: 'chief' },
        ],
      }),
      auth,
    });
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--workspace', 'Chief'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(
      'That name matches 2 Cloud workspaces (ws-1, ws-2). Pass the workspace ID instead.'
    );
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it('cloud whoami prints the organization and workspace IDs, not just names', async () => {
    const auth = { apiUrl: 'https://cloud.test', accessToken: 'access-secret' };
    vi.mocked(ensureAuthenticated).mockResolvedValueOnce(auth as never);
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        authenticated: true,
        source: 'session',
        subjectType: 'user',
        scopes: [],
        user: { id: 'u1', email: 'a@b.test', name: 'A', avatarUrl: null },
        currentOrganization: { id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner', status: 'active' },
        currentWorkspace: {
          id: '50587328-441d-4acb-b8f3-dbe1b3c5de99',
          organization_id: 'org-1',
          slug: 'chief',
          name: 'Chief HQ',
        },
      }),
      auth,
    } as never);
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'whoami']);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('Organization: Acme (org-1)');
    expect(output).toContain('Workspace: Chief HQ (50587328-441d-4acb-b8f3-dbe1b3c5de99)');
  });

  it('cloud whoami still reports a login with no workspace selected', async () => {
    const auth = { apiUrl: 'https://cloud.test', accessToken: 'access-secret' };
    vi.mocked(ensureAuthenticated).mockResolvedValueOnce(auth as never);
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        authenticated: true,
        source: 'session',
        subjectType: 'user',
        scopes: [],
        user: { id: 'u1', email: null, name: null, avatarUrl: null },
        currentOrganization: null,
        currentWorkspace: null,
        workspaceRequired: true,
      }),
      auth,
    } as never);
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'whoami']);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('Organization: (none)');
    expect(output).toContain('Workspace: (none)');
  });

  it('cloud workspaces lists every workspace with its ID', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        workspaces: [
          { id: '50587328-441d-4acb-b8f3-dbe1b3c5de99', slug: 'chief', name: 'Chief HQ' },
          // Terminal control sequences in Cloud-provided text must not survive,
          // in the ID as much as in the name.
          { id: `a1b2c3d4\x1b[2J-0000-4000-8000-000000000000`, slug: 'scratch', name: `Scr\x1b[2Jatch` },
        ],
      }),
      auth,
    });
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'workspaces']);

    expect(authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces',
      { method: 'GET' },
      { interactive: false }
    );
    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('50587328-441d-4acb-b8f3-dbe1b3c5de99');
    expect(output).toContain('Chief HQ');
    expect(output).toContain('Scratch');
    expect(output).toContain('a1b2c3d4-0000-4000-8000-000000000000');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('access-secret');
  });

  it('cloud workspaces prints valid JSON with --json', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({ workspaces: [{ id: 'ws-1', slug: 'chief', name: 'Chief HQ' }] }),
      auth,
    });
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'workspaces', '--json']);

    expect(JSON.parse(vi.mocked(deps.log).mock.calls.flat().join(''))).toEqual({
      workspaces: [{ id: 'ws-1', slug: 'chief', name: 'Chief HQ' }],
    });
  });

  it('cloud workspaces tells logged-out users how to log in', async () => {
    vi.mocked(ensureCloudSession).mockRejectedValueOnce(
      Object.assign(new Error('Cloud login required'), { code: 'AUTH_BROWSER_REQUIRED' })
    );
    const { program, deps } = createHarness();

    await expect(program.parseAsync(['node', 'agent-relay', 'cloud', 'workspaces'])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith('Cloud login required. Run `agent-relay cloud login` and retry.');
  });

  it('cloud workspaces says so when the login has no workspaces', async () => {
    const auth = {
      apiUrl: 'https://cloud.test',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    };
    vi.mocked(ensureCloudSession).mockResolvedValueOnce({ auth, client: {} as never });
    vi.mocked(authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({ workspaces: [] }),
      auth,
    });
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'workspaces']);

    expect(deps.log).toHaveBeenCalledWith('No Cloud workspaces are available to this login.');
  });

  it('cloud enroll rejects --token and --workspace together before using either credential', async () => {
    const { program } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'enroll',
        '--token',
        'ocl_node_enr_existing',
        '--workspace',
        'rw_cloud_123',
      ])
    ).rejects.toThrow(/cannot be used with option/);

    expect(ensureCloudSession).not.toHaveBeenCalled();
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it('cloud enroll requires either --token or --workspace', async () => {
    const { program, deps } = createHarness();

    await expect(program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll'])).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(
      'Either --token or --workspace is required to enroll a fleet node.'
    );
    expect(ensureCloudSession).not.toHaveBeenCalled();
    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });

  it('cloud enroll persists credentials before printing success and never prints the token', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const log = vi.fn();
    const { program } = createHarness({ log });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'enroll',
      '--token',
      'ocl_node_enr_x',
      '--name',
      'kjglaptop',
      '--max-agents',
      '4',
    ]);

    expect(cloudMocks.enrollFleetNode).toHaveBeenCalledWith(
      expect.objectContaining({
        enrollmentToken: 'ocl_node_enr_x',
        name: 'kjglaptop',
        maxAgents: 4,
      })
    );
    // Persist happens BEFORE the success output (token is one-time).
    expect(cloudMocks.upsertFleetNodeEnrollment).toHaveBeenCalledTimes(1);
    expect(cloudMocks.upsertFleetNodeEnrollment.mock.calls[0][0]).toMatchObject({
      nodeToken: 'nt_secret',
      enrolledAt: expect.any(String),
    });
    expect(cloudMocks.upsertFleetNodeEnrollment.mock.invocationCallOrder[0]).toBeLessThan(
      log.mock.invocationCallOrder[0]
    );

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Enrolled node "kjglaptop" (node_abc) in workspace rw_123');
    expect(output).toContain("Run 'relay node up'");
    expect(output).not.toContain('nt_secret');
  });

  it('cloud enroll writes a recovery file (never printing the token) when persistence fails', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    const writeEnrollmentRecoveryFile = vi.fn(() => '/tmp/recovery-123.json');
    const log = vi.fn();
    const error = vi.fn();
    const { program } = createHarness({ log, error, writeEnrollmentRecoveryFile });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--token', 'ocl_node_enr_x'])
    ).rejects.toThrow('exit:1');

    // The one-time token is burned; creds go to a 0600 recovery file and the
    // token must NOT appear on stderr.
    expect(writeEnrollmentRecoveryFile).toHaveBeenCalledWith(
      expect.objectContaining({ nodeToken: 'nt_secret' })
    );
    const stderr = error.mock.calls.flat().join('\n');
    expect(stderr).toContain('persisting credentials failed');
    expect(stderr).toContain('EACCES');
    expect(stderr).toContain('/tmp/recovery-123.json');
    expect(stderr).not.toContain('nt_secret');
    expect(log.mock.calls.flat().join('\n')).not.toContain('Enrolled node');
  });

  it('cloud enroll dumps the credentials to stderr only when the recovery file also fails', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const writeEnrollmentRecoveryFile = vi.fn(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const error = vi.fn();
    const { program } = createHarness({ error, writeEnrollmentRecoveryFile });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--token', 'ocl_node_enr_x'])
    ).rejects.toThrow('exit:1');

    // Last resort: a printed token beats a lost one.
    const stderr = error.mock.calls.flat().join('\n');
    expect(stderr).toContain('SAVE THESE CREDENTIALS');
    expect(stderr).toContain('nt_secret');
  });

  it('cloud enroll --json prints the record without the node token', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const log = vi.fn();
    const { program } = createHarness({ log });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'enroll',
      '--token',
      'ocl_node_enr_x',
      '--json',
    ]);

    const printed = JSON.parse(String(log.mock.calls[0][0]));
    expect(printed).not.toHaveProperty('nodeToken');
    expect(printed).toMatchObject({
      nodeName: 'kjglaptop',
      relayWorkspaceId: 'rw_123',
      enrolledAt: expect.any(String),
    });
  });

  it('cloud enroll surfaces enrollment errors and exits 1 without persisting', async () => {
    cloudMocks.enrollFleetNode.mockRejectedValueOnce(new Error('Enrollment token is invalid'));
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--token', 'bad'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith('Enrollment token is invalid');
    expect(cloudMocks.upsertFleetNodeEnrollment).not.toHaveBeenCalled();
  });

  it('cloud enroll links the enrolled node to this project workspace pin', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const linkEnrolledNodeToProjectPin = vi.fn(() => ({
      status: 'linked',
      nodeId: 'node_abc',
      pinPath: '/repo/.agentworkforce/relay/workspace-key.json',
    })) as unknown as CloudDependencies['linkEnrolledNodeToProjectPin'];
    const log = vi.fn();
    const { program } = createHarness({ log, linkEnrolledNodeToProjectPin });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--token', 'ocl_node_enr_x']);

    expect(linkEnrolledNodeToProjectPin).toHaveBeenCalledWith({ nodeId: 'node_abc' });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('/repo/.agentworkforce/relay/workspace-key.json');
    expect(output).toContain('node_abc');
    // The pinned key holds a workspace *key* and the enrollment holds a
    // workspace *id*, so the link cannot be verified locally. Say which
    // workspace will actually be served and do not claim more than that.
    expect(output).toContain('rw_123');
    expect(output).toContain('was not verified');
  });

  it('cloud enroll warns instead of repointing a pin that names another node', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_new',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const linkEnrolledNodeToProjectPin = vi.fn(() => ({
      status: 'conflict',
      nodeId: 'node_new',
      pinnedNodeId: 'node_existing',
      pinPath: '/repo/.agentworkforce/relay/workspace-key.json',
    })) as unknown as CloudDependencies['linkEnrolledNodeToProjectPin'];
    const warn = vi.fn();
    const { program } = createHarness({ warn, linkEnrolledNodeToProjectPin });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--token', 'ocl_node_enr_x']);

    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toContain('already linked to node node_existing');
    expect(warned).toContain('node_new');
  });

  it('cloud enroll survives a pin write failure without failing the redeemed enrollment', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const linkEnrolledNodeToProjectPin = vi.fn(() => {
      throw new Error('EACCES: permission denied');
    }) as unknown as CloudDependencies['linkEnrolledNodeToProjectPin'];
    const log = vi.fn();
    const warn = vi.fn();
    const { program, deps } = createHarness({ log, warn, linkEnrolledNodeToProjectPin });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'enroll', '--token', 'ocl_node_enr_x']);

    expect(deps.exit).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('Enrolled node "kjglaptop"');
    expect(warn.mock.calls.flat().join('\n')).toContain('EACCES');
  });

  it('cloud enroll --json keeps pin reporting off stdout', async () => {
    cloudMocks.enrollFleetNode.mockResolvedValueOnce({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
    });
    cloudMocks.upsertFleetNodeEnrollment.mockReturnValueOnce({ version: 1, active: {}, nodes: {} });
    const linkEnrolledNodeToProjectPin = vi.fn(() => ({
      status: 'linked',
      nodeId: 'node_abc',
      pinPath: '/repo/.agentworkforce/relay/workspace-key.json',
    })) as unknown as CloudDependencies['linkEnrolledNodeToProjectPin'];
    const log = vi.fn();
    const { program } = createHarness({ log, linkEnrolledNodeToProjectPin });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'enroll',
      '--token',
      'ocl_node_enr_x',
      '--json',
    ]);

    // The pin is still reconciled, but stdout stays parseable JSON.
    expect(linkEnrolledNodeToProjectPin).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(log.mock.calls[0][0]))).not.toThrow();
  });

  it('cloud enroll rejects a non-positive --max-agents', async () => {
    const { program } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'enroll',
        '--token',
        'ocl_node_enr_x',
        '--max-agents',
        '0',
      ])
    ).rejects.toThrow();

    expect(cloudMocks.enrollFleetNode).not.toHaveBeenCalled();
  });
});
