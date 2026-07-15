import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoreDependencies, CoreRelay } from './cli/commands/core.js';
import { startEmbeddedNodeWithDependencies } from './cli/lib/node-embedded.js';
import { downEmbeddedNode, startEmbeddedNode, statusEmbeddedNode } from './node-embedded.js';

vi.mock('./cli/lib/reflex-capture.js', () => ({
  startReflexCapture: () => ({ stop: vi.fn(async () => undefined) }),
}));

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-embedded-'));
  tempRoots.push(root);
  return root;
}

function successfulLifecycleOverrides(projectRoot: string) {
  const dataDir = path.join(projectRoot, '.agentworkforce', 'relay');
  fs.mkdirSync(dataDir, { recursive: true });
  const shutdown = vi.fn(async () => undefined);
  const relay: CoreRelay = {
    spawn: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({})),
    shutdown,
    workspaceKey: 'rk_test',
  };
  const overrides: Partial<CoreDependencies> = {
    getProjectPaths: () => ({ projectRoot, dataDir, teamDir: projectRoot }),
    loadTeamsConfig: () => null,
    createRelay: vi.fn(async () => relay),
    execCommand: vi.fn(async () => ({ stdout: '', stderr: '' })),
    killProcess: vi.fn(() => {
      throw new Error('not running');
    }),
    fs: {
      existsSync: fs.existsSync,
      readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
      writeFileSync: (filePath, data, encoding) => fs.writeFileSync(filePath, data, encoding),
      unlinkSync: fs.unlinkSync,
      readdirSync: (directory) => fs.readdirSync(directory),
      mkdirSync: (directory, options) => fs.mkdirSync(directory, options),
      rmSync: (target, options) => fs.rmSync(target, options),
      accessSync: fs.accessSync,
    },
    env: { AGENT_RELAY_DISABLE_IMPLICIT_FLEET_NODE: '1' },
    argv: ['node', 'relay', 'node', 'up'],
    execPath: process.execPath,
    cliScript: 'relay.js',
    pid: process.pid,
    now: () => Date.now(),
    sleep: async () => undefined,
    isPortInUse: vi.fn(async () => false),
  };
  return { overrides, relay, shutdown };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('embedded node lifecycle', () => {
  it('survives an already-running path that previously exited the process', async () => {
    const processPidBefore = process.pid;
    const stateDir = makeTempRoot();
    fs.writeFileSync(
      path.join(stateDir, 'connection.json'),
      JSON.stringify({
        url: 'http://127.0.0.1:3889',
        port: 3889,
        api_key: 'test',
        pid: process.pid,
      })
    );

    const result = await startEmbeddedNode({ stateDir });

    // Reaching these assertions is the survival proof: the real public entry
    // point traversed runUpCommand's deps.exit(1) path without terminating the
    // Vitest process.
    expect(process.pid).toBe(processPidBefore);
    expect(result).toMatchObject({
      ok: false,
      code: 1,
      message: expect.stringContaining('Broker already running'),
    });
    expect(result.output.some((entry) => entry.message.includes('Broker already running'))).toBe(true);
  });

  it('owns shutdown through its handle without installing host signal listeners or writing to console', async () => {
    const projectRoot = makeTempRoot();
    const { overrides, shutdown } = successfulLifecycleOverrides(projectRoot);
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const originalMcpCommand = process.env.AGENT_RELAY_MCP_COMMAND;
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const streamed: string[] = [];

    const started = await startEmbeddedNodeWithDependencies(
      { verbose: true },
      { onOutput: (entry) => streamed.push(entry.message) },
      overrides
    );

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    expect(process.env.AGENT_RELAY_MCP_COMMAND).toBe(originalMcpCommand);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(streamed).toContain('Broker started.');

    await expect(started.handle.stop()).resolves.toMatchObject({ ok: true, code: 0 });
    await expect(started.handle.completion).resolves.toMatchObject({ ok: true, code: 0 });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
  });

  it.each([true, 'true', 1])(
    'rejects truthy detached background ownership (%j) before running the CLI lifecycle',
    async (background) => {
      const projectRoot = makeTempRoot();
      const { overrides } = successfulLifecycleOverrides(projectRoot);
      const spawnProcess = vi.fn(() => {
        throw new Error('detached spawn must not be reached');
      });
      const result = await startEmbeddedNodeWithDependencies(
        { background } as never,
        {},
        { ...overrides, spawnProcess }
      );

      expect(result).toEqual({
        ok: false,
        code: 2,
        message:
          'Embedded node startup does not support background mode; omit `background` and own the returned lifecycle handle.',
        output: [
          {
            level: 'error',
            message:
              'Embedded node startup does not support background mode; omit `background` and own the returned lifecycle handle.',
          },
        ],
      });
      expect(spawnProcess).not.toHaveBeenCalled();
    }
  );

  it('converts status-command exits into structured failures', async () => {
    const processPidBefore = process.pid;

    const result = await statusEmbeddedNode({ waitFor: 'not-a-number' });

    expect(process.pid).toBe(processPidBefore);
    expect(result).toMatchObject({
      ok: false,
      code: 1,
      message: '--wait-for must be a non-negative number of seconds.',
    });
  });

  it('reports a non-throwing down-command shutdown error as failure', async () => {
    const processPidBefore = process.pid;
    const stateDir = makeTempRoot();
    const fakeBrokerPid = 2_000_000_000;
    fs.writeFileSync(
      path.join(stateDir, 'connection.json'),
      JSON.stringify({
        url: 'http://127.0.0.1:3889',
        port: 3889,
        api_key: 'test',
        pid: fakeBrokerPid,
      })
    );
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === fakeBrokerPid && signal === 0) return true;
      if (pid === fakeBrokerPid && signal === 'SIGTERM') {
        throw new Error('denied embedded shutdown');
      }
      return realKill(pid, signal);
    });

    const result = await downEmbeddedNode({ stateDir });

    expect(process.pid).toBe(processPidBefore);
    expect(result).toMatchObject({
      ok: false,
      code: 1,
      message: 'Error stopping broker: denied embedded shutdown',
    });
    expect(result.output).toContainEqual({
      level: 'error',
      message: 'Error stopping broker: denied embedded shutdown',
    });
  });

  it('resolves project paths from the isolated env instead of the host env', async () => {
    const hostProject = makeTempRoot();
    const embeddedProject = makeTempRoot();
    const hostStateDir = path.join(hostProject, '.agentworkforce', 'relay');
    fs.mkdirSync(hostStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostStateDir, 'connection.json'),
      JSON.stringify({
        url: 'http://127.0.0.1:3889',
        port: 3889,
        api_key: 'test',
        pid: process.pid,
      })
    );
    const originalHostProject = process.env.AGENT_RELAY_PROJECT;
    process.env.AGENT_RELAY_PROJECT = hostProject;

    try {
      const result = await statusEmbeddedNode({}, { env: { AGENT_RELAY_PROJECT: embeddedProject } });

      expect(result).toMatchObject({ ok: true, code: 0 });
      expect(result.output).toContainEqual({ level: 'info', message: 'Status: STOPPED' });
    } finally {
      if (originalHostProject === undefined) delete process.env.AGENT_RELAY_PROJECT;
      else process.env.AGENT_RELAY_PROJECT = originalHostProject;
    }
  });

  it('resolves the bundled MCP helper beside the package CLI instead of the host script', async () => {
    const projectRoot = makeTempRoot();
    const { overrides } = successfulLifecycleOverrides(projectRoot);
    const checkedPaths: string[] = [];
    const realFs = overrides.fs!;
    overrides.fs = {
      ...realFs,
      existsSync: (filePath) => {
        checkedPaths.push(filePath);
        return realFs.existsSync(filePath);
      },
    };
    delete overrides.cliScript;

    const started = await startEmbeddedNodeWithDependencies({}, {}, overrides);

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);
    expect(checkedPaths).toContain(fileURLToPath(new URL('./cli/agent-relay-mcp.js', import.meta.url)));
    await started.handle.stop();
  });

  it('keeps all 14 lifecycle exits behind the injected dependency boundary', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'cli', 'lib', 'broker-lifecycle.ts'),
      'utf8'
    );
    const up = source.slice(
      source.indexOf('export async function runUpCommand'),
      source.indexOf('export async function runDownCommand')
    );
    const background = up.slice(up.indexOf('if (options.background)'), up.indexOf('const basePort'));
    const foreground = up.slice(up.indexOf('const basePort'));
    const down = source.slice(
      source.indexOf('export async function runDownCommand'),
      source.indexOf('export async function runStatusCommand')
    );
    const status = source.slice(source.indexOf('export async function runStatusCommand'));
    const exitCount = (text: string) => text.match(/\bdeps\.exit\(/g)?.length ?? 0;

    expect(exitCount(background)).toBe(5);
    expect(exitCount(foreground)).toBe(6);
    expect(exitCount(down)).toBe(0);
    expect(exitCount(status)).toBe(3);
    expect(exitCount(source)).toBe(14);
    expect(source).not.toMatch(/\bprocess\.exit\s*\(/);
    expect(source).not.toMatch(/\bprocess\.(?:on|once)\s*\(/);
    expect(source).not.toMatch(/\bconsole\.(?:log|warn|error)\s*\(/);
    expect(source).not.toContain("stdio: 'inherit'");
  });
});
