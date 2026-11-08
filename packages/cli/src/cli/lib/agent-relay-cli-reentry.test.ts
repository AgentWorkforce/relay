import { describe, expect, it } from 'vitest';

import {
  buildRelayflowsRunArgs,
  resolveAgentRelayCliChildCommand,
  resolveAgentRelayScriptInterpreter,
} from './agent-relay-cli-reentry.js';

describe('resolveAgentRelayCliChildCommand', () => {
  it('re-enters a compiled Bun executable without its virtual entrypoint', () => {
    expect(
      resolveAgentRelayCliChildCommand({
        execPath: '/opt/agent-relay',
        cliEntrypoint: '/$bunfs/root/packages/cli/dist/cli/index.js',
        args: ['flows', 'run', '/work/flow.yaml'],
        cwd: '/work',
      })
    ).toEqual({
      command: '/opt/agent-relay',
      args: ['flows', 'run', '/work/flow.yaml'],
    });
  });

  it('makes a Node CLI script absolute before changing the child cwd', () => {
    expect(
      resolveAgentRelayCliChildCommand({
        execPath: '/usr/bin/node',
        cliEntrypoint: 'packages/cli/dist/cli/index.js',
        args: ['flows', 'run', '/work/flow.yaml'],
        cwd: '/checkout',
      })
    ).toEqual({
      command: '/usr/bin/node',
      args: ['/checkout/packages/cli/dist/cli/index.js', 'flows', 'run', '/work/flow.yaml'],
    });
  });
});

describe('resolveAgentRelayScriptInterpreter', () => {
  it('uses Node for scripts launched by the compiled Bun executable', () => {
    expect(
      resolveAgentRelayScriptInterpreter({
        execPath: '/opt/agent-relay',
        cliEntrypoint: '/$bunfs/root/packages/cli/dist/cli/index.js',
      })
    ).toBe('node');
  });

  it('preserves the current runtime for an ordinary CLI script', () => {
    expect(
      resolveAgentRelayScriptInterpreter({
        execPath: '/usr/bin/node',
        cliEntrypoint: '/opt/agent-relay/dist/cli/index.js',
      })
    ).toBe('/usr/bin/node');
  });
});

describe('buildRelayflowsRunArgs', () => {
  it('supplies explicit empty input only for TypeScript workflows', () => {
    expect(buildRelayflowsRunArgs('/work/flow.yaml', 'yaml')).toEqual(['flows', 'run', '/work/flow.yaml']);
    expect(buildRelayflowsRunArgs('/work/flow.ts', 'ts')).toEqual([
      'flows',
      'run',
      '/work/flow.ts',
      '--input',
      '{}',
    ]);
  });
});
