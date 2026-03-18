import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';

import { ensureLocalSdkWorkflowRuntime, findLocalSdkWorkspace, registerSetupCommands, type SetupDependencies } from './setup.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createHarness(overrides: Partial<SetupDependencies> = {}) {
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as SetupDependencies['exit'];

  const deps: SetupDependencies = {
    runInit: vi.fn(async () => undefined),
    runTelemetry: vi.fn(async () => undefined),
    runYamlWorkflow: vi.fn(async () => ({ status: 'completed' })),
    runScriptWorkflow: vi.fn(() => undefined),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
    ...overrides,
  };

  const program = new Command();
  registerSetupCommands(program, deps);

  return { program, deps };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    throw err;
  }
}

describe('local SDK workflow runtime bootstrapping', () => {
  it('finds the agent-relay workspace root from a nested directory', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-workspace-'));
    const nestedDir = path.join(tempRoot, 'workflows', 'nested');
    const sdkDir = path.join(tempRoot, 'packages', 'sdk');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'agent-relay' }));
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@agent-relay/sdk' }));

    expect(findLocalSdkWorkspace(nestedDir)).toEqual({ rootDir: tempRoot, sdkDir });

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('builds the local sdk when the workflows dist entry is missing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-build-'));
    const nestedDir = path.join(tempRoot, 'workflows');
    const sdkDir = path.join(tempRoot, 'packages', 'sdk');
    const workflowsDistDir = path.join(sdkDir, 'dist', 'workflows');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'agent-relay' }));
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@agent-relay/sdk' }));

    const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      fs.mkdirSync(workflowsDistDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDistDir, 'index.js'), 'export {}\n');
      return Buffer.from('');
    });

    ensureLocalSdkWorkflowRuntime(nestedDir);

    expect(execSpy).toHaveBeenCalledWith(
      'npm',
      ['run', 'build:sdk'],
      expect.objectContaining({ cwd: tempRoot, stdio: 'inherit' }),
    );

    execSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe('registerSetupCommands', () => {
  it('registers setup commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(expect.arrayContaining(['init', 'setup', 'telemetry', 'run']));
  });

  it('routes both init and setup alias to runInit', async () => {
    const { program, deps } = createHarness();

    await runCommand(program, ['init', '--yes', '--skip-broker']);
    await runCommand(program, ['setup', '--yes']);

    expect((deps.runInit as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toMatchObject({
      yes: true,
      skipBroker: true,
    });
    expect((deps.runInit as unknown as { mock: { calls: unknown[][] } }).mock.calls[1][0]).toMatchObject({
      yes: true,
    });
  });

  it('routes telemetry action', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['telemetry', 'enable']);

    expect(exitCode).toBeUndefined();
    expect(deps.runTelemetry).toHaveBeenCalledWith('enable');
  });

  it('routes run command based on file extension', async () => {
    const { program, deps } = createHarness();

    await runCommand(program, ['run', 'workflow.yaml', '--workflow', 'main']);
    await runCommand(program, ['run', 'workflow.py', '--resume', 'run-123', '--start-from', 'step-a', '--previous-run-id', 'run-122']);

    expect(deps.runYamlWorkflow).toHaveBeenCalledWith('workflow.yaml', {
      workflow: 'main',
      onEvent: expect.any(Function),
    });
    expect(deps.runScriptWorkflow).toHaveBeenCalledWith('workflow.py', {
      dryRun: undefined,
      resume: 'run-123',
      startFrom: 'step-a',
      previousRunId: 'run-122',
    });
  });

  it('prints resume hints when a script workflow fails', async () => {
    const { program, deps } = createHarness({
      runScriptWorkflow: vi.fn(() => {
        throw new Error('script failed');
      }),
    });

    const exitCode = await runCommand(program, ['run', 'workflow.ts']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Error: script failed');
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining('agent-relay run workflow.ts --resume <run-id>')
    );
  });

  it('prints a copy-pasteable resume command when the script error includes a run id', async () => {
    const { program, deps } = createHarness({
      runScriptWorkflow: vi.fn(() => {
        throw new Error('script failed\nRun ID: run-456');
      }),
    });

    const exitCode = await runCommand(program, ['run', 'workflow.ts']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Run ID: run-456 — resume with: agent-relay run workflow.ts --resume run-456'
    );
  });

  it('exits with code 1 for unsupported run file extension', async () => {
    const { program } = createHarness();

    const exitCode = await runCommand(program, ['run', 'workflow.txt']);

    expect(exitCode).toBe(1);
  });
});
