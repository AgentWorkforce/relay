import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// The runner copies this file into <target>/.relay-pr-proof/.
//
// The proof is at the `node up` environment seam: a discovered
// `agent-relay.mjs` definition declares `maxAgents: 15`, and `runUpCommand`
// runs with everything broker-shaped mocked out. On the buggy base the
// definition's cap never reaches the broker environment, so the broker would
// register and heartbeat `max_agents: 0` (unlimited) while the sidecar
// provider registers 15 — and the fleet roster reports the broker's 0. On
// the fixed head `runUpCommand` forwards the cap into
// `AGENT_RELAY_NODE_MAX_AGENTS` before the broker starts.
//
// Only seams that exist on both arms are used: `runUpCommand`,
// `AGENT_RELAY_NODE_MAX_AGENTS` on `deps.env`, and the marker-object config
// shape `loadNodeDefinition` accepts. `resolveNodeMaxAgents` does not exist
// on the base, so the probe observes its effect (the env var), never the
// helper itself.
import { runUpCommand } from '../packages/cli/src/cli/lib/broker-lifecycle.js';

vi.mock('../packages/cli/src/cli/telemetry/index.js', () => ({ track: vi.fn() }));
vi.mock('../packages/cli/src/cli/lib/reflex-capture.js', () => ({
  startReflexCapture: vi.fn(() => ({ stop: vi.fn(async () => undefined) })),
}));
vi.mock('@agent-relay/fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/fleet')>();
  return {
    ...actual,
    startServeNode: vi.fn(() => ({ stop: vi.fn(async () => undefined), done: Promise.resolve() })),
  };
});
vi.mock('@agent-relay/harness-driver', () => ({
  HarnessDriverClient: class {
    async getSession() {
      return {
        node_id: 'node_a',
        node_name: 'the-node',
        workspace_key: 'rk_live_secret',
        node_token: 'nt_live_secret',
        broker_version: 'test',
        protocol_version: 2,
        mode: 'persist',
        uptime_secs: 1,
      };
    }
    async getStatus() {
      return {};
    }
    disconnect() {}
  },
}));

const ARM = process.env.RELAY_PR_PROOF_ARM;

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function makeDeps(projectRoot: string, dataDir: string, home: string) {
  const connection = JSON.stringify({
    url: 'http://127.0.0.1:4999',
    port: 4999,
    api_key: 'test',
    pid: 999999,
  });
  let lockPath = path.join(dataDir, `broker-${path.basename(projectRoot)}.lock`);
  const createRelay = vi.fn(async (_root: string, _port: number, brokerName?: string) => {
    lockPath = path.join(
      dataDir,
      `broker-${(brokerName || path.basename(projectRoot)).replace(/[^\p{Alphabetic}\p{Number}-]/gu, '-')}.lock`
    );
    fs.writeFileSync(lockPath, 'fixture lock');
    return {
      brokerPid: 999999,
      spawn: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => undefined),
      workspaceKey: 'rk_test',
      workspaceId: 'rw_test',
    };
  });
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  });
  return {
    getProjectPaths: () => ({ projectRoot, dataDir, teamDir: projectRoot }),
    loadTeamsConfig: () => null,
    createRelay,
    spawnProcess: vi.fn(),
    execCommand: vi.fn(async (command: string) => {
      if (command === 'LC_ALL=C TZ=UTC ps -p 999999 -o lstart=') {
        return { stdout: 'Thu Sep 10 18:00:00 2026\n', stderr: '' };
      }
      if (command.startsWith('LC_ALL=C lsof -t --')) return { stdout: 'rc=1', stderr: '' };
      if (command === 'lsof -nP -a -p 999999 -d txt -FfDi') {
        return { stdout: 'p999999\nftxt\nD0x100\ni1234\n', stderr: '' };
      }
      if (command === 'lsof -nP -a -p 999999 -FfnDi') {
        const stat = fs.statSync(lockPath, { bigint: true });
        return {
          stdout: `p999999\nf10\nD0x${stat.dev.toString(16)}\ni${stat.ino}\nn${fs.realpathSync(lockPath)}\n`,
          stderr: '',
        };
      }
      throw new Error(`Unexpected fixture command: ${command}`);
    }),
    killProcess: vi.fn(() => {
      throw new Error('not running');
    }),
    fs: {
      realpathSync: fs.realpathSync,
      statSync: fs.statSync,
      existsSync: fs.existsSync,
      readFileSync: (file: string, encoding: BufferEncoding) =>
        file.endsWith('connection.json') ? connection : fs.readFileSync(file, encoding),
      writeFileSync: fs.writeFileSync,
      renameSync: fs.renameSync,
      unlinkSync: fs.unlinkSync,
      readdirSync: fs.readdirSync,
      mkdirSync: fs.mkdirSync,
      rmSync: fs.rmSync,
      accessSync: fs.accessSync,
    },
    generateAgentName: () => 'agent',
    checkForUpdates: vi.fn(async () => ({ updateAvailable: false })),
    getVersion: () => 'test',
    env: {
      RELAY_NODE_TOKEN: 'nt_live_test',
      RELAY_BASE_URL: 'https://engine.test',
      AGENT_RELAY_HOME: home,
      HOME: home,
      XDG_DATA_HOME: path.join(home, 'data'),
    } as NodeJS.ProcessEnv,
    argv: ['node', 'agent-relay', 'node', 'up'],
    execPath: process.execPath,
    cliScript: 'cli.js',
    pid: process.pid,
    isPortInUse: vi.fn(async () => false),
    now: () => 0,
    sleep: async () => undefined,
    onSignal: vi.fn(),
    holdOpen: async () => undefined,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    exit,
  };
}

describe('node up maxAgents forwarding (PR proof)', () => {
  it('reports the definition cap to the broker on head; drops it on base', async () => {
    expect(['base', 'head']).toContain(ARM);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proof-1828-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proof-1828-home-'));
    try {
      const dataDir = path.join(projectRoot, '.agentworkforce', 'relay');
      fs.mkdirSync(dataDir, { recursive: true });
      // Marker-object definition: no `@agent-relay/fleet` import, so the
      // loader accepts it on both arms exactly as the unit harness does.
      fs.writeFileSync(
        path.join(projectRoot, 'agent-relay.mjs'),
        "export default { __agentRelayFleetNode: true, name: 'sf-frame', maxAgents: 15, capabilities: {}, triggers: [] };\n"
      );
      const deps = makeDeps(projectRoot, dataDir, home);

      await runUpCommand({ discoverConfig: true } as never, deps as never);

      const forwarded = (deps.env as NodeJS.ProcessEnv).AGENT_RELAY_NODE_MAX_AGENTS;
      if (ARM === 'base') {
        // The bug: the cap never reaches the broker environment, so the
        // broker registers and heartbeats max_agents 0 (unlimited) while the
        // sidecar provider registers 15 — `fleet nodes list` shows 1/unlimited.
        expect(forwarded).toBeUndefined();
      } else {
        expect(forwarded).toBe('15');
      }
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
