import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { action, defineNode, onMessage } from '@agent-relay/fleet';

import { loadNodeDefinition, registerFleetCommands, stripEnrollmentFlags } from './fleet.js';
import { startFleetSidecar, serveFleetSidecar } from '../lib/fleet-sidecar.js';

describe('fleet command support', () => {
  it.each([
    ['config', 'get', undefined],
    ['enable', 'set', true],
    ['disable', 'set', false],
    ['inherit', 'inherit', undefined],
  ] as const)('fleet %s delegates to workspace fleet node config API', async (command, method, value) => {
    const fleetNodes = {
      get: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
      set: vi.fn(async (enabled: boolean) => ({ enabled, defaultEnabled: false, override: enabled })),
      inherit: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
    };
    const createWorkspaceRelay = vi.fn(() => ({ workspace: { fleetNodes } }));
    const logs: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerFleetCommands(program, {
      sdk: {
        createAgentRelay: vi.fn() as never,
        createWorkspaceRelay: createWorkspaceRelay as never,
        createWorkspace: vi.fn() as never,
        log: (message: unknown) => logs.push(String(message)),
        error: vi.fn(),
        exit: vi.fn(() => {
          throw new Error('__exit__');
        }) as never,
      },
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

    await program.parseAsync(
      ['fleet', command, '--workspace-key', 'rk_live_test', '--base-url', 'https://relay.example'],
      { from: 'user' }
    );

    expect(createWorkspaceRelay).toHaveBeenCalledWith({
      workspaceKey: 'rk_live_test',
      token: undefined,
      baseUrl: 'https://relay.example',
    });
    if (method === 'set') {
      expect(fleetNodes.set).toHaveBeenCalledWith(value);
    } else {
      expect(fleetNodes[method]).toHaveBeenCalledTimes(1);
    }
    expect(JSON.parse(logs[0]!)).toMatchObject({
      enabled: method === 'set' ? value : false,
      defaultEnabled: false,
    });
  });

  it('loads the example TS node file', async () => {
    const node = await loadNodeDefinition(path.resolve(process.cwd(), 'examples/relay-node.ts'));

    expect(node.name).toBe('local-builder');
    expect(Object.keys(node.capabilities)).toContain('spawn:codex');
  });

  it('loads a plain JS node file through native import', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-def-'));
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      const file = path.join(dir, 'node-def.js');
      await writeFile(
        file,
        [
          'export default {',
          '  __agentRelayFleetNode: true,',
          '  name: "plain-js-node",',
          '  capabilities: {},',
          '  triggers: [],',
          '};',
        ].join('\n')
      );

      const node = await loadNodeDefinition(file);

      expect(node.name).toBe('plain-js-node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads CommonJS compiled JS node files that export default wrappers', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-def-'));
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
      const file = path.join(dir, 'node-def.js');
      await writeFile(
        file,
        [
          'exports.default = {',
          '  __agentRelayFleetNode: true,',
          '  name: "compiled-cjs-node",',
          '  capabilities: {},',
          '  triggers: [],',
          '};',
        ].join('\n')
      );

      const node = await loadNodeDefinition(file);

      expect(node.name).toBe('compiled-cjs-node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to jiti for ESM-syntax JS node files in CommonJS projects', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-node-def-'));
    try {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
      const file = path.join(dir, 'node-def.js');
      await writeFile(
        file,
        [
          'export default {',
          '  __agentRelayFleetNode: true,',
          '  name: "commonjs-project-esm-node",',
          '  capabilities: {},',
          '  triggers: [],',
          '};',
        ].join('\n')
      );

      const node = await loadNodeDefinition(file);

      expect(node.name).toBe('commonjs-project-esm-node');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('registers a served node and dispatches invoke_handler over a stub broker', async () => {
    const node = defineNode({
      name: 'stub-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
    });
    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    let registeredManifest: unknown;
    const handlerResult = new Promise<unknown>((resolve) => {
      broker.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as {
            type: string;
            request_id?: string;
            payload: Record<string, unknown>;
          };
          if (frame.type === 'register_node') {
            registeredManifest = frame.payload.manifest;
          }
          if (frame.request_id) {
            ws.send(
              JSON.stringify({
                v: 2,
                type: 'ok',
                request_id: frame.request_id,
                payload: { result: { ok: true } },
              })
            );
          }
          if (frame.type === 'register_handlers') {
            ws.send(
              JSON.stringify({
                v: 2,
                type: 'invoke_handler',
                payload: {
                  invocation_id: 'inv_1',
                  name: 'echo',
                  input: { text: 'hello' },
                },
              })
            );
          }
          if (frame.type === 'handler_result') {
            resolve(frame.payload);
            ws.close();
          }
        });
      });
    });

    await serveFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
    });

    expect(registeredManifest).toMatchObject({
      name: 'stub-node',
      capabilities: [{ name: 'echo', kind: 'action' }],
    });
    await expect(handlerResult).resolves.toEqual({
      invocation_id: 'inv_1',
      output: { echoed: 'hello' },
    });
    broker.close();
  });

  it('deregisters a node before a clean shutdown closes the websocket', async () => {
    const node = defineNode({
      name: 'shutdown-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
    });
    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    const frameTypes: string[] = [];
    const running = startFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
    });

    broker.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          type: string;
          request_id?: string;
          payload: Record<string, unknown>;
        };
        frameTypes.push(frame.type);
        if (frame.request_id) {
          ws.send(
            JSON.stringify({
              v: 2,
              type: 'ok',
              request_id: frame.request_id,
              payload: { result: { ok: true } },
            })
          );
        }
        if (frame.type === 'register_handlers') {
          void running.stop();
        }
      });
    });

    await running.done;

    expect(frameTypes).toEqual(['hello', 'register_node', 'register_handlers', 'deregister_node']);
    broker.close();
  });

  describe('fleet serve enrollment flags', () => {
    function buildServeHarness(
      overrides: {
        enrollFleetNode?: ReturnType<typeof vi.fn>;
        env?: NodeJS.ProcessEnv;
      } = {}
    ) {
      const env: NodeJS.ProcessEnv = overrides.env ?? {};
      const errors: string[] = [];
      const exit = vi.fn(() => {
        throw new Error('__exit__');
      });
      // Stop the flow right after enrollment by failing broker startup with a
      // sentinel, so the test exercises flag parsing + the token exchange only.
      const createRelay = vi.fn(() => {
        throw new Error('__stop_after_enrollment__');
      });
      const enroll =
        overrides.enrollFleetNode ??
        vi.fn(async () => ({
          nodeId: 'node_abc',
          nodeName: 'kjglaptop',
          nodeToken: 'nt_secret',
          relayWorkspaceId: 'rw_123',
          relaycastUrl: 'https://relaycast.example.com',
          websocketUrl: 'https://relaycast.example.com/v1/node/ws',
        }));

      const core = {
        getProjectPaths: () => ({ projectRoot: '/tmp/proj', dataDir: '/tmp/proj/.data' }),
        loadTeamsConfig: () => null,
        createRelay,
        fs: { mkdirSync: vi.fn() },
        env,
        argv: ['node', 'agent-relay'],
        onSignal: vi.fn(),
        isPortInUse: vi.fn(async () => false),
        exit,
      } as never;

      const program = new Command();
      program.exitOverride();
      registerFleetCommands(program, {
        core,
        enrollFleetNode: enroll as never,
        error: (...args: unknown[]) => errors.push(args.join(' ')),
        log: () => undefined,
        warn: () => undefined,
        exit: exit as never,
      });

      return { program, enroll, env, errors, exit };
    }

    it('accepts --enrollment-token/--enrollment-url and exchanges the token', async () => {
      const harness = buildServeHarness();

      await harness.program
        .parseAsync(
          [
            'fleet',
            'serve',
            '--enrollment-token',
            'ocl_node_enr_xyz',
            '--enrollment-url',
            'https://agentrelay.com/api/v1/fleet/register',
            '--name',
            'kjglaptop',
            '--max-agents',
            '4',
          ],
          { from: 'user' }
        )
        .catch(() => undefined);

      expect(harness.enroll).toHaveBeenCalledTimes(1);
      expect(harness.enroll).toHaveBeenCalledWith(
        expect.objectContaining({
          enrollmentToken: 'ocl_node_enr_xyz',
          enrollmentUrl: 'https://agentrelay.com/api/v1/fleet/register',
          name: 'kjglaptop',
          maxAgents: 4,
        })
      );
      // The exchange result is wired into the broker env before serving.
      expect(harness.env.RELAY_NODE_TOKEN).toBe('nt_secret');
      expect(harness.env.RELAY_BASE_URL).toBe('https://relaycast.example.com');
    });

    it('lets an explicit --base-url override the enrollment relaycast url in the broker env', async () => {
      const harness = buildServeHarness();

      await harness.program
        .parseAsync(
          [
            'fleet',
            'serve',
            '--enrollment-token',
            'ocl_node_enr_xyz',
            '--base-url',
            'https://override.example.com',
          ],
          { from: 'user' }
        )
        .catch(() => undefined);

      // Enrollment first writes its relaycastUrl, then the explicit --base-url
      // overrides it so the broker (started from the env) binds to the override.
      expect(harness.env.RELAY_BASE_URL).toBe('https://override.example.com');
    });

    it('keeps the enrollment relaycast url in the broker env when --base-url is omitted', async () => {
      const harness = buildServeHarness();

      await harness.program
        .parseAsync(['fleet', 'serve', '--enrollment-token', 'ocl_node_enr_xyz'], { from: 'user' })
        .catch(() => undefined);

      expect(harness.env.RELAY_BASE_URL).toBe('https://relaycast.example.com');
    });

    it('serves an enrolled node without a <file> argument', async () => {
      const harness = buildServeHarness();

      await harness.program
        .parseAsync(['fleet', 'serve', '--enrollment-token', 'ocl_node_enr_xyz'], { from: 'user' })
        .catch(() => undefined);

      expect(harness.enroll).toHaveBeenCalledTimes(1);
      // Reaching broker startup (the sentinel) proves the missing <file> did not
      // abort the command in enrollment mode.
      expect(harness.env.RELAY_NODE_TOKEN).toBe('nt_secret');
    });

    it('errors when neither <file> nor --enrollment-token is provided', async () => {
      const harness = buildServeHarness();

      await harness.program.parseAsync(['fleet', 'serve'], { from: 'user' }).catch(() => undefined);

      expect(harness.enroll).not.toHaveBeenCalled();
      expect(harness.errors.join('\n')).toMatch(/node definition <file> is required/i);
    });

    it('rejects --enrollment-url without --enrollment-token', async () => {
      const harness = buildServeHarness();

      await harness.program
        .parseAsync(['fleet', 'serve', '--enrollment-url', 'https://agentrelay.com/api/v1/fleet/register'], {
          from: 'user',
        })
        .catch(() => undefined);

      expect(harness.enroll).not.toHaveBeenCalled();
      expect(harness.errors.join('\n')).toMatch(/--enrollment-url requires --enrollment-token/i);
    });

    it('prefers --name over the enrollment nodeName when building the implicit node', async () => {
      vi.resetModules();

      const createImplicitLocalFleetNode = vi.fn(() => defineNode({ name: 'placeholder', capabilities: {} }));
      vi.doMock('../lib/fleet-sidecar.js', async () => {
        const actual =
          await vi.importActual<typeof import('../lib/fleet-sidecar.js')>('../lib/fleet-sidecar.js');
        return { ...actual, createImplicitLocalFleetNode };
      });

      const { registerFleetCommands: registerWithMock } = await import('./fleet.js');

      const enroll = vi.fn(async () => ({
        nodeId: 'node_abc',
        nodeName: 'enrollment-name',
        nodeToken: 'nt_secret',
        relayWorkspaceId: 'rw_123',
        relaycastUrl: 'https://relaycast.example.com',
        websocketUrl: 'https://relaycast.example.com/v1/node/ws',
      }));
      const core = {
        getProjectPaths: () => ({ projectRoot: '/tmp/proj', dataDir: '/tmp/proj/.data' }),
        loadTeamsConfig: () => null,
        createRelay: vi.fn(() => {
          throw new Error('__stop_after_enrollment__');
        }),
        fs: { mkdirSync: vi.fn() },
        env: {} as NodeJS.ProcessEnv,
        argv: ['node', 'agent-relay'],
        onSignal: vi.fn(),
        isPortInUse: vi.fn(async () => false),
        exit: vi.fn(() => {
          throw new Error('__exit__');
        }),
      } as never;

      const program = new Command();
      program.exitOverride();
      registerWithMock(program, {
        core,
        enrollFleetNode: enroll as never,
        error: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      });

      await program
        .parseAsync(['fleet', 'serve', '--enrollment-token', 'ocl_node_enr_xyz', '--name', 'cli-name'], {
          from: 'user',
        })
        .catch(() => undefined);

      expect(createImplicitLocalFleetNode).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'cli-name' })
      );

      vi.doUnmock('../lib/fleet-sidecar.js');
      vi.resetModules();
    });

    it('falls back to the enrollment nodeName when --name is omitted', async () => {
      vi.resetModules();

      const createImplicitLocalFleetNode = vi.fn(() => defineNode({ name: 'placeholder', capabilities: {} }));
      vi.doMock('../lib/fleet-sidecar.js', async () => {
        const actual =
          await vi.importActual<typeof import('../lib/fleet-sidecar.js')>('../lib/fleet-sidecar.js');
        return { ...actual, createImplicitLocalFleetNode };
      });

      const { registerFleetCommands: registerWithMock } = await import('./fleet.js');

      const enroll = vi.fn(async () => ({
        nodeId: 'node_abc',
        nodeName: 'enrollment-name',
        nodeToken: 'nt_secret',
        relayWorkspaceId: 'rw_123',
        relaycastUrl: 'https://relaycast.example.com',
        websocketUrl: 'https://relaycast.example.com/v1/node/ws',
      }));
      const core = {
        getProjectPaths: () => ({ projectRoot: '/tmp/proj', dataDir: '/tmp/proj/.data' }),
        loadTeamsConfig: () => null,
        createRelay: vi.fn(() => {
          throw new Error('__stop_after_enrollment__');
        }),
        fs: { mkdirSync: vi.fn() },
        env: {} as NodeJS.ProcessEnv,
        argv: ['node', 'agent-relay'],
        onSignal: vi.fn(),
        isPortInUse: vi.fn(async () => false),
        exit: vi.fn(() => {
          throw new Error('__exit__');
        }),
      } as never;

      const program = new Command();
      program.exitOverride();
      registerWithMock(program, {
        core,
        enrollFleetNode: enroll as never,
        error: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        exit: (() => {
          throw new Error('__exit__');
        }) as never,
      });

      await program
        .parseAsync(['fleet', 'serve', '--enrollment-token', 'ocl_node_enr_xyz'], { from: 'user' })
        .catch(() => undefined);

      expect(createImplicitLocalFleetNode).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'enrollment-name' })
      );

      vi.doUnmock('../lib/fleet-sidecar.js');
      vi.resetModules();
    });

    it('validates the <file> before redeeming the one-time enrollment token', async () => {
      const harness = buildServeHarness();

      // A nonexistent node file must fail-fast WITHOUT burning the single-use
      // enrollment token, so the operator can fix the path and retry the token.
      await harness.program
        .parseAsync(
          ['fleet', 'serve', '/tmp/does-not-exist-node-def.ts', '--enrollment-token', 'ocl_node_enr_xyz'],
          { from: 'user' }
        )
        .catch(() => undefined);

      expect(harness.enroll).not.toHaveBeenCalled();
      expect(harness.env.RELAY_NODE_TOKEN).toBeUndefined();
    });
  });

  describe('stripEnrollmentFlags', () => {
    it('removes --enrollment-token/--enrollment-url and their space-separated values', () => {
      const argv = [
        'node',
        'agent-relay',
        'fleet',
        'serve',
        '--enrollment-token',
        'ocl_node_enr_xyz',
        '--enrollment-url',
        'https://agentrelay.com/api/v1/fleet/register',
        '--name',
        'kjglaptop',
      ];

      expect(stripEnrollmentFlags(argv)).toEqual([
        'node',
        'agent-relay',
        'fleet',
        'serve',
        '--name',
        'kjglaptop',
      ]);
    });

    it('removes the --flag=value inline form without dropping the following token', () => {
      const argv = ['fleet', 'serve', '--enrollment-token=ocl_node_enr_xyz', '--name', 'kjglaptop'];

      expect(stripEnrollmentFlags(argv)).toEqual(['fleet', 'serve', '--name', 'kjglaptop']);
    });

    it('leaves argv untouched when no enrollment flags are present', () => {
      const argv = ['fleet', 'serve', 'node.ts', '--base-url', 'https://relaycast.example.com'];

      expect(stripEnrollmentFlags(argv)).toEqual(argv);
    });
  });

  it('keeps trigger sync idempotent across repeated node registrations', async () => {
    vi.resetModules();

    const triggerCreate = vi.fn(async (input: unknown) => input);
    const triggerUpdate = vi.fn(async (input: unknown) => input);
    const triggerDelete = vi.fn(async () => undefined);
    const triggerList = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'trigger-1',
          actionName: 'echo',
          channel: '#general',
          pattern: 'hello',
          mention: true,
          enabled: true,
        },
      ]);

    vi.doMock('@agent-relay/sdk', () => ({
      AgentRelay: vi.fn(function () {
        return {
          triggers: {
            list: triggerList,
            create: triggerCreate,
            update: triggerUpdate,
            delete: triggerDelete,
          },
        };
      }),
    }));

    const { serveFleetSidecar: mockedServeFleetSidecar } = await import('../lib/fleet-sidecar.js');
    const node = defineNode({
      name: 'idempotent-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
      triggers: [onMessage({ channel: '#general', match: /hello/, mention: true }, 'echo')],
    });

    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    let connectionCount = 0;
    broker.on('connection', (ws) => {
      connectionCount += 1;
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; request_id?: string };
        if (frame.request_id) {
          ws.send(
            JSON.stringify({
              v: 2,
              type: 'ok',
              request_id: frame.request_id,
              payload: { result: { ok: true } },
            })
          );
        }
        if (frame.type === 'register_handlers') {
          setTimeout(() => ws.close(), 25);
        }
      });
    });

    await mockedServeFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
      workspaceKey: 'rk_live_test',
    });

    await mockedServeFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
      workspaceKey: 'rk_live_test',
    });

    expect(connectionCount).toBe(2);
    expect(triggerCreate).toHaveBeenCalledTimes(1);
    expect(triggerUpdate).not.toHaveBeenCalled();
    expect(triggerDelete).not.toHaveBeenCalled();
    broker.close();
  });

  it('re-enables a disabled matching trigger instead of creating a duplicate', async () => {
    vi.resetModules();

    const triggerCreate = vi.fn(async (input: unknown) => input);
    const triggerUpdate = vi.fn(async (input: unknown) => input);
    const triggerDelete = vi.fn(async () => undefined);
    const triggerList = vi.fn().mockResolvedValueOnce([
      {
        id: 'trigger-1',
        actionName: 'echo',
        channel: '#general',
        pattern: 'hello',
        mention: true,
        enabled: false,
      },
    ]);

    vi.doMock('@agent-relay/sdk', () => ({
      AgentRelay: vi.fn(function () {
        return {
          triggers: {
            list: triggerList,
            create: triggerCreate,
            update: triggerUpdate,
            delete: triggerDelete,
          },
        };
      }),
    }));

    const { serveFleetSidecar: mockedServeFleetSidecar } = await import('../lib/fleet-sidecar.js');
    const node = defineNode({
      name: 'reenable-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
      triggers: [onMessage({ channel: '#general', match: /hello/, mention: true }, 'echo')],
    });

    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    broker.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; request_id?: string };
        if (frame.request_id) {
          ws.send(
            JSON.stringify({
              v: 2,
              type: 'ok',
              request_id: frame.request_id,
              payload: { result: { ok: true } },
            })
          );
        }
        if (frame.type === 'register_handlers') {
          ws.close();
        }
      });
    });

    await mockedServeFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
      workspaceKey: 'rk_live_test',
    });

    expect(triggerList).toHaveBeenCalledTimes(1);
    expect(triggerCreate).not.toHaveBeenCalled();
    expect(triggerUpdate).toHaveBeenCalledWith('trigger-1', {
      channel: '#general',
      pattern: 'hello',
      mention: true,
      actionName: 'echo',
      enabled: true,
    });
    expect(triggerDelete).not.toHaveBeenCalled();
    broker.close();
  });
});
