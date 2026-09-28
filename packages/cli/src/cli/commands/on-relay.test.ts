import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerOnRelayCommand } from './on-relay.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function registeredClient(name = 'reviewer') {
  return {
    id: 'agent_1',
    name,
    token: 'at_live_secret',
    inbox: {
      list: vi.fn(async () => ({ items: [] })),
      ack: vi.fn(async () => ({})),
      fail: vi.fn(async () => ({})),
      defer: vi.fn(async () => ({})),
    },
  };
}

describe('on-relay command', () => {
  it('registers the named session and starts the foreground listener', async () => {
    const client = registeredClient();
    const register = vi.fn(async () => client);
    const createWorkspaceRelay = vi.fn(() => ({ workspace: { register } }));
    const listen = vi.fn(async () => {});
    const log = vi.fn();
    const program = new Command();
    program.exitOverride();
    registerOnRelayCommand(program, {
      env: {},
      version: '12.5.0',
      detectHarness: () => 'unknown',
      createWorkspaceRelay: createWorkspaceRelay as never,
      createAgentRelay: vi.fn() as never,
      createWorkspace: vi.fn() as never,
      listen,
      log,
      error: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as never,
    });

    await program.parseAsync(
      [
        'on-relay',
        '--name',
        '@Reviewer',
        '--harness',
        'codex',
        '--session-id',
        SESSION_ID,
        '--workspace-key',
        'test-workspace-key',
        '--base-url',
        'http://localhost:4100',
      ],
      { from: 'user' }
    );

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'reviewer',
        type: 'agent',
        metadata: expect.objectContaining({ harness: 'codex', session_id: SESSION_ID, runtime: 'headless' }),
      }),
      { strict: true }
    );
    expect(listen).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ id: 'agent_1', name: 'reviewer', token: 'at_live_secret' }),
        target: { harness: 'codex', sessionId: SESSION_ID },
        baseUrl: 'http://localhost:4100',
        version: '12.5.0',
      })
    );
    expect(log).toHaveBeenCalledWith(`On relay as @reviewer (codex session ${SESSION_ID}).`);
    expect(log).toHaveBeenCalledWith('Off relay as @reviewer.');
  });

  it('reuses an agent token only when it belongs to the requested name', async () => {
    const tokenClient = {
      agents: { me: vi.fn(async () => ({ id: 'agent_2', name: 'reviewer' })) },
      inbox: registeredClient().inbox,
    };
    const createAgentRelay = vi.fn(() => tokenClient);
    const listen = vi.fn(async () => {});
    const program = new Command();
    program.exitOverride();
    registerOnRelayCommand(program, {
      env: {},
      version: '12.5.0',
      detectHarness: () => 'codex',
      createWorkspaceRelay: vi.fn() as never,
      createAgentRelay: createAgentRelay as never,
      createWorkspace: vi.fn() as never,
      listen,
      log: vi.fn(),
      error: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as never,
    });

    await program.parseAsync(
      [
        'on-relay',
        '--name',
        'reviewer',
        '--session-id',
        SESSION_ID,
        '--token',
        'at_live_existing',
        '--base-url',
        'https://cast.agentrelay.com',
      ],
      { from: 'user' }
    );

    expect(tokenClient.agents.me).toHaveBeenCalledOnce();
    expect(createAgentRelay).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'at_live_existing', baseUrl: 'https://cast.agentrelay.com' })
    );
    expect(listen).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ id: 'agent_2', name: 'reviewer' }) })
    );
  });
});
