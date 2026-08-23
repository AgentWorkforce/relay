import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { probeCodexEnvironmentCapability, StdioCodexAppServerSession } from './codex-app-server.js';

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => true),
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function nextRequest(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    child.stdin.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').trim())));
  });
}

describe('probeCodexEnvironmentCapability', () => {
  it('requires add and status in the locally generated experimental schema', async () => {
    const readFile = vi.fn(async (file: string) =>
      file.endsWith('ClientRequest.json')
        ? '{"methods":["environment/add","environment/status"]}'
        : '{"required":["environmentId","execServerUrl"],"properties":{"environmentId":{},"execServerUrl":{}}}'
    );
    await expect(
      probeCodexEnvironmentCapability('codex', {
        makeTempDir: async () => '/schema',
        execFile: async () => undefined,
        readFile,
        remove: async () => undefined,
      })
    ).resolves.toMatchObject({ environmentAdd: true, environmentStatus: true });
  });

  it('fails closed when environment/status is unsupported', async () => {
    const remove = vi.fn(async () => undefined);
    await expect(
      probeCodexEnvironmentCapability('codex', {
        makeTempDir: async () => '/schema',
        execFile: async () => undefined,
        readFile: async (file) =>
          file.endsWith('ClientRequest.json')
            ? '{"methods":["environment/add"]}'
            : '{"required":["environmentId","execServerUrl"]}',
        remove,
      })
    ).rejects.toThrow('does not expose both');
    expect(remove).toHaveBeenCalledWith('/schema');
  });

  it('rejects schema drift that could move provider credentials into Relay', async () => {
    await expect(
      probeCodexEnvironmentCapability('codex', {
        makeTempDir: async () => '/schema',
        execFile: async () => undefined,
        readFile: async (file) =>
          file.endsWith('ClientRequest.json')
            ? '{"methods":["environment/add","environment/status"]}'
            : '{"required":["environmentId","execServerUrl"],"properties":{"headers":{}}}',
        remove: async () => undefined,
      })
    ).rejects.toThrow('credential field');
  });
});

describe('StdioCodexAppServerSession', () => {
  it('uses Codex newline RPC without a jsonrpc field and opts into the experimental API', async () => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child);
    const requestPromise = nextRequest(child);
    const initializing = session.initialize();
    const request = await requestPromise;

    expect(request).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent-relay', title: 'Agent Relay managed Codex', version: '1' },
        capabilities: { experimentalApi: true },
      },
    });
    expect(request).not.toHaveProperty('jsonrpc');
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
    await expect(initializing).resolves.toBeUndefined();
    await session.close();
  });

  it('waits for turn/completed and sends the Cloud environment only on the attaching turn', async () => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child);
    const requestPromise = nextRequest(child);
    const running = session.runTurn({
      threadId: 'thread-1',
      text: 'continue',
      environment: { environmentId: 'environment-3', cwd: '/workspace' },
    });
    const request = await requestPromise;
    expect(request).toMatchObject({
      id: 1,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        environments: [{ environmentId: 'environment-3', cwd: '/workspace' }],
      },
    });
    child.stdout.write(`${JSON.stringify({ id: 1, result: { turn: { id: 'turn-1' } } })}\n`);
    child.stdout.write(
      `${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })}\n`
    );
    await expect(running).resolves.toMatchObject({ turnId: 'turn-1' });
    await session.close();
  });
});
