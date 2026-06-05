import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerLocalWorkflowCommands, type LocalWorkflowDependencies } from './local-workflow.js';

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
});
