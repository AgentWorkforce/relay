import { describe, expect, it, vi } from 'vitest';

import {
  executeHostedControlCommand,
  parseHostedControlCommand,
  type HostedControlCommand,
} from './hosted-sdk.js';

describe('parseHostedControlCommand', () => {
  it('parses direct JSON payload', () => {
    const parsed = parseHostedControlCommand(
      '{"type":"spawn","name":"Worker","cli":"codex","task":"Build API"}'
    );
    expect(parsed).toEqual({
      type: 'spawn',
      name: 'Worker',
      cli: 'codex',
      task: 'Build API',
      model: undefined,
      cwd: undefined,
      channels: undefined,
      transport: undefined,
      spawner: undefined,
    });
  });

  it('parses /connect-prefixed payload', () => {
    const parsed = parseHostedControlCommand('/connect {"type":"status"}');
    expect(parsed).toEqual({ type: 'status' });
  });

  it('parses escaped/double-encoded payloads', () => {
    const parsed = parseHostedControlCommand('"{\\"type\\":\\"status\\"}"');
    expect(parsed).toEqual({ type: 'status' });
  });
});

describe('executeHostedControlCommand', () => {
  it('spawns with injection fallback and emits agent_connected', async () => {
    const waitForReady = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const runtime = {
      spawn: vi.fn(async () => ({
        name: 'Worker',
        waitForReady,
        release,
      })),
      sendMessage: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => []),
      shutdown: vi.fn(async () => undefined),
    };

    const send = vi.fn(async () => undefined);
    const client = {
      send,
    } as any;

    const warn = vi.fn(() => undefined);
    const log = vi.fn(() => undefined);
    const runtimeAgents = new Map();
    const command: HostedControlCommand = {
      type: 'spawn',
      name: 'Worker',
      cli: 'codex',
      task: 'Build API',
      transport: 'websocket',
    };

    await executeHostedControlCommand({
      command,
      runtime: runtime as any,
      runtimeAgents,
      controlClient: client,
      controlChannel: 'general',
      connectorName: 'relay-connect',
      timeoutMs: 30_000,
      allowedClis: new Set(['codex']),
      warn,
      log,
    });

    expect(runtime.spawn).toHaveBeenCalledWith('Worker', 'codex', 'Build API', {
      model: undefined,
      cwd: undefined,
      channels: ['general'],
    });
    expect(waitForReady).toHaveBeenCalledWith(30_000);
    expect(warn).toHaveBeenCalledWith(
      '[connect] hosted sdk path: transport "websocket" requested for Worker, falling back to injection'
    );
    expect(runtimeAgents.has('Worker')).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe('general');
    expect(send.mock.calls[0][1]).toContain('"type":"agent_connected"');
    expect(send.mock.calls[0][1]).toContain('"transport":"injection"');
  });

  it('rejects disallowed spawn cli and emits spawn_rejected', async () => {
    const runtime = {
      spawn: vi.fn(async () => {
        throw new Error('should not spawn');
      }),
      sendMessage: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => []),
      shutdown: vi.fn(async () => undefined),
    };

    const send = vi.fn(async () => undefined);
    const client = {
      send,
    } as any;

    await executeHostedControlCommand({
      command: {
        type: 'spawn',
        name: 'Worker',
        cli: 'gemini',
      },
      runtime: runtime as any,
      runtimeAgents: new Map(),
      controlClient: client,
      controlChannel: 'general',
      connectorName: 'relay-connect',
      timeoutMs: 30_000,
      allowedClis: new Set(['codex']),
      warn: vi.fn(() => undefined),
      log: vi.fn(() => undefined),
    });

    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toContain('"type":"spawn_rejected"');
    expect(send.mock.calls[0][1]).toContain('"reason":"cli_not_allowed"');
  });
});
