import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerLocalWorkflowCommands,
  resolveLocalWorkflowCommand,
  type LocalWorkflowDependencies,
} from './local-workflow.js';

vi.mock('../telemetry/index.js', () => ({
  track: vi.fn(),
}));

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const tmpRoots: string[] = [];

function createHarness(overrides: Partial<LocalWorkflowDependencies> = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-workflow-cli-'));
  tmpRoots.push(tmpRoot);

  const logs: string[] = [];
  const errors: string[] = [];
  let stdout = '';

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as LocalWorkflowDependencies['exit'];

  const deps: Partial<LocalWorkflowDependencies> = {
    cwd: () => tmpRoot,
    env: { ...process.env },
    randomRunId: () => 'local_test123',
    sleep: async () => undefined,
    writeStdout: (text: string) => {
      stdout += text;
    },
    log: (...args: unknown[]) => {
      logs.push(args.join(' '));
    },
    error: (...args: unknown[]) => {
      errors.push(args.join(' '));
    },
    exit,
    resolveRelayflowsCliEntrypoint: () => path.join(tmpRoot, 'relayflows-cli.js'),
    ...overrides,
  };

  const program = new Command();
  program.exitOverride();
  registerLocalWorkflowCommands(program, deps);

  return {
    program,
    tmpRoot,
    logs,
    errors,
    getStdout: () => stdout,
  };
}

