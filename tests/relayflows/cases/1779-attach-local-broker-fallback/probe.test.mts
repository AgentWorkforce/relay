import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The runner copies this file into <target>/.relay-pr-proof/.
import { registerLocalAgentCommands } from '../packages/cli/src/cli/commands/local-agent.js';
import { readConnectionFileFromDisk } from '../packages/cli/src/cli/lib/broker-connection.js';

const ARM = process.env.RELAY_PR_PROOF_ARM;
const URL = 'http://127.0.0.1:9999';
const FLEET_ERROR = "Agent 'worker' has no live Fleet placement on the persisted remote session";
let root: string;
let stateDir: string;

beforeEach(() => {
  expect(['base', 'head']).toContain(ARM);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-proof-1779-'));
  stateDir = path.join(root, '.agentworkforce/relay');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'connection.json'), JSON.stringify({ url: URL }));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function harness(health: 'healthy' | 'refused' | 'unhealthy' | 'hung' = 'healthy') {
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    if (health === 'refused') throw new Error('ECONNREFUSED');
    if (health === 'hung') {
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return new Response(null, { status: health === 'healthy' ? 200 : 503 });
  });
  // Model the persisted-session/no-placement response at the same injected
  // boundary as the CLI unit tests. The routing decision itself is production code.
  const resolveFleetAttachTarget = vi.fn(async () => ({ error: FLEET_ERROR }));
  const attach = vi.fn(async () => 0);
  const attachNode = vi.fn(async () => 0);
  const client = {
    flushPending: vi.fn(async () => ({ flushed: 1 })),
    setInboundDeliveryMode: vi.fn(async (_name: string, mode: string) => ({ mode, flushed: 0 })),
  };
  const connectLocal = vi.fn(async () => client as never);
  const error = vi.fn();
  const exit = vi.fn();
  const program = new Command();
  program.exitOverride();
  registerLocalAgentCommands(program.command('local'), {
    env: {},
    cwd: () => root,
    getDefaultStateDir: () => stateDir,
    readConnectionFile: readConnectionFileFromDisk,
    fetch: fetch as typeof globalThis.fetch,
    resolveFleetAttachTarget,
    attach,
    attachNode,
    connectLocal,
    error,
    exit: exit as never,
    log: vi.fn(),
  });
  return { program, fetch, resolveFleetAttachTarget, attach, attachNode, connectLocal, client, error, exit };
}

function assertHealthProbe(h: ReturnType<typeof harness>) {
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.fetch).toHaveBeenCalledWith(`${URL}/health`, { signal: expect.any(AbortSignal) });
}

describe('1779 local broker discovery before Fleet routing', () => {
  it.each(['attach', 'flush', 'hold', 'auto'])(
    '%s uses a healthy discovered broker despite persisted Fleet credentials',
    async (command) => {
      const h = harness();
      const args = command === 'attach' ? ['attach'] : ['message', command];
      await h.program.parseAsync(['local', 'agent', ...args, 'worker'], { from: 'user' });

      expect(h.attachNode).not.toHaveBeenCalled();
      if (ARM === 'base') {
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.resolveFleetAttachTarget).toHaveBeenCalledExactlyOnceWith('worker');
        expect(h.error).toHaveBeenCalledExactlyOnceWith(`Error: ${FLEET_ERROR}`);
        expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(h.attach).not.toHaveBeenCalled();
        expect(h.connectLocal).not.toHaveBeenCalled();
        expect(h.client.flushPending).not.toHaveBeenCalled();
        expect(h.client.setInboundDeliveryMode).not.toHaveBeenCalled();
        return;
      }

      assertHealthProbe(h);
      expect(h.resolveFleetAttachTarget).not.toHaveBeenCalled();
      expect(h.error).not.toHaveBeenCalled();
      expect(h.exit).not.toHaveBeenCalled();
      if (command === 'attach') {
        expect(h.attach).toHaveBeenCalledExactlyOnceWith('worker', 'view', expect.anything());
        expect(h.connectLocal).not.toHaveBeenCalled();
      } else {
        expect(h.attach).not.toHaveBeenCalled();
        expect(h.connectLocal).toHaveBeenCalledExactlyOnceWith(root, expect.anything());
        if (command === 'flush') {
          expect(h.client.flushPending).toHaveBeenCalledExactlyOnceWith('worker');
          expect(h.client.setInboundDeliveryMode).not.toHaveBeenCalled();
        } else {
          expect(h.client.setInboundDeliveryMode).toHaveBeenCalledExactlyOnceWith(
            'worker',
            command === 'hold' ? 'manual_flush' : 'auto_inject'
          );
          expect(h.client.flushPending).not.toHaveBeenCalled();
        }
      }
    }
  );

  it.each(['refused', 'unhealthy', 'hung'] as const)(
    'attach preserves Fleet routing for a %s local broker',
    async (health) => {
      vi.useFakeTimers();
      const h = harness(health);
      h.resolveFleetAttachTarget.mockResolvedValue({
        target: { node: 'remote-node', baseUrl: 'https://fleet.example.test', agent: 'worker' },
      } as never);
      const dispatch = h.program.parseAsync(['local', 'agent', 'attach', 'worker'], { from: 'user' });
      if (health === 'hung') {
        await vi.advanceTimersByTimeAsync(749);
        if (ARM === 'head') {
          assertHealthProbe(h);
          expect(h.fetch.mock.calls[0][1].signal!.aborted).toBe(false);
          expect(h.resolveFleetAttachTarget).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(1);
        if (ARM === 'head') expect(h.fetch.mock.calls[0][1].signal!.aborted).toBe(true);
      }
      await dispatch;
      if (ARM === 'head') assertHealthProbe(h);
      else expect(h.fetch).not.toHaveBeenCalled();
      expect(h.resolveFleetAttachTarget).toHaveBeenCalledExactlyOnceWith('worker');
      expect(h.attachNode).toHaveBeenCalledExactlyOnceWith(
        'worker',
        'view',
        'remote-node',
        expect.objectContaining({ baseUrl: 'https://fleet.example.test' })
      );
      expect(h.attach).not.toHaveBeenCalled();
      expect(h.error).not.toHaveBeenCalled();
      expect(h.exit).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
