import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  // Build the dep set once and hand back exactly what was registered, so a test
  // that overrides a mock inspects the same instance the command called rather
  // than the untouched default.
  const deps = {
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
  };

  const program = new Command();
  program.exitOverride();
  registerObserverCommands(program, deps);

  return {
    program,
    logs,
    errors,
    createObserverToken: deps.createObserverToken as unknown as ReturnType<typeof vi.fn>,
    listObserverTokens: deps.listObserverTokens as unknown as ReturnType<typeof vi.fn>,
    revokeObserverToken: deps.revokeObserverToken as unknown as ReturnType<typeof vi.fn>,
  };
}

describe('agent-relay observer', () => {
  beforeEach(() => {
    // Stub rather than assign: a direct `process.env` mutation outlives this
    // suite and leaks a workspace key into every test file that runs after it.
    vi.stubEnv('RELAY_WORKSPACE_KEY', WORKSPACE_KEY);
    vi.stubEnv('RELAY_OBSERVER_URL', '');
    vi.stubEnv('RELAY_BASE_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

    await expect(program.parseAsync(['observer', '--expires', '24'], { from: 'user' })).rejects.toThrow(
      /30m, 24h, or 7d/
    );
  });

  it('fails loudly when the engine returns no token material', async () => {
    const { program, errors } = setup({
      createObserverToken: vi.fn(async () => createdToken({ token: undefined })) as never,
    });

    await expect(program.parseAsync(['observer'], { from: 'user' })).rejects.toBeInstanceOf(ExitSignal);
    expect(errors.join('\n')).toContain('did not include token material');
  });

  it('list never prints token material', async () => {
    const { program, logs } = setup({
      listObserverTokens: vi.fn(async () => [createdToken({ token: undefined, lastUsedAt: null })]) as never,
    });

    await program.parseAsync(['observer', 'list'], { from: 'user' });

    expect(logs.join('\n')).toContain('ot_abc123');
    expect(logs.join('\n')).not.toContain('ot_live_');
  });

  it('honours flags on subcommands even though the parent declares the same names', async () => {
    // Regression: Commander binds a repeated option to the ancestor that
    // declared it first, so reading the subcommand's local opts returned {} and
    // silently dropped both --json and --workspace-key.
    const { program, logs, listObserverTokens } = setup({
      listObserverTokens: vi.fn(async () => [createdToken({ token: undefined })]) as never,
    });

    await program.parseAsync(
      ['observer', 'list', '--json', '--workspace-key', 'rk_live_explicitkey00000'],
      { from: 'user' }
    );

    const [call] = listObserverTokens.mock.calls as unknown as [[Record<string, unknown>]];
    expect(call[0].workspaceKey).toBe('rk_live_explicitkey00000');
    expect(() => JSON.parse(logs.join('\n'))).not.toThrow();
  });

  it('validates the observer URL before minting, so a bad config leaves no live token', async () => {
    const { program, errors, createObserverToken } = setup();

    await expect(
      program.parseAsync(['observer', '--observer-url', 'data:text/html,x'], { from: 'user' })
    ).rejects.toBeInstanceOf(ExitSignal);

    expect(errors.join('\n')).toContain('must be http or https');
    // The important half: no token was created before the failure.
    expect(createObserverToken).not.toHaveBeenCalled();
  });

  it('collapses duplicate channels before applying the cap', async () => {
    const { program, createObserverToken } = setup();
    const many = Array.from({ length: 60 }, () => 'general').join(',');

    await program.parseAsync(['observer', '--channels', many], { from: 'user' });

    const [call] = createObserverToken.mock.calls as unknown as [[Record<string, unknown>]];
    expect(call[0].filters).toEqual({ includeDms: false, channelNames: ['general'] });
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

  it('rejects non-http(s) schemes, which would carry the token somewhere unintended', () => {
    for (const bad of ['data:text/html,x', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://h/p']) {
      expect(() => resolveObserverBaseUrl(bad, {} as NodeJS.ProcessEnv)).toThrow(
        /must be http or https/
      );
    }
    expect(resolveObserverBaseUrl('http://localhost:3000/observer', {} as NodeJS.ProcessEnv)).toBe(
      'http://localhost:3000/observer'
    );
  });
});
