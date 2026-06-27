import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerReflexCommands, type ReflexDependencies } from './reflex.js';

const ENABLED_AT = '2026-06-27T00:00:00.000Z';

let tmpHome: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ENABLED_AT));

  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-home-'));
});

afterEach(() => {
  vi.useRealTimers();

  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = undefined;
  }
});

function createHarness(overrides?: Partial<ReflexDependencies>) {
  if (!tmpHome) {
    throw new Error('tmpHome was not initialized');
  }

  const deps: ReflexDependencies = {
    fs,
    homedir: vi.fn(() => tmpHome),
    spawnSync: vi.fn(() => ({ status: 0, signal: null, output: [], pid: 0, stdout: null, stderr: null })),
    prompt: vi.fn(async () => true),
    log: vi.fn(() => undefined),
    ...overrides,
  };

  const program = new Command();
  program.exitOverride();
  registerReflexCommands(program, deps);
  return { program, deps };
}

function statePath(): string {
  if (!tmpHome) {
    throw new Error('tmpHome was not initialized');
  }
  return path.join(tmpHome, '.agentworkforce', 'reflex.json');
}

function readState(): unknown {
  return JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
}

function outputLines(deps: ReflexDependencies): string[] {
  return vi.mocked(deps.log).mock.calls.map((call) => String(call[0]));
}

describe('registerReflexCommands', () => {
  it('reflex on with consent accepted writes enabled state, logs in, and prints success', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(readState()).toEqual({
      enabled: true,
      enabledAt: ENABLED_AT,
    });
    expect(deps.prompt).toHaveBeenCalledWith('Enable Reflex? (y/N) ');
    expect(deps.spawnSync).toHaveBeenCalledWith('ai-hist', ['--version'], { stdio: 'ignore' });
    expect(deps.spawnSync).toHaveBeenCalledWith('ai-hist', ['login', '--cloud'], { stdio: 'inherit' });
    expect(outputLines(deps)).toEqual(
      expect.arrayContaining([
        'Reflex will capture your agent sessions and sync to history.agentrelay.com',
        'Reflex is on.',
        'State file: ~/.agentworkforce/reflex.json',
      ])
    );
  });

  it('reflex off writes disabled state and prints confirmation', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'off']);

    expect(readState()).toEqual({ enabled: false });
    expect(outputLines(deps)).toContain('Reflex is off.');
  });

  it('reflex status with existing enabled state prints enabled status and timestamp', async () => {
    const { program, deps } = createHarness();
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(
      statePath(),
      JSON.stringify(
        {
          enabled: true,
          enabledAt: ENABLED_AT,
        },
        null,
        2
      ),
      'utf-8'
    );

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'status']);

    expect(outputLines(deps)).toEqual(['Reflex is on.', `Enabled at: ${ENABLED_AT}`]);
  });

  it('reflex status with malformed JSON treats the state as absent', async () => {
    const { program, deps } = createHarness();
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), '{malformed', 'utf-8');

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'status']);

    expect(outputLines(deps)).toEqual(['Reflex is off (never enabled).']);
  });

  it('reflex on with consent denied does not write state or run cloud login', async () => {
    const prompt = vi.fn(async () => false);
    const { program, deps } = createHarness({ prompt });

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(fs.existsSync(statePath())).toBe(false);
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(outputLines(deps)).toEqual([
      'Reflex will capture your agent sessions and sync to history.agentrelay.com',
      'Reflex was not enabled.',
    ]);
  });

  it('reflex status when state file is missing prints the never-enabled status', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'status']);

    expect(outputLines(deps)).toEqual(['Reflex is off (never enabled).']);
  });

  it('reflex on with missing ai-hist still writes state and prints install hint', async () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      signal: null,
      output: [],
      pid: 0,
      stdout: null,
      stderr: null,
      error: Object.assign(new Error('missing ai-hist'), { code: 'ENOENT' }),
    }));
    const { program, deps } = createHarness({ spawnSync });

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(readState()).toEqual({
      enabled: true,
      enabledAt: ENABLED_AT,
    });
    expect(deps.spawnSync).toHaveBeenCalledTimes(1);
    expect(outputLines(deps)).toContain(
      'ai-hist is not installed or not on PATH. Install it to sync Reflex history: npm install -g @agent-relay/ai-history'
    );
    expect(outputLines(deps)).toContain('Reflex is on.');
  });

  it('reflex on with a failed ai-hist version probe warns and skips cloud login', async () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      signal: null,
      output: [],
      pid: 0,
      stdout: null,
      stderr: null,
      error: Object.assign(new Error('ai-hist cannot execute'), { code: 'EACCES' }),
    }));
    const { program, deps } = createHarness({ spawnSync });

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(readState()).toEqual({
      enabled: true,
      enabledAt: ENABLED_AT,
    });
    expect(deps.spawnSync).toHaveBeenCalledTimes(1);
    expect(outputLines(deps)).toContain(
      'Reflex is enabled locally, but cloud login did not complete (ai-hist failed with EACCES).'
    );
    expect(outputLines(deps)).toContain('Reflex is on.');
  });

  it('reflex on with a failed ai-hist cloud login warns instead of treating it as complete', async () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, signal: null, output: [], pid: 0, stdout: null, stderr: null })
      .mockReturnValueOnce({
        status: null,
        signal: null,
        output: [],
        pid: 0,
        stdout: null,
        stderr: null,
        error: Object.assign(new Error('ai-hist cannot execute'), { code: 'EACCES' }),
      });
    const { program, deps } = createHarness({ spawnSync });

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(deps.spawnSync).toHaveBeenCalledTimes(2);
    expect(outputLines(deps)).toContain(
      'Reflex is enabled locally, but cloud login did not complete (ai-hist failed with EACCES).'
    );
    expect(outputLines(deps)).toContain('Reflex is on.');
  });
});
