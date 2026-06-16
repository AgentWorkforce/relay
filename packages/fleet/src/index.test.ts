import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  action,
  defineDefaultLocalNode,
  defineNode,
  invokeNodeHandler,
  nodeManifest,
  onMessage,
  spawn,
  triggerSyncInputs,
} from './index.js';

describe('@agent-relay/fleet', () => {
  it('validates node definitions and creates a manifest', () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const node = defineNode({
      name: 'builder-1',
      maxAgents: 3,
      capabilities: {
        'run:build': action({ input: z.object({ target: z.string() }) }, handler),
      },
    });

    expect(nodeManifest(node)).toEqual({
      name: 'builder-1',
      max_agents: 3,
      capabilities: [{ name: 'run:build', kind: 'action' }],
    });
  });

  it('accepts a plain async handler as an escape hatch', async () => {
    const node = defineNode({
      name: 'custom',
      capabilities: {
        ping: async (input) => ({ input }),
      },
    });

    await expect(
      invokeNodeHandler(
        node,
        'ping',
        { hello: 'world' },
        stubContext(node.name, Object.keys(node.capabilities))
      )
    ).resolves.toEqual({ input: { hello: 'world' } });
  });

  it('builds spawn_agent payloads from a PTY harness', async () => {
    const node = defineNode({
      name: 'builder',
      capabilities: {
        'spawn:codex': spawn({ runtime: 'pty', command: 'codex' }, { channels: ['general'] }),
      },
    });
    const ctx = stubContext(node.name, Object.keys(node.capabilities));

    await invokeNodeHandler(
      node,
      'spawn:codex',
      { name: 'worker-a', model: 'gpt-5', session_ref: 'thread-1', task: 'ship it' },
      ctx
    );

    expect(ctx.spawnAgent).toHaveBeenCalledWith({
      agent: expect.objectContaining({
        name: 'worker-a',
        runtime: 'pty',
        cli: 'codex',
        model: 'gpt-5',
        session_id: 'thread-1',
        channels: ['general'],
      }),
      initialTask: 'ship it',
      skipRelayPrompt: false,
      invocationId: undefined,
    });
  });

  it('threads invocation ids through concurrent spawn handlers', async () => {
    const node = defineNode({
      name: 'builder',
      capabilities: {
        'spawn:codex': spawn({ runtime: 'pty', command: 'codex' }),
      },
    });
    const ctxA = stubContext(node.name, Object.keys(node.capabilities), 'inv-a');
    const ctxB = stubContext(node.name, Object.keys(node.capabilities), 'inv-b');

    await Promise.all([
      invokeNodeHandler(node, 'spawn:codex', { name: 'worker-a' }, ctxA),
      invokeNodeHandler(node, 'spawn:codex', { name: 'worker-b' }, ctxB),
    ]);

    expect(ctxA.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'inv-a',
        agent: expect.objectContaining({ name: 'worker-a' }),
      })
    );
    expect(ctxB.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'inv-b',
        agent: expect.objectContaining({ name: 'worker-b' }),
      })
    );
  });

  it('serializes message trigger descriptors', () => {
    const node = defineNode({
      name: 'triggered',
      capabilities: {
        deploy: action({ input: z.object({}) }, async () => ({ ok: true })),
      },
      triggers: [onMessage({ channel: '#deploys', match: /[Ss]hip/, mention: true }, 'deploy')],
    });

    expect(triggerSyncInputs(node)).toEqual([
      {
        channel: '#deploys',
        pattern: '[Ss]hip',
        mention: true,
        actionName: 'deploy',
        enabled: true,
      },
    ]);
  });

  it('includes configured teams CLIs in the implicit local node', () => {
    const node = defineDefaultLocalNode({
      name: 'local',
      teams: { agents: [{ cli: 'aider' }] },
    });

    expect(Object.keys(node.capabilities)).toEqual([
      'spawn:claude',
      'spawn:codex',
      'spawn:gemini',
      'spawn:aider',
    ]);
  });

  it('rejects invalid definitions early', () => {
    expect(() => defineNode({ name: '', capabilities: {} })).toThrow(/node name/);
    expect(() => defineNode({ name: 'x', capabilities: {} })).toThrow(/at least one capability/);
    expect(() =>
      defineNode({
        name: 'x',
        capabilities: {
          foo: async () => undefined,
          ' foo ': async () => undefined,
        },
      })
    ).toThrow(/duplicate "foo" after trimming/);
    expect(() =>
      defineNode({
        name: 'x',
        capabilities: { run: async () => undefined },
        triggers: [onMessage({}, 'missing')],
      })
    ).toThrow(/unknown action/);
    expect(() =>
      defineNode({
        name: 'x',
        capabilities: { run: async () => undefined },
        triggers: [onMessage({ match: /ship/i }, 'run')],
      })
    ).toThrow(/trigger regex flags are not supported yet/);
  });
});

function stubContext(name: string, capabilities: string[], invocationId?: string) {
  return {
    node: { name, capabilities },
    relay: { sendMessage: vi.fn() },
    invocationId,
    spawnAgent: vi.fn(),
  };
}
