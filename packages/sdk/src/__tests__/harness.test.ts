import { homedir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { AgentRelayClient } from '../client.js';
import { harnessLookupKeys, resolveStaticHarnessConfig } from '../harness.js';

describe('harness configs', () => {
  it('resolves static PTY harnesses to broker-executable configs', () => {
    const config = resolveStaticHarnessConfig({
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

    expect(config).toEqual({
      runtime: 'pty',
      command: 'qwen',
      args: ['run', '-m', 'qwen3-coder', '--verbose'],
      cwd: '/workspace',
      env: { QWEN_MODE: 'code' },
    });
  });

  it('resolves static headless app-server harnesses without process args', () => {
    const config = resolveStaticHarnessConfig({
      name: 'OpenCodeServerWorker',
      cli: 'opencode-server',
      definition: {
        runtime: 'headless',
        protocol: 'opencode',
        endpoint: 'http://127.0.0.1:4096',
        sessionId: 'ses_123',
        release: 'abort',
      },
    });

    expect(config).toEqual({
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

  it('expands home directories in direct command paths', () => {
    const config = resolveStaticHarnessConfig({
      name: 'ClaudeReviewer',
      cli: 'claude',
      definition: {
        runtime: 'pty',
        command: '~/bin/claude',
      },
    });

    expect(config.command).toBe(path.join(homedir(), 'bin/claude'));
  });

  it('expands Windows-style home-relative command paths', () => {
    const config = resolveStaticHarnessConfig({
      name: 'ClaudeReviewer',
      cli: 'claude',
      definition: {
        runtime: 'pty',
        command: '~\\bin\\claude',
      },
    });

    expect(config.command).toBe(path.join(homedir(), 'bin\\claude'));
  });

  it('serializes resolved harness configs on spawn requests', async () => {
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
      harnessConfig: {
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
      harnessConfig: {
        runtime: 'pty',
        command: 'qwen',
        args: ['run'],
        sessionId: 'ses_1',
      },
    });
  });
});
