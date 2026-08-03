import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerObserverCommands, type ObserverCommandDependencies } from './observer.js';
import { observerUrl, resolveObserverBaseUrl } from '../lib/observer-url.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const WORKSPACE_KEY = 'rk_live_workspacekey000000';
const FIXED_NOW = Date.parse('2026-08-03T00:00:00.000Z');

function createdToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ot_abc123',
    name: 'observer-cli-deadbeef',
    scopes: ['stream:read', 'messages:read'],
    status: 'active',
    expiresAt: '2026-08-04T00:00:00.000Z',
    createdAt: '2026-08-03T00:00:00.000Z',
    token: 'ot_live_secrettokenmaterial',
    ...overrides,
  };
}

function setup(overrides: Partial<ObserverCommandDependencies> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const createObserverToken = vi.fn(async () => createdToken());
  const listObserverTokens = vi.fn(async () => []);
  const revokeObserverToken = vi.fn(async () => {});

  const program = new Command();
  program.exitOverride();
  registerObserverCommands(program, {
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    error: (...args: unknown[]) => errors.push(args.join(' ')),
    exit: (code: number) => {
      throw new ExitSignal(code);
    },
    createObserverToken: createObserverToken as never,
    listObserverTokens: listObserverTokens as never,
    revokeObserverToken: revokeObserverToken as never,
    now: () => FIXED_NOW,
    randomSuffix: () => 'deadbeef',
    ...overrides,
  });

  return { program, logs, errors, createObserverToken, listObserverTokens, revokeObserverToken };
}

describe('agent-relay observer', () => {
  beforeEach(() => {
    process.env.RELAY_WORKSPACE_KEY = WORKSPACE_KEY;
    delete process.env.RELAY_OBSERVER_URL;
    delete process.env.RELAY_BASE_URL;
  });

  it('mints a scoped token and prints an observer URL carrying the token, not the workspace key', async () => {
    const { program, logs, createObserverToken } = setup();

    await program.parseAsync(['observer'], { from: 'user' });

    const [call] = createObserverToken.mock.calls as unknown as [[Record<string, unknown>]];
    expect(call[0].workspaceKey).toBe(WORKSPACE_KEY);
    // Default posture: DMs excluded, no channel narrowing, 24h lifetime.
    expect(call[0].filters).toEqual({ includeDms: false });
    expect(call[0].expiresAt).toBe(new Date(FIXED_NOW + 24 * 3_600_000).toISOString());

    const url = logs[0];
    expect(url).toBe('https://agentrelay.com/observer?key=ot_live_secrettokenmaterial');
    // The whole point: the administrative credential never reaches the output.
    expect(logs.join('\n')).not.toContain(WORKSPACE_KEY);
  });

  it('narrows to channels and includes DMs when asked', async () => {
    const { program, createObserverToken } = setup();

    await program.parseAsync(
      ['observer', '--channels', '#general, build ,general', '--include-dms', '--expires', '7d'],
      { from: 'user' }
    );

    const [call] = createObserverToken.mock.calls as unknown as [[Record<string, unknown>]];
    // Leading `#` stripped and duplicates collapsed.
    expect(call[0].filters).toEqual({ includeDms: true, channelNames: ['general', 'build'] });
    expect(call[0].expiresAt).toBe(new Date(FIXED_NOW + 7 * 86_400_000).toISOString());
  });

  it('rejects a bare-number expiry rather than guessing a unit', async () => {
    const { program } = setup();

    await expect(
      program.parseAsync(['observer', '--expires', '24'], { from: 'user' })
    ).rejects.toThrow(/30m, 24h, or 7d/);
  });

  it('fails loudly when the engine returns no token material', async () => {
    const { program, errors } = setup({
      createObserverToken: vi.fn(async () => createdToken({ token: undefined })) as never,
    });

    await expect(program.parseAsync(['observer'], { from: 'user' })).rejects.toBeInstanceOf(
      ExitSignal
    );
    expect(errors.join('\n')).toContain('did not include token material');
  });

  it('list never prints token material', async () => {
    const { program, logs } = setup({
      listObserverTokens: vi.fn(async () => [
        createdToken({ token: undefined, lastUsedAt: null }),
      ]) as never,
    });

    await program.parseAsync(['observer', 'list'], { from: 'user' });

    expect(logs.join('\n')).toContain('ot_abc123');
    expect(logs.join('\n')).not.toContain('ot_live_');
  });

  it('revokes by id', async () => {
    const { program, revokeObserverToken, logs } = setup();

    await program.parseAsync(['observer', 'revoke', 'ot_abc123'], { from: 'user' });

    const [call] = revokeObserverToken.mock.calls as unknown as [[Record<string, unknown>]];
    expect(call[0]).toMatchObject({ workspaceKey: WORKSPACE_KEY, id: 'ot_abc123' });
    expect(logs.join('\n')).toContain('Revoked ot_abc123.');
  });
});

describe('observer URL construction', () => {
  it('refuses to build a URL from a workspace key', () => {
    expect(() => observerUrl('https://agentrelay.com/observer', WORKSPACE_KEY)).toThrow(
      /scoped observer token/
    );
  });

  it('prefers an explicit URL, then RELAY_OBSERVER_URL, then the hosted default', () => {
    const env = { RELAY_OBSERVER_URL: 'https://observer.relaycast.dev' } as NodeJS.ProcessEnv;
    expect(resolveObserverBaseUrl('https://example.test/observer', env)).toBe(
      'https://example.test/observer'
    );
    expect(resolveObserverBaseUrl(undefined, env)).toBe('https://observer.relaycast.dev');
    expect(resolveObserverBaseUrl(undefined, {} as NodeJS.ProcessEnv)).toBe(
      'https://agentrelay.com/observer'
    );
  });

  it('rejects a malformed observer URL instead of emitting a broken link', () => {
    expect(() => resolveObserverBaseUrl('not-a-url', {} as NodeJS.ProcessEnv)).toThrow(
      /Invalid observer URL/
    );
  });
});
