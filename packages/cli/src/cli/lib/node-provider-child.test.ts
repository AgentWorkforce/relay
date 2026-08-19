import { exec as execCallback, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  descriptorCapacitySource,
  describeNodeDefinitionViaNode,
  isJsNodeDefinition,
  materializeNodeProviderChildScript,
  packageRootFromEntry,
  parseNodeDescriptor,
  startNodeJsNodeProvider,
} from './node-provider-child.js';
import { nodeCapacityHarnesses } from './fleet-sidecar.js';
import type { CoreDependencies, SpawnedProcess } from '../commands/core.js';

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

const execAsync = promisify(execCallback);

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it('preserves the local repo path map for the broker child only', () => {
    const repoPaths = { 'AgentWorkforce/relay': '/srv/checkouts/relay' };
    const stdout = `${MARKER}${JSON.stringify({ name: 'real', capabilities: [], repoPaths })}\n`;

    expect(parseNodeDescriptor(stdout)).toEqual({ name: 'real', capabilities: [], repoPaths });
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

describe('packageRootFromEntry', () => {
  it('finds the fleet root in a Windows require.resolve path', () => {
    expect(
      packageRootFromEntry(
        'C:\\project\\node_modules\\@agent-relay\\fleet\\dist\\index.js',
        '@agent-relay/fleet'
      )
    ).toBe('C:\\project\\node_modules\\@agent-relay\\fleet');
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

  it('removes the materialized bootstrap after a real describe child exits', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'relay-node-provider-describe-'));
    const tempRoot = path.join(root, 'tmp');
    const config = path.join(root, 'agent-relay.mjs');
    mkdirSync(tempRoot);
    writeFileSync(
      config,
      "export default { __agentRelayFleetNode: true, name: 'fixture', capabilities: {}, triggers: [] };\n"
    );

    try {
      await expect(
        describeNodeDefinitionViaNode(
          config,
          deps({
            env: { ...process.env, TMPDIR: tempRoot },
            execCommand: async (command) => {
              const result = await execAsync(command);
              return { stdout: result.stdout, stderr: result.stderr };
            },
          })
        )
      ).resolves.toEqual({ name: 'fixture', capabilities: [] });
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains a large real child load error before exiting', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'relay-node-provider-error-drain-'));
    const tempRoot = path.join(root, 'tmp');
    const config = path.join(root, 'agent-relay.mjs');
    const tail = '__AGENT_RELAY_ERROR_TAIL__';
    mkdirSync(tempRoot);
    writeFileSync(config, `throw new Error(${JSON.stringify('x'.repeat(256_000) + tail)});\n`);

    try {
      let message = '';
      await describeNodeDefinitionViaNode(
        config,
        deps({
          env: { ...process.env, TMPDIR: tempRoot },
          execCommand: async (command) => {
            const result = await execAsync(command);
            return { stdout: result.stdout, stderr: result.stderr };
          },
        })
      ).catch((err: unknown) => {
        message = err instanceof Error ? err.message : String(err);
      });

      expect(message).toContain(tail);
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('startNodeJsNodeProvider', () => {
  it('passes node credentials through the env contract the child reads', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 42, kill: vi.fn() }));
    const d = deps({ spawnProcess });

    const child = await startNodeJsNodeProvider(
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
    await child?.stop();
  });

  it('omits optional env when not provided, so the SDK applies its own defaults', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 1, kill: vi.fn() }));

    const child = await startNodeJsNodeProvider(
      '/proj/agent-relay.ts',
      { nodeToken: 't', nodeId: 'n', nodeName: 'x' },
      deps({ spawnProcess })
    );

    const options = spawnProcess.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.RELAY_BASE_URL).toBeUndefined();
    expect(options.env.RELAY_WORKSPACE_KEY).toBeUndefined();
    await child?.stop();
  });

  it('handles the real asynchronous ENOENT emitted when node is missing', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'relay-node-provider-missing-node-'));
    const tempRoot = path.join(root, 'tmp');
    const config = path.join(root, 'agent-relay.mjs');
    mkdirSync(tempRoot);
    writeFileSync(
      config,
      "export default { __agentRelayFleetNode: true, name: 'fixture', capabilities: {}, triggers: [] };\n"
    );
    const warn = vi.fn();
    try {
      const child = await startNodeJsNodeProvider(
        config,
        { nodeToken: 't', nodeId: 'n', nodeName: 'x' },
        realProcessDeps({
          env: {
            ...process.env,
            TMPDIR: tempRoot,
            AGENT_RELAY_NODE: path.join(root, 'node-does-not-exist'),
            RELAY_WORKSPACE_KEY: '',
          },
          warn,
        })
      );

      expect(child).toBeUndefined();
      expect(warn.mock.calls[0]?.[0]).toMatch(/AGENT_RELAY_NODE/);
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes real child lifecycle logs through the shared file/JSON logger', async () => {
    const fixture = createServingFixture();
    const logFile = path.join(fixture.root, 'node.log');
    vi.stubEnv('AGENT_RELAY_LOG_FILE', logFile);
    vi.stubEnv('AGENT_RELAY_LOG_LEVEL', 'DEBUG');
    vi.stubEnv('AGENT_RELAY_LOG_JSON', '1');

    try {
      const child = await startNodeJsNodeProvider(
        fixture.config,
        { nodeToken: 't', nodeId: 'n', nodeName: 'x' },
        realProcessDeps({
          env: {
            ...process.env,
            TMPDIR: fixture.tempRoot,
            RELAY_WORKSPACE_KEY: '',
          },
        })
      );
      expect(child).toBeDefined();

      await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('fixture info'));
      await child!.stop();
      await expect(child!.done).resolves.toBeUndefined();

      const entries = readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'DEBUG', component: 'fleet', msg: 'fixture debug' }),
          expect.objectContaining({ level: 'INFO', component: 'fleet', msg: 'fixture info' }),
          expect.objectContaining({ level: 'WARN', component: 'fleet', msg: 'fixture warning' }),
        ])
      );
      expect(readdirSync(fixture.tempRoot)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('surfaces an unexpected real child exit through the managed handle', async () => {
    const fixture = createServingFixture();
    try {
      const child = await startNodeJsNodeProvider(
        fixture.config,
        { nodeToken: 't', nodeId: 'n', nodeName: 'x' },
        realProcessDeps({
          env: {
            ...process.env,
            TMPDIR: fixture.tempRoot,
            FIXTURE_EXIT_AFTER_LOG: '1',
            RELAY_WORKSPACE_KEY: '',
          },
        })
      );

      await expect(child?.done).rejects.toThrow(/exited unexpectedly/);
      expect(readdirSync(fixture.tempRoot)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('force-kills a real provider that ignores graceful shutdown', async () => {
    const fixture = createServingFixture();
    const readyFile = path.join(fixture.root, 'ignore-abort-ready');
    let pid: number | undefined;
    try {
      const child = await startNodeJsNodeProvider(
        fixture.config,
        { nodeToken: 't', nodeId: 'n', nodeName: 'x' },
        realProcessDeps({
          env: {
            ...process.env,
            TMPDIR: fixture.tempRoot,
            FIXTURE_IGNORE_ABORT: '1',
            FIXTURE_READY_FILE: readyFile,
            RELAY_WORKSPACE_KEY: '',
          },
          // Shorten only the graceful-shutdown budget. The post-SIGKILL wait
          // must remain long enough for the operating system to reap the real
          // child process before this integration test checks its PID.
          sleep: (ms) => delay(ms === 5_000 ? 50 : ms),
        })
      );
      expect(child).toBeDefined();
      pid = child!.pid;
      expect(pid).toBeDefined();
      await waitFor(() => existsSync(readyFile));

      await child!.stop();

      await expect(child!.done).resolves.toBeUndefined();
      expect(isProcessRunning(pid!)).toBe(false);
      expect(readdirSync(fixture.tempRoot)).toEqual([]);
    } finally {
      if (pid && isProcessRunning(pid)) {
        process.kill(pid, 'SIGKILL');
        await delay(50);
      }
      fixture.cleanup();
    }
  });
});

describe('node provider child logging defaults', () => {
  it('keeps debug/info off inherited stdout when no logging flag is set', () => {
    const fixture = createServingFixture();
    const materialized = materializeNodeProviderChildScript(fixture.config, fixture.tempRoot);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RELAY_NODE_TOKEN: 't',
      RELAY_NODE_ID: 'n',
      RELAY_WORKSPACE_KEY: '',
      FIXTURE_EXIT_AFTER_LOG: '1',
    };
    delete env.AGENT_RELAY_LOG_FILE;
    delete env.AGENT_RELAY_LOG_LEVEL;
    delete env.AGENT_RELAY_LOG_JSON;

    try {
      const result = spawnSync(
        process.execPath,
        [...materialized.nodeArgs, materialized.scriptPath, fixture.config],
        { cwd: fixture.root, env, encoding: 'utf8' }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).not.toMatch(/fixture (debug|info)/);
      expect(result.stderr).toContain('fixture warning');
    } finally {
      materialized.cleanup();
      fixture.cleanup();
    }
  });
});

function realProcessDeps(overrides: Partial<CoreDependencies> = {}): CoreDependencies {
  return deps({
    spawnProcess: (command, args, options) =>
      spawn(command, args, options as never) as unknown as SpawnedProcess,
    killProcess: (pid, signal) => process.kill(pid, signal),
    sleep: delay,
    env: { ...process.env },
    ...overrides,
  });
}

function createServingFixture(): {
  root: string;
  tempRoot: string;
  config: string;
  cleanup(): void;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'relay-node-provider-serving-'));
  const tempRoot = path.join(root, 'tmp');
  const config = path.join(root, 'agent-relay.mjs');
  const fleetRoot = path.join(root, 'node_modules', '@agent-relay', 'fleet');
  mkdirSync(path.join(fleetRoot, 'dist'), { recursive: true });
  mkdirSync(tempRoot);
  writeFileSync(
    config,
    "export default { __agentRelayFleetNode: true, name: 'fixture', capabilities: {}, triggers: [] };\n"
  );
  writeFileSync(
    path.join(fleetRoot, 'package.json'),
    JSON.stringify({
      name: '@agent-relay/fleet',
      version: '10.0.0',
      type: 'module',
      main: 'dist/index.js',
      exports: { '.': './dist/index.js' },
    })
  );
  writeFileSync(
    path.join(fleetRoot, 'dist', 'index.js'),
    [
      "import { writeFileSync } from 'node:fs';",
      'export async function serveNode(options) {',
      "  options.logger?.debug('fixture debug', { capability: 'spawn:test' });",
      "  options.logger?.info('fixture info', { action: 'spawn:test' });",
      "  options.logger?.warn('fixture warning', { action: 'spawn:test' });",
      "  options.log?.('fixture debug');",
      "  options.log?.('fixture info');",
      "  options.warn?.('fixture warning');",
      "  if (process.env.FIXTURE_EXIT_AFTER_LOG === '1') return;",
      "  if (process.env.FIXTURE_IGNORE_ABORT === '1') {",
      "    writeFileSync(process.env.FIXTURE_READY_FILE, 'ready');",
      '    setInterval(() => undefined, 1_000);',
      '    await new Promise(() => undefined);',
      '  }',
      '  if (options.signal.aborted) return;',
      '  await new Promise((resolve) => {',
      '    const keepAlive = setInterval(() => undefined, 1_000);',
      "    options.signal.addEventListener('abort', () => { clearInterval(keepAlive); resolve(); }, { once: true });",
      '  });',
      '}',
    ].join('\n')
  );
  return {
    root,
    tempRoot,
    config,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await delay(20);
  }
}
