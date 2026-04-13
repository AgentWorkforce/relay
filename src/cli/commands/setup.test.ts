import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureLocalSdkWorkflowRuntime,
  findLocalSdkWorkspace,
  formatWorkflowParseError,
  parseTsxStderr,
  registerSetupCommands,
  type SetupDependencies,
} from './setup.js';

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

    const execRunner = vi.fn(() => {
      fs.mkdirSync(workflowsDistDir, { recursive: true });
      fs.writeFileSync(path.join(workflowsDistDir, 'index.js'), 'export {}\n');
      return Buffer.from('');
    });

    ensureLocalSdkWorkflowRuntime(nestedDir, execRunner as never);

    expect(execRunner).toHaveBeenCalledWith(
      'npm',
      ['run', 'build:sdk'],
      expect.objectContaining({ cwd: tempRoot, stdio: 'inherit' })
    );
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
    await runCommand(program, [
      'run',
      'workflow.py',
      '--resume',
      'run-123',
      '--start-from',
      'step-a',
      '--previous-run-id',
      'run-122',
    ]);

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

describe('parseTsxStderr', () => {
  it('returns null for empty stderr', () => {
    expect(parseTsxStderr('')).toBeNull();
  });

  it('returns null for runtime errors with no parse signature', () => {
    const stderr = [
      'node:internal/modules/run_main:123',
      '    triggerUncaughtException(',
      '    ^',
      'Error: something blew up at runtime',
      '    at Object.<anonymous> (/path/to/workflow.ts:5:10)',
    ].join('\n');
    expect(parseTsxStderr(stderr)).toBeNull();
  });

  it('parses the inline "file:line:col: ERROR: message" format', () => {
    const stderr = [
      'node:internal/modules/run_main:123',
      '    triggerUncaughtException(',
      '    ^',
      'Error [TransformError]: Transform failed with 1 error:',
      '/path/to/workflow.ts:1073:4: ERROR: Expected "}" but found "npm"',
      '    at failureErrorWithLog (... lib/main.js:1748:15)',
    ].join('\n');

    expect(parseTsxStderr(stderr)).toEqual({
      file: '/path/to/workflow.ts',
      line: 1073,
      column: 4,
      message: 'Expected "}" but found "npm"',
    });
  });

  it('parses the pretty-printed ✘ [ERROR] multi-line format', () => {
    const stderr = [
      '✘ [ERROR] Unterminated template literal',
      '',
      '    /path/to/workflow.ts:42:10:',
      '      42 │   command: `echo hello',
      '         ╵           ^',
    ].join('\n');

    expect(parseTsxStderr(stderr)).toEqual({
      file: '/path/to/workflow.ts',
      line: 42,
      column: 10,
      message: 'Unterminated template literal',
    });
  });

  it('strips ANSI color codes before matching', () => {
    const stderr = [
      '\x1b[31mError [TransformError]: Transform failed with 1 error:\x1b[0m',
      '\x1b[1m/path/to/workflow.ts:10:5:\x1b[0m \x1b[31mERROR:\x1b[0m Expected "}" but found "foo"',
    ].join('\n');

    const parsed = parseTsxStderr(stderr);
    expect(parsed).not.toBeNull();
    expect(parsed?.line).toBe(10);
    expect(parsed?.column).toBe(5);
    expect(parsed?.message).toBe('Expected "}" but found "foo"');
  });

  it('falls back to a loose match on "Transform failed" without inline ERROR:', () => {
    const stderr = [
      'Error [TransformError]: Transform failed with 1 error:',
      '    /path/to/workflow.ts:99:7',
      '    at failureErrorWithLog',
    ].join('\n');

    const parsed = parseTsxStderr(stderr);
    expect(parsed).not.toBeNull();
    expect(parsed?.file).toBe('/path/to/workflow.ts');
    expect(parsed?.line).toBe(99);
    expect(parsed?.column).toBe(7);
  });
});

describe('formatWorkflowParseError', () => {
  it('formats a basic parse error without hints when the message is generic', () => {
    const err = formatWorkflowParseError({
      file: '/tmp/wf.ts',
      line: 10,
      column: 5,
      message: 'Some unrelated TypeScript error',
    });

    expect(err.message).toContain('Workflow file failed to parse: /tmp/wf.ts:10:5');
    expect(err.message).toContain('Some unrelated TypeScript error');
    expect(err.message).not.toContain('Hint:');
    expect((err as Error & { code?: string }).code).toBe('WORKFLOW_PARSE_ERROR');
  });

  it('adds a template-literal hint for Expected "}" but found errors', () => {
    const err = formatWorkflowParseError({
      file: '/tmp/wf.ts',
      line: 1073,
      column: 4,
      message: 'Expected "}" but found "npm"',
    });

    expect(err.message).toMatch(/Hint:/);
    expect(err.message).toMatch(/template literal/i);
    expect(err.message).toMatch(/single quotes/);
  });

  it('adds a template-literal hint for Unterminated template literal errors', () => {
    const err = formatWorkflowParseError({
      file: '/tmp/wf.ts',
      line: 42,
      column: 10,
      message: 'Unterminated template literal',
    });

    expect(err.message).toMatch(/Hint:/);
    expect(err.message).toMatch(/backticks/i);
  });

  it('adds a dollar-sign hint for Unexpected "$" errors', () => {
    const err = formatWorkflowParseError({
      file: '/tmp/wf.ts',
      line: 1,
      column: 0,
      message: 'Unexpected "$"',
    });

    expect(err.message).toMatch(/Hint:/);
    expect(err.message).toMatch(/interpolation/);
  });

  it('includes a line-text pointer when lineText is provided', () => {
    const err = formatWorkflowParseError({
      file: '/tmp/wf.ts',
      line: 10,
      column: 12,
      message: 'Expected "}" but found "x"',
      lineText: '  command: `echo foo`',
    });

    expect(err.message).toContain('| ');
    expect(err.message).toContain('echo foo');
    // The ^ pointer should be 12 spaces offset into the indented line
    expect(err.message).toMatch(/\|\s+\^/);
  });
});
