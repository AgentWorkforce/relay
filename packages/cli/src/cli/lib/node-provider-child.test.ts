import { describe, expect, it, vi } from 'vitest';

import {
  descriptorCapacitySource,
  describeNodeDefinitionViaNode,
  isJsNodeDefinition,
  parseNodeDescriptor,
  startNodeJsNodeProvider,
} from './node-provider-child.js';
import { nodeCapacityHarnesses } from './fleet-sidecar.js';
import type { CoreDependencies } from '../commands/core.js';

const MARKER = '__AGENT_RELAY_NODE_DESCRIPTOR__';

function deps(overrides: Partial<CoreDependencies> = {}): CoreDependencies {
  return {
    env: {},
    log: vi.fn(),
    warn: vi.fn(),
    execCommand: vi.fn(),
    spawnProcess: vi.fn(),
    ...overrides,
  } as unknown as CoreDependencies;
}

describe('parseNodeDescriptor', () => {
  it('reads the marker line', () => {
    const stdout = `${MARKER}${JSON.stringify({ name: 'n', capabilities: ['spawn:claude'] })}\n`;

    expect(parseNodeDescriptor(stdout)).toEqual({ name: 'n', capabilities: ['spawn:claude'] });
  });

  it('ignores output the config printed on import', () => {
    const stdout = [
      'booting my node...',
      `${MARKER}${JSON.stringify({ name: 'real', capabilities: [], maxAgents: 3 })}`,
    ].join('\n');

    expect(parseNodeDescriptor(stdout)).toEqual({ name: 'real', capabilities: [], maxAgents: 3 });
  });

  it('returns undefined when the child produced no descriptor', () => {
    expect(parseNodeDescriptor('some unrelated output\n')).toBeUndefined();
  });
});

describe('descriptorCapacitySource', () => {
  it('feeds a descriptor’s spawn capabilities into the advertised capacity', () => {
    const source = descriptorCapacitySource({
      name: 'factory',
      capabilities: ['spawn:claude', 'spawn:my-harness', 'workflow:run'],
    });

    // A node definition served out-of-process must still contribute its
    // spawn:<harness> capacity, exactly as an in-process definition does.
    expect(nodeCapacityHarnesses(null, source)).toContain('my-harness');
  });
});

describe('isJsNodeDefinition', () => {
  it.each(['agent-relay.ts', 'agent-relay.mts', 'agent-relay.mjs', 'agent-relay.js'])(
    'treats %s as a JS/TS definition',
    (file) => {
      expect(isJsNodeDefinition(file)).toBe(true);
    }
  );

  it('leaves agent-relay.py to the python provider', () => {
    expect(isJsNodeDefinition('agent-relay.py')).toBe(false);
  });
});

describe('describeNodeDefinitionViaNode', () => {
  it('quotes paths so a config in a directory with spaces still loads', async () => {
    const execCommand = vi.fn().mockResolvedValue({
      stdout: `${MARKER}${JSON.stringify({ name: 'n', capabilities: [] })}`,
      stderr: '',
    });

    await describeNodeDefinitionViaNode('/tmp/my project/agent-relay.ts', deps({ execCommand }));

    const command = execCommand.mock.calls[0]?.[0] as string;
    expect(command).toContain(`'/tmp/my project/agent-relay.ts'`);
    expect(command).toContain('--describe');
  });

  it('honors AGENT_RELAY_NODE', async () => {
    const execCommand = vi.fn().mockResolvedValue({
      stdout: `${MARKER}${JSON.stringify({ name: 'n', capabilities: [] })}`,
      stderr: '',
    });

    await describeNodeDefinitionViaNode(
      '/tmp/agent-relay.ts',
      deps({ execCommand, env: { AGENT_RELAY_NODE: '/opt/node20/bin/node' } })
    );

    expect(execCommand.mock.calls[0]?.[0]).toContain(`'/opt/node20/bin/node'`);
  });

  it('surfaces the child’s stderr, which carries the real load error', async () => {
    const execCommand = vi
      .fn()
      .mockRejectedValue({ stderr: '[agent-relay] node provider: failed to load /x: boom', status: 2 });

    await expect(describeNodeDefinitionViaNode('/x', deps({ execCommand }))).rejects.toThrow(/boom/);
  });

  it('rejects a file that does not default-export defineNode(...)', async () => {
    const execCommand = vi.fn().mockResolvedValue({ stdout: 'nothing\n', stderr: '' });

    await expect(describeNodeDefinitionViaNode('/x/agent-relay.ts', deps({ execCommand }))).rejects.toThrow(
      /must default-export defineNode/
    );
  });
});

describe('startNodeJsNodeProvider', () => {
  it('passes node credentials through the env contract the child reads', () => {
    const spawnProcess = vi.fn(() => ({ pid: 42 }));
    const d = deps({ spawnProcess });

    startNodeJsNodeProvider(
      '/proj/agent-relay.ts',
      {
        nodeToken: 'nt_live_x',
        nodeId: 'node-1',
        nodeName: 'my-node',
        baseUrl: 'https://cast.example.com',
        workspaceKey: 'rk_live_y',
      },
      d
    );

    const [command, args, options] = spawnProcess.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; cwd: string },
    ];
    expect(command).toBe('node');
    expect(args[1]).toBe('/proj/agent-relay.ts');
    expect(options.cwd).toBe('/proj');
    expect(options.env).toMatchObject({
      RELAY_NODE_TOKEN: 'nt_live_x',
      RELAY_NODE_ID: 'node-1',
      RELAY_NODE_NAME: 'my-node',
      RELAY_BASE_URL: 'https://cast.example.com',
      RELAY_WORKSPACE_KEY: 'rk_live_y',
    });
  });

  it('omits optional env when not provided, so the SDK applies its own defaults', () => {
    const spawnProcess = vi.fn(() => ({ pid: 1 }));

    startNodeJsNodeProvider(
      '/proj/agent-relay.ts',
      { nodeToken: 't', nodeId: 'n', nodeName: 'x' },
      deps({ spawnProcess })
    );

    const options = spawnProcess.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.RELAY_BASE_URL).toBeUndefined();
    expect(options.env.RELAY_WORKSPACE_KEY).toBeUndefined();
  });

  it('warns with actionable guidance when node is missing rather than throwing', () => {
    const warn = vi.fn();
    const spawnProcess = vi.fn(() => {
      throw new Error('spawn node ENOENT');
    });

    const child = startNodeJsNodeProvider(
      '/proj/agent-relay.ts',
      { nodeToken: 't', nodeId: 'n', nodeName: 'x' },
      deps({ spawnProcess, warn })
    );

    expect(child).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toMatch(/AGENT_RELAY_NODE/);
  });
});
