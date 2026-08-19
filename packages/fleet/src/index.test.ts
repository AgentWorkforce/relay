import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  action,
  defineDefaultLocalNode,
  defineNode,
  invokeNodeHandler,
  nodeInfo,
  nodeRegistrationTags,
  onMessage,
  spawn,
  triggerSyncInputs,
} from './index.js';

describe('@agent-relay/fleet', () => {
  it('validates node definitions and normalizes capabilities', () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const node = defineNode({
      name: 'builder-1',
      maxAgents: 3,
      capabilities: {
        'run:build': action({ input: z.object({ target: z.string() }) }, handler),
      },
    });

    expect(node.name).toBe('builder-1');
    expect(node.maxAgents).toBe(3);
    expect(node.capabilities['run:build']).toMatchObject({ name: 'run:build', kind: 'action' });
  });

  it('normalizes node-local repo paths without exposing values through node info', () => {
    const node = defineNode({
      name: 'builder-1',
      repoPaths: {
        ' AgentWorkforce/relay ': '/srv/checkouts/relay',
        'AgentWorkforce/factory': 'C:\\work\\factory',
      },
      capabilities: { ping: async () => 'pong' },
    });

    expect(node.repoPaths).toEqual({
      'AgentWorkforce/relay': '/srv/checkouts/relay',
      'AgentWorkforce/factory': 'C:\\work\\factory',
    });
    expect(JSON.stringify(nodeInfo(node))).not.toContain('/srv/checkouts/relay');
  });

  it('preserves compatible repo tags when no local repo map is configured', () => {
    const node = defineNode({
      name: 'legacy-builder',
      tags: ['arm64', 'repo:AgentWorkforce/relay'],
      capabilities: { ping: async () => 'pong' },
    });

    expect(nodeRegistrationTags(node)).toEqual(['arm64', 'repo:AgentWorkforce/relay']);
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

  it('normalizes node-local repo paths and exposes only deterministic placement keys', () => {
    const factoryPath = resolve('node-private', 'factory');
    const relayPath = resolve('node-private', 'relay');
    const configured = {
      ' AgentWorkforce/relay ': relayPath,
      'AgentWorkforce/factory': factoryPath,
    };
    const node = defineNode({
      name: 'repo-builder',
      capabilities: { ping: async () => 'pong' },
      tags: ['arm64', 'repo:legacy/manual-tag'],
      repoPaths: configured,
    });

    configured[' AgentWorkforce/relay '] = resolve('different-private-path');

    expect(node.repoPaths).toEqual({
      'AgentWorkforce/relay': relayPath,
      'AgentWorkforce/factory': factoryPath,
    });
    expect(Object.isFrozen(node.repoPaths)).toBe(true);
    expect(nodeInfo(node)).toEqual({
      name: 'repo-builder',
      capabilities: ['ping'],
      repoKeys: ['AgentWorkforce/factory', 'AgentWorkforce/relay'],
    });
    expect(nodeRegistrationTags(node)).toEqual([
      'arm64',
      'repo:AgentWorkforce/factory',
      'repo:AgentWorkforce/relay',
    ]);
    expect(JSON.stringify(nodeInfo(node))).not.toContain(factoryPath);
    expect(JSON.stringify(nodeInfo(node))).not.toContain(relayPath);
  });

  it('preserves legacy repo tags when repoPaths is not configured', () => {
    const node = defineNode({
      name: 'legacy-builder',
      capabilities: { ping: async () => 'pong' },
      tags: ['arm64', 'repo:legacy'],
    });

    expect(nodeRegistrationTags(node)).toEqual(['arm64', 'repo:legacy']);
  });

  it('rejects non-placement keys and relative checkout paths', () => {
    const absolute = resolve('node-private', 'factory');
    for (const invalidKey of ['/private/node/factory', './repo', '../repo']) {
      expect(() =>
        defineNode({
          name: 'bad-key',
          capabilities: { ping: async () => 'pong' },
          repoPaths: { [invalidKey]: absolute },
        })
      ).toThrow(/owner\/repo format/);
    }
    for (const relativePath of ['relative/factory', './repo', '../repo']) {
      expect(() =>
        defineNode({
          name: 'bad-path',
          capabilities: { ping: async () => 'pong' },
          repoPaths: { 'AgentWorkforce/factory': relativePath },
        })
      ).toThrow(/must be an absolute path/);
    }
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
      {
        name: 'worker-a',
        model: 'gpt-5',
        session_ref: 'thread-1',
        task: 'ship it',
        worker_cwd: '/srv/relay',
        organization: 'AgentWorkforce',
        project: 'relay',
        workstream: 'fleet-metadata',
        role: 'implementer',
      },
      ctx
    );

    expect(ctx.spawnAgent).toHaveBeenCalledWith({
      agent: expect.objectContaining({
        name: 'worker-a',
        runtime: 'pty',
        cli: 'codex',
        model: 'gpt-5',
        session_id: 'thread-1',
        cwd: '/srv/relay',
        channels: ['general'],
      }),
      initialTask: 'ship it',
      registrationMetadata: {
        organization: 'AgentWorkforce',
        project: 'relay',
        workstream: 'fleet-metadata',
        role: 'implementer',
        objective: 'ship it',
      },
      skipRelayPrompt: false,
      invocationId: undefined,
    });
  });

  // Blank declared values are dropped rather than forwarded as empty strings —
  // the broker merges these over metadata the engine already holds, so an empty
  // value would overwrite an engine-owned field. Matches the CLI's
  // `declaredWorkforceMetadata` and the broker's `declared_metadata_map`.
  it('trims declared metadata and omits blank values', async () => {
    const node = defineNode({
      name: 'builder',
      capabilities: {
        'spawn:codex': spawn({ runtime: 'pty', command: 'codex' }),
      },
    });
    const ctx = stubContext(node.name, Object.keys(node.capabilities));

    await invokeNodeHandler(
      node,
      'spawn:codex',
      {
        name: 'worker-a',
        task: 'ship it',
        // `''` cannot reach here — the spawn input schema already rejects it
        // with `min(1)`. Whitespace-only is the value that gets through, so
        // that is what this asserts on.
        organization: '  AgentWorkforce  ',
        workstream: '   ',
        role: ' ',
      },
      ctx
    );

    expect(ctx.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationMetadata: { organization: 'AgentWorkforce', objective: 'ship it' },
      })
    );
  });

  it('omits registration metadata entirely when nothing is declared', async () => {
    const node = defineNode({
      name: 'builder',
      capabilities: {
        'spawn:codex': spawn({ runtime: 'pty', command: 'codex' }),
      },
    });
    const ctx = stubContext(node.name, Object.keys(node.capabilities));

    await invokeNodeHandler(node, 'spawn:codex', { name: 'worker-a', role: '   ' }, ctx);

    const [request] = (ctx.spawnAgent as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(request).not.toHaveProperty('registrationMetadata');
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
    expect(() =>
      defineNode({
        name: 'x',
        capabilities: { run: async () => undefined },
        repoPaths: { '/Users/alice/relay': '/srv/relay' },
      })
    ).toThrow(/owner\/name/);
    expect(() =>
      defineNode({
        name: 'x',
        capabilities: { run: async () => undefined },
        repoPaths: { 'AgentWorkforce/relay': 'relative/relay' },
      })
    ).toThrow(/absolute path/);
    expect(() =>
      defineNode({
        name: 'x',
        capabilities: { run: async () => undefined },
        tags: ['repo:/Users/alice/relay'],
      })
    ).toThrow(/owner\/name/);
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
