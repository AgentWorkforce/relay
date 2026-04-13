import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureLocalSdkWorkflowRuntime,
  findLocalSdkWorkspace,
  preParseWorkflowFile,
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

describe('preParseWorkflowFile', () => {
  function writeTempWorkflow(name: string, contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preparse-'));
    const full = path.join(dir, name);
    fs.writeFileSync(full, contents, 'utf8');
    return full;
  }

  it('returns silently for a valid TypeScript workflow file', async () => {
    const file = writeTempWorkflow(
      'valid.ts',
      `
import { workflow } from '@agent-relay/sdk/workflows';
workflow('w')
  .pattern('dag')
  .step('one', {
    type: 'deterministic',
    command: 'echo hi',
  });
`.trim()
    );
    await expect(preParseWorkflowFile(file)).resolves.toBeUndefined();
  });

  it('wraps a raw backtick inside a template literal with an actionable hint', async () => {
    // A raw backtick inside a command: template literal terminates
    // the outer JS template literal early and produces an esbuild
    // parse error. We want the error message to tell the user how
    // to fix it.
    const file = writeTempWorkflow(
      'bad-backtick.ts',
      ['const step = {', '  command: `git commit -m "use `npm install` here"`,', '};'].join('\n')
    );
    await expect(preParseWorkflowFile(file)).rejects.toThrow(/Workflow file failed to parse/);
    try {
      await preParseWorkflowFile(file);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/Hint:/);
      expect(msg).toMatch(/single quotes/);
    }
  });

  it('wraps an unescaped ${} interpolation with an actionable hint', async () => {
    // Not strictly a parse error in isolation, but combined with a
    // bad identifier makes esbuild fail. We mostly want to verify the
    // hint path fires for the common error text.
    const file = writeTempWorkflow(
      'bad-dollar.ts',
      ['const step = {', '  command: `echo ${NOT a valid JS expression}`,', '};'].join('\n')
    );
    await expect(preParseWorkflowFile(file)).rejects.toThrow(/Workflow file failed to parse/);
  });

  it('times out after PREPARSE_TIMEOUT_MS and resolves without throwing when the transform hangs', async () => {
    const file = writeTempWorkflow(
      'hang.ts',
      `
import { workflow } from '@agent-relay/sdk/workflows';
workflow('w');
`.trim()
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    vi.resetModules();
    vi.doMock('esbuild', async () => {
      const actual = await vi.importActual<typeof import('esbuild')>('esbuild');
      return {
        ...actual,
        transform: vi.fn(() => new Promise(() => {})),
      };
    });

    vi.useFakeTimers();

    try {
      const { preParseWorkflowFile: preParseWorkflowFileWithHungTransform } = await import('./setup.js');
      const parsePromise = preParseWorkflowFileWithHungTransform(file);

      await vi.advanceTimersByTimeAsync(5001);
      await expect(parsePromise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pre-parse timed out after 5000ms'));
    } finally {
      vi.useRealTimers();
      vi.doUnmock('esbuild');
      vi.resetModules();
      warnSpy.mockRestore();
    }
  });

  it('propagates non-parse errors unchanged', async () => {
    // Non-existent file should throw the fs-level error, not a fake parse wrapper.
    await expect(preParseWorkflowFile('/tmp/does-not-exist-' + Date.now() + '.ts')).rejects.toThrow(
      /Cannot read workflow file/
    );
  });
});
