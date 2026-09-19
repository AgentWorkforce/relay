import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

// The runner copies this file into <target>/.relay-pr-proof/.
//
// The proof is at the `node up` command seam: a claim file naming a LIVE pid
// sits in the machine-global claims directory, an enrollment resolves to the
// same node id, and `node up` runs with broker-lifecycle's `runUpCommand`
// mocked so nothing spawns. On the buggy base the start proceeds straight to
// `runUpCommand` — two brokers end up registered under one node id and the
// engine evicts the live node's Cloud delivery socket. On the fixed head the
// guard refuses before `runUpCommand` is reached.
//
// `broker-lifecycle.js` is imported by `node.ts` under the same specifier on
// both arms, so the mock applies everywhere. `node-claim.ts` is NOT imported:
// it does not exist on the base, and the claim file below is written with the
// same on-disk layout the guard reads.
import { registerNodeCommands } from '../packages/cli/src/cli/commands/node.js';

const brokerMocks = vi.hoisted(() => ({
  runUpCommand: vi.fn(async () => undefined),
}));

vi.mock('../packages/cli/src/cli/lib/broker-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/cli/src/cli/lib/broker-lifecycle.js')>();
  return {
    ...actual,
    runUpCommand: (...args: unknown[]) => brokerMocks.runUpCommand(...args),
  };
});

const ARM = process.env.RELAY_PR_PROOF_ARM;

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const enrollmentRecord = {
  nodeId: 'node_abc',
  nodeName: 'kjglaptop',
  nodeToken: 'nt_secret',
  relayWorkspaceId: 'rw_123',
  relaycastUrl: 'https://relaycast.example.com',
  websocketUrl: 'https://relaycast.example.com/v1/node/ws',
  enrolledAt: '2026-07-03T00:00:00.000Z',
};

function makeHarness(env: NodeJS.ProcessEnv) {
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  });
  const log = vi.fn();
  const error = vi.fn();
  const warn = vi.fn();
  const core = {
    env,
    exit,
    log,
    error,
    warn,
    getProjectPaths: () => ({ projectRoot: '/repo', dataDir: '/repo/.agentworkforce/relay' }),
  };
  const program = new Command();
  program.exitOverride();
  registerNodeCommands(program, {
    core: core as never,
    exit: exit as never,
    log,
    error,
    warn,
    resolveEnrollment: vi.fn(() => enrollmentRecord) as never,
    // Never let the probe read the sandbox's real fleet-enrollments.json.
    listFleetEnrollments: vi.fn(() => []) as never,
    resolveProjectWorkspaceSession: vi.fn(() => undefined) as never,
  });
  return { program, exit, log, error, warn };
}

/**
 * A claim generation for `node_abc` held by a pid that is provably alive
 * (this test process). Same layout `nodeClaimPath()` writes:
 * `<AGENT_RELAY_HOME>/node-claims/<stem>.<6-digit generation>.json`.
 */
function writeHeldClaim(home: string): void {
  const claimsDir = path.join(home, 'node-claims');
  fs.mkdirSync(claimsDir, { recursive: true });
  const claim = {
    version: 1,
    node_id: 'node_abc',
    pid: process.pid,
    state_dir: '/other-checkout/.agentworkforce/relay',
    api_port: 3891,
    broker_name: 'kjglaptop',
    claimed_at: '2026-10-05T12:00:00.000Z',
  };
  fs.writeFileSync(
    path.join(claimsDir, 'node_abc.000001.json'),
    `${JSON.stringify(claim, null, 2)}\n`
  );
}

describe('node up enrollment guard (PR proof)', () => {
  it('decides whether a second start may adopt a claimed node id', async () => {
    expect(['base', 'head']).toContain(ARM);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proof-1801-'));
    try {
      writeHeldClaim(home);
      const env: NodeJS.ProcessEnv = {
        AGENT_RELAY_HOME: home,
        HOME: home,
        XDG_DATA_HOME: path.join(home, 'data'),
      };
      const { program, error, exit } = makeHarness(env);
      brokerMocks.runUpCommand.mockClear();

      let exitCode: number | undefined;
      try {
        await program.parseAsync(['node', 'up'], { from: 'user' });
      } catch (err) {
        if (err instanceof ExitSignal) exitCode = err.code;
        else throw err;
      }

      const messages = error.mock.calls.flat().join('\n');
      if (ARM === 'base') {
        // The bug: nothing stood between this start and a duplicate
        // registration — the broker is spawned under a node id a live local
        // broker already serves.
        expect(messages).not.toContain('already served by a live broker');
        expect(brokerMocks.runUpCommand).toHaveBeenCalledTimes(1);
      } else {
        expect(exitCode).toBe(1);
        expect(messages).toContain('node_abc is already served by a live broker on this machine');
        expect(messages).toContain(`pid ${process.pid}`);
        expect(messages).toContain('--force');
        expect(messages).not.toContain('nt_secret');
        expect(brokerMocks.runUpCommand).not.toHaveBeenCalled();
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
