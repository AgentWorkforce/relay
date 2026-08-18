import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSessionCommands, resolveRelayhistoryConfig, trustedStoredBaseUrl } from './session.js';

const SESSION_REF = '11111111-1111-4111-8111-111111111111';
const RELAYHISTORY_ENV_VARS = [
  'RELAYHISTORY_URL',
  'RELAYHISTORY_TOKEN',
  'RELAYHISTORY_ACCESS_TOKEN',
  'RELAY_AGENT_TOKEN',
];

describe('registerSessionCommands', () => {
  afterEach(() => {
    for (const name of RELAYHISTORY_ENV_VARS) delete process.env[name];
  });

  it('replays a Relay-emitted reference with the authenticated user’s existing Relayhistory credential', async () => {
    const replaySession = vi.fn(async (sessionId: string) => ({
      session: {
        sessionId,
        owner: { userId: 'usr_owner', email: 'owner@example.com', displayName: 'Owner' },
        activeActor: null,
        steeringLog: [],
        originCli: 'codex' as const,
        originNode: 'node-a',
        createdAt: '2026-08-17T09:00:00.000Z',
      },
      turns: [],
      contextPrompt: `Continue the Relay session.\n\nSession ID: ${sessionId}`,
    }));
    const createClient = vi.fn(() => ({ replaySession }));
    const readStoredAuth = vi.fn(() => ({ baseUrl: 'https://history.agentrelay.com', token: 'rth_at_user' }));
    const log = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerSessionCommands(program, { createClient, readStoredAuth, log });

    await program.parseAsync(['node', 'relay', 'session', 'replay', SESSION_REF]);

    expect(createClient).toHaveBeenCalledWith({
      baseUrl: 'https://history.agentrelay.com',
      token: 'rth_at_user',
    });
    expect(replaySession).toHaveBeenCalledWith(SESSION_REF);
    expect(log).toHaveBeenCalledWith(`Continue the Relay session.\n\nSession ID: ${SESSION_REF}`);
  });

  it('rejects a placeholder before it can be sent to Relayhistory', async () => {
    const replaySession = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerSessionCommands(program, { createClient: () => ({ replaySession }) });

    await expect(
      program.parseAsync(['node', 'relay', 'session', 'replay', 'unknown-session-v3b'])
    ).rejects.toThrow('Session id must be a Relay-emitted UUID.');
    expect(replaySession).not.toHaveBeenCalled();
  });

  it('reports a friendly, actionable error and exits when no Relayhistory endpoint is configured', async () => {
    const replaySession = vi.fn();
    const createClient = vi.fn(() => ({ replaySession }));
    const readStoredAuth = vi.fn(() => null);
    const error = vi.fn();
    const exit = vi.fn(() => {
      throw new Error('exit:1');
    }) as unknown as (code: number) => never;
    const program = new Command();
    program.exitOverride();
    registerSessionCommands(program, { createClient, readStoredAuth, error, exit });

    await expect(
      program.parseAsync(['node', 'relay', 'session', 'replay', SESSION_REF])
    ).rejects.toThrow('exit:1');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('RELAYHISTORY_URL'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(replaySession).not.toHaveBeenCalled();
  });

  it('reports a friendly, actionable error and exits when no Relayhistory credential is configured', async () => {
    const replaySession = vi.fn();
    const createClient = vi.fn(() => ({ replaySession }));
    const readStoredAuth = vi.fn(() => ({ baseUrl: 'https://history.agentrelay.com' }));
    const error = vi.fn();
    const exit = vi.fn(() => {
      throw new Error('exit:1');
    }) as unknown as (code: number) => never;
    const program = new Command();
    program.exitOverride();
    registerSessionCommands(program, { createClient, readStoredAuth, error, exit });

    await expect(
      program.parseAsync(['node', 'relay', 'session', 'replay', SESSION_REF])
    ).rejects.toThrow('exit:1');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('RELAYHISTORY_TOKEN'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('resolveRelayhistoryConfig', () => {
  afterEach(() => {
    for (const name of RELAYHISTORY_ENV_VARS) delete process.env[name];
  });

  it('lets an explicit localhost environment override stored production credentials', () => {
    process.env.RELAYHISTORY_URL = 'http://localhost:4100';
    process.env.RELAYHISTORY_TOKEN = 'rth_at_local';

    const config = resolveRelayhistoryConfig({
      baseUrl: 'https://history.agentrelay.com',
      token: 'rth_at_production',
    });

    expect(config).toEqual({ baseUrl: 'http://localhost:4100', token: 'rth_at_local' });
  });

  it('falls back to stored auth.json values when no environment configuration is present', () => {
    const config = resolveRelayhistoryConfig({
      baseUrl: 'https://history.agentrelay.com',
      token: 'rth_at_production',
    });

    expect(config).toEqual({ baseUrl: 'https://history.agentrelay.com', token: 'rth_at_production' });
  });
});

describe('trustedStoredBaseUrl', () => {
  it('accepts the production Relayhistory host over https', () => {
    expect(trustedStoredBaseUrl('https://history.agentrelay.com/v1')).toBe(
      'https://history.agentrelay.com/v1'
    );
  });

  it('accepts bracketed IPv6 localhost over http', () => {
    expect(trustedStoredBaseUrl('http://[::1]:4100')).toBe('http://[::1]:4100');
  });

  it('rejects an untrusted host', () => {
    expect(trustedStoredBaseUrl('https://evil.example.com')).toBeUndefined();
  });
});
