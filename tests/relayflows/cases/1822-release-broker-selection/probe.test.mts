import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerLocalAgentCommands } from '../packages/cli/src/cli/commands/local-agent.js';

describe('node agent release broker selection', () => {
  it.each([
    ['--state-dir', '/tmp/isolated-relay-state', undefined, undefined],
    ['--broker-url', 'http://127.0.0.1:3890', 'selected-broker-key', 'http://127.0.0.1:3890'],
  ])('routes %s to the selected local broker', async (flag, value, key, url) => {
    const release = vi.fn(async () => undefined);
    const connect = vi.fn();
    const connectLocal = vi.fn(async () => ({ release, disconnect: vi.fn() }) as never);
    const program = new Command();
    program.exitOverride();
    registerLocalAgentCommands(program.command('node'), {
      cwd: () => '/tmp/unrelated-project', connect, connectLocal,
      log: vi.fn(), error: vi.fn(), exit: (code: number) => { throw new Error(`exit:${code}`); },
    });
    const flags = key ? [flag, value, '--api-key', key] : [flag, value];
    await program.parseAsync(['node', 'agent', 'release', 'worker', ...flags], { from: 'user' });
    expect(connect).not.toHaveBeenCalled();
    expect(connectLocal).toHaveBeenCalledWith('/tmp/unrelated-project', {
      brokerUrl: url, apiKey: key, stateDir: flag === '--state-dir' ? value : undefined,
    });
    expect(release).toHaveBeenCalledWith('worker');
  });
});
