import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerReflexCommands, type ReflexDependencies } from './reflex.js';

const ENABLED_AT = '2026-06-27T00:00:00.000Z';
const FAKE_RELAY_TOKEN = 'rly_test_access_token';

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
    readRelayAuth: vi.fn(async () => ({ accessToken: FAKE_RELAY_TOKEN })),
    loginToCloud: vi.fn(async () => ({ ok: true as const })),
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
  it('reflex on with consent accepted writes enabled state, logs in via SDK, and prints success', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(readState()).toEqual({
      enabled: true,
      enabledAt: ENABLED_AT,
    });
    expect(deps.prompt).toHaveBeenCalledWith('Enable Reflex? (y/N) ');
    expect(deps.readRelayAuth).toHaveBeenCalled();
    expect(deps.loginToCloud).toHaveBeenCalledWith(FAKE_RELAY_TOKEN);
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

  it('reflex on with consent denied does not write state or call cloud login', async () => {
    const prompt = vi.fn(async () => false);
    const { program, deps } = createHarness({ prompt });

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(fs.existsSync(statePath())).toBe(false);
    expect(deps.readRelayAuth).not.toHaveBeenCalled();
    expect(deps.loginToCloud).not.toHaveBeenCalled();
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

  it('reflex on when not logged in to Agent Relay still writes state and prints login hint', async () => {
    const readRelayAuth = vi.fn(async () => null);
    const { program, deps } = createHarness({ readRelayAuth });

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(readState()).toEqual({
      enabled: true,
      enabledAt: ENABLED_AT,
    });
    expect(deps.loginToCloud).not.toHaveBeenCalled();
    expect(outputLines(deps)).toContain(
      'Not logged in to Agent Relay. Run `agent-relay login` first to sync Reflex history to the cloud.'
    );
    expect(outputLines(deps)).toContain('Reflex is on.');
  });

  it('reflex on when cloud login fails warns instead of treating it as complete', async () => {
    const loginToCloud = vi.fn(async () => ({
      ok: false as const,
      error: 'Login failed (HTTP 401): Unauthorized',
    }));
    const { program, deps } = createHarness({ loginToCloud });

    await program.parseAsync(['node', 'agent-relay', 'reflex', 'on']);

    expect(readState()).toEqual({
      enabled: true,
      enabledAt: ENABLED_AT,
    });
    expect(outputLines(deps)).toContain(
      'Reflex is enabled locally, but cloud login did not complete: Login failed (HTTP 401): Unauthorized'
    );
    expect(outputLines(deps)).toContain('Reflex is on.');
  });
});
