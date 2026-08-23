import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { CodexTurnRecordedError } from '../lib/codex-live-controller.js';
import {
  nodeCallbackWriter,
  registerCodexCommands,
  runManagedCodexTurn,
  surfaceRecoveredCodexTerminal,
} from './codex.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reconciledResult() {
  const turn = {
    id: 'turn-reconciled',
    status: 'completed',
    itemsView: 'full',
    items: [{ id: 'answer-1', type: 'agentMessage', text: 'the recovered answer' }],
  };
  return {
    turnId: turn.id,
    response: { turn },
    completed: { method: 'turn/completed', params: { threadId: 'thread-1', turn } },
    reconciled: true as const,
  };
}

describe('nodeCallbackWriter', () => {
  it('waits for the Node write callback even when write reports backpressure', async () => {
    let callback!: (error?: Error | null) => void;
    const stream = {
      write: vi.fn((_message: string, done: (error?: Error | null) => void) => {
        callback = done;
        return false;
      }),
    };
    const completed = vi.fn();
    const pending = nodeCallbackWriter(stream)('durable output').then(completed);

    await Promise.resolve();
    expect(stream.write).toHaveBeenCalledWith('durable output', expect.any(Function));
    expect(completed).not.toHaveBeenCalled();

    callback();
    await pending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it('rejects callback errors and synchronous stream throws', async () => {
    const callbackError = new Error('callback failed');
    const callbackStream = {
      write: vi.fn((_message: string, done: (error?: Error | null) => void) => {
        done(callbackError);
        return true;
      }),
    };
    await expect(nodeCallbackWriter(callbackStream)('output')).rejects.toBe(callbackError);

    const thrown = new Error('write threw');
    const throwingStream = {
      write: vi.fn(() => {
        throw thrown;
      }),
    };
    await expect(nodeCallbackWriter(throwingStream as never)('output')).rejects.toBe(thrown);
  });
});

describe('runManagedCodexTurn', () => {
  it('keeps a completed recovery unacknowledged until the async output writer resolves', async () => {
    const write = deferred<void>();
    const controller = {
      runTurn: vi.fn(async () => reconciledResult()),
      acknowledgeRecoveredOutcome: vi.fn(),
    };
    const running = runManagedCodexTurn(controller as never, 'recover me', {
      json: false,
      writeError: vi.fn(async () => undefined),
      writeOutput: vi.fn(() => write.promise),
    });

    await vi.waitFor(() => expect(controller.runTurn).toHaveBeenCalledOnce());
    expect(controller.acknowledgeRecoveredOutcome).not.toHaveBeenCalled();
    write.resolve();
    await running;
    expect(controller.acknowledgeRecoveredOutcome).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'interrupted'] as const)(
    'keeps a %s recovery unacknowledged until the async error writer resolves',
    async (status) => {
      const write = deferred<void>();
      const terminal = new CodexTurnRecordedError(status, `recorded ${status}`, true);
      const controller = {
        runTurn: vi.fn().mockRejectedValue(terminal),
        acknowledgeRecoveredOutcome: vi.fn(),
      };
      const running = runManagedCodexTurn(controller as never, 'recover me', {
        json: false,
        writeError: vi.fn(() => write.promise),
      });

      await vi.waitFor(() => expect(controller.runTurn).toHaveBeenCalledOnce());
      expect(controller.acknowledgeRecoveredOutcome).not.toHaveBeenCalled();
      write.resolve();
      await expect(running).rejects.toBe(terminal);
      expect(controller.acknowledgeRecoveredOutcome).toHaveBeenCalledOnce();
    }
  );

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'keeps a %s recovery durable when the Node write callback fails',
    async (status) => {
      const writeError = new Error(`write callback failed for ${status}`);
      const writer = nodeCallbackWriter({
        write: vi.fn((_message: string, done: (error?: Error | null) => void) => {
          done(writeError);
          return true;
        }),
      });
      const terminal =
        status === 'completed' ? undefined : new CodexTurnRecordedError(status, `recorded ${status}`, true);
      const controller = {
        runTurn: terminal ? vi.fn().mockRejectedValue(terminal) : vi.fn(async () => reconciledResult()),
        acknowledgeRecoveredOutcome: vi.fn(),
      };

      await expect(
        runManagedCodexTurn(controller as never, 'recover me', {
          json: false,
          writeError: writer,
          writeOutput: writer,
        })
      ).rejects.toBe(writeError);
      expect(controller.acknowledgeRecoveredOutcome).not.toHaveBeenCalled();
    }
  );

  it('renders an exact assistant answer recovered after completion-notification loss', async () => {
    const turn = {
      id: 'turn-reconciled',
      status: 'completed',
      itemsView: 'full',
      items: [{ id: 'answer-1', type: 'agentMessage', text: 'the recovered answer' }],
    };
    const controller = {
      runTurn: vi.fn(async () => ({
        turnId: turn.id,
        response: { turn },
        completed: { method: 'turn/completed', params: { threadId: 'thread-1', turn } },
        reconciled: true as const,
      })),
      acknowledgeRecoveredOutcome: vi.fn(),
      status: vi.fn(),
    };
    const writeOutput = vi.fn();

    await runManagedCodexTurn(controller as never, 'recover me', {
      json: false,
      writeError: vi.fn(),
      writeOutput,
    });

    expect(writeOutput).toHaveBeenCalledWith('the recovered answer\n');
    expect(controller.acknowledgeRecoveredOutcome).toHaveBeenCalledOnce();
  });

  it('does not acknowledge a live recovered completion until its exact answer is rendered', async () => {
    const turn = {
      id: 'turn-reconciled',
      status: 'completed',
      itemsView: 'full',
      items: [{ id: 'answer-1', type: 'agentMessage', text: 'the recovered answer' }],
    };
    const renderError = new Error('stdout unavailable');
    const controller = {
      runTurn: vi.fn(async () => ({
        turnId: turn.id,
        response: { turn },
        completed: { method: 'turn/completed', params: { threadId: 'thread-1', turn } },
        reconciled: true as const,
      })),
      acknowledgeRecoveredOutcome: vi.fn(),
    };

    await expect(
      runManagedCodexTurn(controller as never, 'recover me', {
        json: false,
        writeError: vi.fn(),
        writeOutput: () => {
          throw renderError;
        },
      })
    ).rejects.toBe(renderError);
    expect(controller.acknowledgeRecoveredOutcome).not.toHaveBeenCalled();
  });

  it('does not report a successful command for a recorded failed turn', async () => {
    const terminal = new CodexTurnRecordedError('failed', 'Codex turn ended failed.');
    const runTurn = vi.fn().mockRejectedValue(terminal);
    const controller = {
      runTurn,
      acknowledgeRecoveredOutcome: vi.fn(),
      status: vi.fn(() => ({
        phase: 'local' as const,
        threadId: 'thread-1',
        generation: 1,
      })),
    };
    const writeError = vi.fn();

    await expect(
      runManagedCodexTurn(controller as never, 'failed input', { json: false, writeError })
    ).rejects.toBe(terminal);
    expect(writeError).toHaveBeenCalledWith(expect.stringContaining('recorded the turn as failed'));
    expect(controller.acknowledgeRecoveredOutcome).not.toHaveBeenCalled();
  });

  it.each(['failed', 'interrupted'] as const)(
    'acknowledges a live reconciled %s terminal only after rendering it',
    async (status) => {
      const terminal = new CodexTurnRecordedError(status, `recorded ${status}`, true);
      const controller = {
        runTurn: vi.fn().mockRejectedValue(terminal),
        acknowledgeRecoveredOutcome: vi.fn(),
      };
      const writeError = vi.fn();

      await expect(
        runManagedCodexTurn(controller as never, 'do not replay', { json: false, writeError })
      ).rejects.toBe(terminal);
      expect(writeError).toHaveBeenCalledWith(expect.stringContaining(`turn as ${status}`));
      expect(controller.acknowledgeRecoveredOutcome).toHaveBeenCalledOnce();
    }
  );

  it.each(['failed', 'interrupted'] as const)(
    'does not acknowledge a live reconciled %s terminal when rendering throws',
    async (status) => {
      const terminal = new CodexTurnRecordedError(status, `recorded ${status}`, true);
      const renderError = new Error('stderr unavailable');
      const controller = {
        runTurn: vi.fn().mockRejectedValue(terminal),
        acknowledgeRecoveredOutcome: vi.fn(),
      };

      await expect(
        runManagedCodexTurn(controller as never, 'do not replay', {
          json: false,
          writeError: () => {
            throw renderError;
          },
        })
      ).rejects.toBe(renderError);
      expect(controller.acknowledgeRecoveredOutcome).not.toHaveBeenCalled();
    }
  );

  it.each(['failed', 'interrupted'] as const)(
    'surfaces a crash-reconciled %s turn nonzero before any new prompt runs',
    async (status) => {
      const terminal = new CodexTurnRecordedError(status, `recorded ${status}`);
      const controller = {
        takeRecoveredTerminal: vi.fn().mockReturnValueOnce(terminal).mockReturnValue(undefined),
        acknowledgeRecoveredOutcome: vi.fn(),
        runTurn: vi.fn(),
      };
      const writeError = vi.fn();

      await expect(
        surfaceRecoveredCodexTerminal(controller as never, { json: false, writeError })
      ).rejects.toBe(terminal);

      expect(writeError).toHaveBeenCalledWith(expect.stringContaining(`turn as ${status}`));
      expect(controller.acknowledgeRecoveredOutcome).toHaveBeenCalledOnce();
      await expect(
        surfaceRecoveredCodexTerminal(controller as never, { json: false, writeError })
      ).resolves.toBeUndefined();
      expect(writeError).toHaveBeenCalledTimes(1);
      expect(controller.runTurn).not.toHaveBeenCalled();
    }
  );

  it.each(['failed', 'interrupted'] as const)(
    'does not acknowledge durable %s terminal evidence when rendering throws',
    async (status) => {
      const terminal = new CodexTurnRecordedError(status, `recorded ${status}`);
      const controller = {
        takeRecoveredTerminal: vi.fn(() => terminal),
        acknowledgeRecoveredOutcome: vi.fn(),
      };
      const renderError = new Error('stderr unavailable');

      await expect(
        surfaceRecoveredCodexTerminal(controller as never, {
          json: false,
          writeError: () => {
            throw renderError;
          },
        })
      ).rejects.toBe(renderError);
      expect(controller.acknowledgeRecoveredOutcome).not.toHaveBeenCalled();
    }
  );

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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('confirmed pre-submission recovery'));
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