async function waitForRunStatus(
  tmpRoot: string,
  runId: string,
  status: string
): Promise<Record<string, unknown>> {
  const metadataPath = path.join(tmpRoot, '.agentworkforce', 'relay', 'local-runs', runId, 'run.json');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(metadataPath)) {
      const record = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
      if (record.status === status) {
        return record;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${runId} to become ${status}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const tmpRoot of tmpRoots.splice(0)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe('registerLocalWorkflowCommands', () => {
  it('registers local run, logs, and sync commands', () => {
    const { program } = createHarness();

    expect(program.commands.map((command) => command.name())).toEqual(['run', 'logs', 'sync']);
  });

  it('prints follow-up hints for the nested `node workflow` group', async () => {
    const { tmpRoot, logs } = createHarness();
    // Register onto a nested `node workflow` subgroup on a fresh root so the
    // hint prefix walks the real parent chain (node -> workflow).
    const root = new Command();
    root.exitOverride();
    const workflowGroup = root.command('node').command('workflow');
    registerLocalWorkflowCommands(workflowGroup, {
      cwd: () => tmpRoot,
      env: { ...process.env },
      randomRunId: () => 'local_test123',
      sleep: async () => undefined,
      log: (...args: unknown[]) => {
        logs.push(args.join(' '));
      },
    });

    fs.writeFileSync(path.join(tmpRoot, 'workflow.js'), 'console.log("hi");\n', 'utf-8');
    await root.parseAsync(['node', 'workflow', 'run', 'workflow.js'], { from: 'user' });

    expect(logs).toContain('\nView logs:  agent-relay node workflow logs local_test123 --follow');
    expect(logs).toContain('Sync code:  agent-relay node workflow sync local_test123');
    await waitForRunStatus(tmpRoot, 'local_test123', 'completed');
  });

  it('runs a JavaScript workflow in the background and exposes logs and sync state', async () => {
    const { program, tmpRoot, logs, getStdout } = createHarness();
    const workflowPath = path.join(tmpRoot, 'workflow.js');
    fs.writeFileSync(
      workflowPath,
      [
        'console.log("workflow started", process.env.AGENT_RELAY_LOCAL_RUN_ID);',
        'await new Promise((resolve) => setTimeout(resolve, 25));',
        'console.error("workflow finished");',
      ].join('\n'),
      'utf-8'
    );

    await program.parseAsync(['run', 'workflow.js'], { from: 'user' });

    expect(logs).toContain('Run created: local_test123');
    await waitForRunStatus(tmpRoot, 'local_test123', 'completed');

    await program.parseAsync(['logs', 'local_test123', '--follow', '--poll-interval', '1'], { from: 'user' });
    expect(getStdout()).toContain('workflow started local_test123');
    expect(getStdout()).toContain('workflow finished');

    await program.parseAsync(['sync', 'local_test123'], { from: 'user' });
    expect(logs).toContain('Local workflow ran in this checkout; no patch sync is required.');
  });

  it('records actionable guidance when the detached monitor cannot start Node', async () => {
    const monitor = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    monitor.pid = 4242;
    monitor.unref = vi.fn();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => monitor.emit('error', new Error('spawn node ENOENT')));
      return monitor;
    }) as never;
    const { program, tmpRoot, errors } = createHarness({
      spawnProcess,
      argv: ['bun', '/$bunfs/root/cli/index.js'],
      cliScript: '/$bunfs/root/cli/index.js',
      execPath: '/tmp/agent-relay',
    });
    fs.writeFileSync(path.join(tmpRoot, 'workflow.js'), 'console.log("workflow");\n', 'utf-8');

    await program.parseAsync(['run', 'workflow.js'], { from: 'user' });

    const record = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.agentworkforce/relay/local-runs/local_test123/run.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(record.status).toBe('failed');
    expect(record.monitorPid).toBeUndefined();
    expect(record.error).toMatch(/Node.js executable.*AGENT_RELAY_NODE/);
    expect(errors.join('\n')).toMatch(/Node.js executable.*AGENT_RELAY_NODE/);
  });

  it.each([
    ['YAML', 'workflow.yaml', 'version: "1.0"\n'],
    ['YML', 'workflow.yml', 'version: "1.0"\n'],
    ['TypeScript', 'workflow.ts', 'console.log("workflow");\n'],
    ['TSX', 'workflow.tsx', 'console.log("workflow");\n'],
    ['Python', 'workflow.py', 'print("workflow")\n'],
  ])('delegates %s workflow runs to the relayflows CLI', async (_label, fileName, contents) => {
    const spawnProcess = vi.fn(() => ({
      pid: 4242,
      unref: vi.fn(),
    })) as unknown as LocalWorkflowDependencies['spawnProcess'];
    const { program, tmpRoot } = createHarness({ spawnProcess });
    const workflowPath = path.join(tmpRoot, fileName);
    const relayflowsCliPath = path.join(tmpRoot, 'relayflows-cli.js');
    fs.writeFileSync(workflowPath, contents, 'utf-8');

    await program.parseAsync(['run', fileName], { from: 'user' });

    const metadataPath = path.join(
      tmpRoot,
      '.agentworkforce',
      'relay',
      'local-runs',
      'local_test123',
      'run.json'
    );
    const record = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
    expect(record.command).toBe(process.execPath);
    expect(record.args).toEqual([relayflowsCliPath, 'run', workflowPath]);
    expect(record.status).toBe('running');
  });

  it('uses a real Node child and resolves relayflows from the workflow project in compiled Bun mode', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-workflow-runtime-'));
    tmpRoots.push(tmpRoot);
    const workflowPath = path.join(tmpRoot, 'workflow.yaml');
    fs.writeFileSync(workflowPath, 'version: "1.0"\n', 'utf-8');
    const execFile = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => callback(null, '/project/node_modules/@relayflows/cli/dist/cli.js\n', '')
    );

    const command = await resolveLocalWorkflowCommand(workflowPath, 'yaml', {
      ...({} as LocalWorkflowDependencies),
      argv: ['bun', '/$bunfs/root/cli/index.js'],
      cliScript: '/$bunfs/root/cli/index.js',
      execPath: '/tmp/agent-relay',
      env: { AGENT_RELAY_NODE: ' /opt/node/bin/node ' },
      execFile: execFile as never,
    });

    expect(command).toEqual({
      command: '/opt/node/bin/node',
      args: ['/project/node_modules/@relayflows/cli/dist/cli.js', 'run', workflowPath],
    });
    expect(execFile).toHaveBeenCalledWith(
      '/opt/node/bin/node',
      expect.arrayContaining(['@relayflows/cli', tmpRoot]),
      expect.objectContaining({ cwd: tmpRoot }),
      expect.any(Function)
    );
  });

  it('keeps normal Node relayflows resolution anchored to the installed CLI for an external workflow', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-workflow-external-'));
    tmpRoots.push(tmpRoot);
    const workflowPath = path.join(tmpRoot, 'workflow.yaml');
    fs.writeFileSync(workflowPath, 'version: "1.0"\nworkflows: []\n', 'utf-8');
    const spawnProcess = vi.fn(() => ({
      pid: 42,
      unref: vi.fn(),
    })) as unknown as LocalWorkflowDependencies['spawnProcess'];
    const program = new Command();
    program.exitOverride();
    registerLocalWorkflowCommands(program, {
      cwd: () => tmpRoot,
      env: { ...process.env },
      spawnProcess,
      randomRunId: () => 'local_external',
      sleep: async () => undefined,
      log: vi.fn(),
    });

    await program.parseAsync(['run', workflowPath], { from: 'user' });

    expect(spawnProcess.mock.calls[0]?.[0]).toBe(process.execPath);
    const record = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, '.agentworkforce/relay/local-runs/local_external/run.json'), 'utf-8')
    ) as { command: string; args: string[] };
    expect(record.command).toBe(process.execPath);
    expect(record.args).toEqual([
      expect.stringMatching(/node_modules[\\/]@relayflows[\\/]cli/),
      'run',
      workflowPath,
    ]);
  });
});
