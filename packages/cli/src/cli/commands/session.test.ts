import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerSessionCommands } from './session.js';

const SESSION_REF = '11111111-1111-4111-8111-111111111111';

describe('registerSessionCommands', () => {
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
});
