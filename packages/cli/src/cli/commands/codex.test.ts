import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { CodexTurnRecoveredError } from '../lib/codex-live-controller.js';
import { registerCodexCommands, runManagedCodexTurn } from './codex.js';

describe('runManagedCodexTurn', () => {
  it('reports a recovered acquire failure and accepts the next input on the same controller', async () => {
    const runTurn = vi
      .fn()
      .mockRejectedValueOnce(new CodexTurnRecoveredError('acquire failed but recovered'))
      .mockResolvedValueOnce({});
    const controller = {
      runTurn,
      status: vi.fn(() => ({
        phase: 'local' as const,
        threadId: 'thread-1',
        generation: 2,
      })),
    };
    const writeError = vi.fn();

    await runManagedCodexTurn(controller as never, 'first input', { json: false, writeError });
    await runManagedCodexTurn(controller as never, 'second input', { json: false, writeError });

    expect(runTurn).toHaveBeenNthCalledWith(1, 'first input');
    expect(runTurn).toHaveBeenNthCalledWith(2, 'second input');
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining('recovered locally'));
  });

  it('fails closed instead of continuing when fencing is unconfirmed', async () => {
    const controller = {
      runTurn: vi.fn(async () => Promise.reject(new Error('revoke unconfirmed'))),
      status: vi.fn(() => ({ phase: 'fenced', threadId: 'thread-1', generation: 1 })),
    };

    await expect(
      runManagedCodexTurn(controller as never, 'must not continue', {
        json: false,
        writeError: vi.fn(),
      })
    ).rejects.toThrow('cannot continue');
  });
});

describe('registerCodexCommands', () => {
  it('makes teleport one command against the active persisted generation', async () => {
    const sendControl = vi.fn(async () => ({
      ok: true as const,
      status: {
        version: 1 as const,
        sessionId: 'session-1',
        threadId: 'thread-1',
        workspaceRoot: '/repo',
        generation: 4,
        phase: 'teleport_pending' as const,
        controllerPid: 10,
        socketPath: '/state/controller.sock',
        turnActive: false,
        pending: { requestId: 'request-1', expectedGeneration: 4 },
        lastRequestId: 'request-1',
        updatedAt: '2026-08-23T12:00:00.000Z',
        controller: 'local' as const,
        execution: 'local' as const,
        workspaceSource: 'relayfile-checkpoint-seal' as const,
      },
    }));
    const log = vi.fn();
    const program = new Command().exitOverride();
    registerCodexCommands(program, {
      readState: () => ({ generation: 4 }) as never,
      sendControl,
      requestId: () => 'request-1',
      log,
    });

    await program.parseAsync(['node', 'relay', 'codex', 'teleport']);

    expect(sendControl).toHaveBeenCalledWith({
      operation: 'teleport',
      requestId: 'request-1',
      expectedGeneration: 4,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('local controller remains authoritative'));
  });

  it('refuses teleport when the session was not started under Relay control', async () => {
    const sendControl = vi.fn();
    const program = new Command().exitOverride();
    registerCodexCommands(program, { readState: () => null, sendControl });

    await expect(program.parseAsync(['node', 'relay', 'codex', 'teleport'])).rejects.toThrow(
      'No active Relay-managed Codex session'
    );
    expect(sendControl).not.toHaveBeenCalled();
  });
});
