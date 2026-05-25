import { describe, expect, it, vi } from 'vitest';

import { AgentRelayClient } from '../client.js';
import { harnessLookupKeys, resolveStaticHarnessPlan } from '../harness.js';

describe('harness plans', () => {
  it('resolves static PTY harnesses to broker-executable plans', () => {
    const plan = resolveStaticHarnessPlan({
      name: 'QwenReviewer',
      cli: 'qwen',
      definition: {
        runtime: 'pty',
        command: 'qwen',
        args: ['run', '{modelArgs}', '{args}'],
        modelArgs: ['-m', '{model}'],
        env: { QWEN_MODE: 'code' },
      },
      args: ['--verbose'],
      model: 'qwen3-coder',
      cwd: '/workspace',
    });

    expect(plan).toEqual({
      runtime: 'pty',
      command: 'qwen',
      args: ['run', '-m', 'qwen3-coder', '--verbose'],
      cwd: '/workspace',
      env: { QWEN_MODE: 'code' },
    });
  });

  it('resolves static headless app-server harnesses without process args', () => {
    const plan = resolveStaticHarnessPlan({
      name: 'OpenCodeServerWorker',
      cli: 'opencode-server',
      definition: {
        runtime: 'headless',
        driver: 'app_server',
        protocol: 'opencode',
        endpoint: 'http://127.0.0.1:4096',
        sessionId: 'ses_123',
        release: 'abort',
      },
    });

    expect(plan).toEqual({
      runtime: 'headless',
      driver: 'app_server',
      protocol: 'opencode',
      endpoint: 'http://127.0.0.1:4096',
      sessionId: 'ses_123',
      release: 'abort',
    });
  });

  it('looks up harnesses by full cli, executable token, and model suffix base', () => {
    expect(harnessLookupKeys('qwen:coder --fast')).toEqual(['qwen:coder --fast', 'qwen:coder', 'qwen']);
  });

  it('serializes resolved harness plans on spawn requests', async () => {
    const captures: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captures.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(
        JSON.stringify({ name: 'QwenReviewer', runtime: 'pty', sessionId: 'ses_1', pid: 123 }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const client = new AgentRelayClient({ baseUrl: 'http://broker.test', apiKey: 'k', fetch: fetchFn });
    const result = await client.spawnPty({
      name: 'QwenReviewer',
      cli: 'qwen',
      harnessPlan: {
        runtime: 'pty',
        command: 'qwen',
        args: ['run'],
        sessionId: 'ses_1',
      },
    });

    expect(result).toEqual({ name: 'QwenReviewer', runtime: 'pty', sessionId: 'ses_1', pid: 123 });
    expect(captures[0]).toMatchObject({
      name: 'QwenReviewer',
      cli: 'qwen',
      harnessPlan: {
        runtime: 'pty',
        command: 'qwen',
        args: ['run'],
        sessionId: 'ses_1',
      },
    });
  });
});
