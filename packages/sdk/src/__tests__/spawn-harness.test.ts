import { describe, expect, it, vi } from 'vitest';

import { AgentRelayClient } from '../client.js';
import { registerHarnessAdapter } from '../cli-registry.js';
import { AgentRelay } from '../relay.js';

describe('spawn harness adapters', () => {
  it('serializes per-spawn harness config to the broker', async () => {
    const client = new AgentRelayClient({ baseUrl: 'http://127.0.0.1:3888' });
    const request = vi
      .spyOn((client as any).transport, 'request')
      .mockResolvedValue({ name: 'worker', runtime: 'pty' });

    await client.spawnPty({
      name: 'worker',
      cli: 'qwen',
      model: 'qwen3-coder',
      harness: {
        binary: 'qwen',
        interactiveArgs: ['run', '{modelArgs}', '{args}'],
        modelArgs: ['-m', '{model}'],
        searchPaths: ['~/.local/bin'],
      },
    });

    expect(request).toHaveBeenCalledWith('/api/spawn', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body ?? '{}')).toMatchObject({
      name: 'worker',
      cli: 'qwen',
      model: 'qwen3-coder',
      harness: {
        binary: 'qwen',
        interactiveArgs: ['run', '{modelArgs}', '{args}'],
        modelArgs: ['-m', '{model}'],
        searchPaths: ['~/.local/bin'],
      },
    });
  });

  it('attaches constructor harnesses from the facade spawn API', async () => {
    const spawnPty = vi.fn(async (input: { name: string }) => ({
      name: input.name,
      runtime: 'pty' as const,
    }));
    const relay = new AgentRelay({
      harnesses: {
        qwen: {
          binary: 'qwen',
          interactiveArgs: ['run', '{modelArgs}', '{args}'],
          modelArgs: ['-m', '{model}'],
          bypassFlag: '--yes',
        },
      },
    });
    (relay as any).client = { spawnPty };

    await relay.spawn('worker', 'qwen', 'ship it', {
      channels: ['general'],
      model: 'qwen3-coder',
      args: ['--verbose'],
    });

    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'worker',
        cli: 'qwen',
        model: 'qwen3-coder',
        args: ['--verbose'],
        harness: {
          binary: 'qwen',
          interactiveArgs: ['run', '{modelArgs}', '{args}'],
          modelArgs: ['-m', '{model}'],
          bypassFlag: '--yes',
        },
      })
    );
  });

  it('attaches serializable details from registered programmatic adapters', async () => {
    registerHarnessAdapter('registered-spawn-harness', {
      binaries: ['registered-agent'],
      nonInteractiveArgs: (task, extra = []) => ['run', task, ...extra],
      bypassFlag: '--yes',
      searchPaths: ['~/.local/bin'],
    });
    const spawnPty = vi.fn(async (input: { name: string }) => ({
      name: input.name,
      runtime: 'pty' as const,
    }));
    const relay = new AgentRelay();
    (relay as any).client = { spawnPty };

    await relay.spawn('worker', 'registered-spawn-harness', 'ship it', { channels: ['general'] });

    expect(spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({
        cli: 'registered-spawn-harness',
        harness: {
          binaries: ['registered-agent'],
          bypassFlag: '--yes',
          searchPaths: ['~/.local/bin'],
        },
      })
    );
  });
});
