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
    kill: vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return true;
    }),
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function nextRequest(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    child.stdin.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').trim())));
  });
}

function turnPolicySchema(): string {
  return JSON.stringify({
    properties: {
      approvalPolicy: { $ref: '#/definitions/approval' },
      sandboxPolicy: {
        oneOf: [{ $ref: '#/definitions/workspace' }, { $ref: '#/definitions/remote' }],
      },
      clientUserMessageId: {},
    },
    definitions: {
      approval: { enum: ['never'] },
      workspace: {
        properties: { writableRoots: {}, type: { enum: ['workspaceWrite'] } },
      },
      remote: { properties: { type: { enum: ['dangerFullAccess'] } } },
    },
  });
}

function turnsListParamsSchema(): string {
  return JSON.stringify({
    properties: {
      itemsView: { $ref: '#/definitions/items' },
      sortDirection: { $ref: '#/definitions/sort' },
    },
    definitions: { items: { enum: ['full'] }, sort: { enum: ['desc'] } },
  });
}

function turnsListResponseSchema(): string {
  return JSON.stringify({
    properties: { data: { $ref: '#/definitions/data' } },
    definitions: {
      data: {
        properties: {
          clientId: {},
          type: { enum: ['userMessage'] },
          status: { enum: ['completed', 'interrupted', 'failed', 'inProgress'] },
        },
      },
    },
  });
}

function successfulProbeFile(file: string): string {
  if (file.endsWith('ClientRequest.json')) {
    return '{"methods":["environment/add","environment/status","thread/turns/list"]}';
  }
  if (file.endsWith('TurnStartParams.json')) return turnPolicySchema();
  if (file.endsWith('ThreadTurnsListParams.json')) return turnsListParamsSchema();
  if (file.endsWith('ThreadTurnsListResponse.json')) return turnsListResponseSchema();
  return '{"required":["environmentId","execServerUrl"],"properties":{"environmentId":{},"execServerUrl":{}}}';
}

describe('probeCodexEnvironmentCapability', () => {
  it('requires add and status in the locally generated experimental schema', async () => {
    const readFile = vi.fn(async (file: string) => successfulProbeFile(file));
    await expect(
      probeCodexEnvironmentCapability('codex', {
        makeTempDir: async () => '/schema',
        execFile: async () => undefined,
        readFile,
        remove: async () => undefined,
      })
    ).resolves.toMatchObject({
      environmentAdd: true,
      environmentStatus: true,
      explicitTurnPolicy: true,
    });
  });

  it('fails closed when environment/status is unsupported', async () => {
    const remove = vi.fn(async () => undefined);
    await expect(
      probeCodexEnvironmentCapability('codex', {
        makeTempDir: async () => '/schema',
        execFile: async () => undefined,
        readFile: async (file) => {
          if (file.endsWith('ClientRequest.json')) return '{"methods":["environment/add"]}';
          return successfulProbeFile(file);
        },
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
        readFile: async (file) => {
          if (!file.endsWith('EnvironmentAddParams.json')) return successfulProbeFile(file);
          return '{"required":["environmentId","execServerUrl"],"properties":{"headers":{}}}';
        },
        remove: async () => undefined,
      })
    ).rejects.toThrow('credential field');
  });

  it('fails closed when turn/start cannot pin approval and sandbox policy', async () => {
    await expect(
      probeCodexEnvironmentCapability('codex', {
        makeTempDir: async () => '/schema',
        execFile: async () => undefined,
        readFile: async (file) => {
          if (file.endsWith('ClientRequest.json')) return successfulProbeFile(file);
          if (file.endsWith('TurnStartParams.json')) return '{"properties":{}}';
          return successfulProbeFile(file);
        },
        remove: async () => undefined,
      })
    ).rejects.toThrow('execution-policy contract');
  });

  it('fails closed when full turn-history reconciliation is unavailable', async () => {
    await expect(
      probeCodexEnvironmentCapability('codex', {
        makeTempDir: async () => '/schema',
        execFile: async () => undefined,
        readFile: async (file) => {
          if (file.endsWith('ThreadTurnsListResponse.json')) return '{"properties":{"data":{}}}';
          return successfulProbeFile(file);
        },
        remove: async () => undefined,
      })
    ).rejects.toThrow('turn-reconciliation contract');
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

  it('uses never + provider-isolated full access for a selected Cloud environment', async () => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child);
    const requestPromise = nextRequest(child);
    const running = session.runTurn({
      threadId: 'thread-1',
      text: 'continue',
      clientUserMessageId: 'client-turn-1',
      execution: {
        kind: 'remote',
        environment: { environmentId: 'environment-3', cwd: '/workspace' },
      },
    });
    const request = await requestPromise;
    expect(request).toMatchObject({
      id: 1,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'client-turn-1',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
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

  it('reconciles a persisted client user message through full turn history', async () => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child);
    const requestPromise = nextRequest(child);
    const reconciling = session.turnOutcome({
      threadId: 'thread-1',
      clientUserMessageId: 'client-turn-1',
    });
    const request = await requestPromise;
    expect(request).toMatchObject({
      method: 'thread/turns/list',
      params: {
        threadId: 'thread-1',
        itemsView: 'full',
        sortDirection: 'desc',
        limit: 100,
      },
    });
    child.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          data: [
            {
              id: 'turn-1',
              status: 'completed',
              items: [{ type: 'userMessage', clientId: 'client-turn-1' }],
            },
          ],
          nextCursor: null,
        },
      })}\n`
    );
    await expect(reconciling).resolves.toEqual({ status: 'completed', turnId: 'turn-1' });
    await session.close();
  });

  it('pins local turns to a non-networked workspace sandbox and rejects an unexpected approval request', async () => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child);
    const requestPromise = nextRequest(child);
    const running = session.runTurn({
      threadId: 'thread-1',
      text: 'edit the workspace',
      clientUserMessageId: 'client-turn-local',
      execution: { kind: 'local', workspaceRoot: '/repo' },
    });
    const request = await requestPromise;
    expect(request).toMatchObject({
      method: 'turn/start',
      params: {
        approvalPolicy: 'never',
        clientUserMessageId: 'client-turn-local',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/repo'],
          networkAccess: false,
        },
        environments: [],
      },
    });

    const approvalResponse = nextRequest(child);
    child.stdout.write(
      `${JSON.stringify({ id: 91, method: 'item/commandExecution/requestApproval', params: {} })}\n`
    );
    await expect(approvalResponse).resolves.toEqual({
      id: 91,
      error: { code: -32601, message: 'Client request not supported' },
    });

    child.stdout.write(`${JSON.stringify({ id: request.id, result: { turnId: 'turn-local' } })}\n`);
    child.stdout.write(
      `${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-local' } })}\n`
    );
    await expect(running).resolves.toMatchObject({ turnId: 'turn-local' });
    await session.close();
  });

  it('rejects app-server initiated numbered requests instead of leaving them hanging', async () => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child);
    const responsePromise = nextRequest(child);

    child.stdout.write(`${JSON.stringify({ id: 91, method: 'item/tool/request', params: {} })}\n`);

    await expect(responsePromise).resolves.toEqual({
      id: 91,
      error: { code: -32601, message: 'Client request not supported' },
    });
    await session.close();
  });

  it.each([
    ['malformed JSON', '{definitely-not-json}\n'],
    ['non-object JSON', '[]\n'],
    ['oversized unterminated frame', 'x'.repeat(65)],
  ])('fails closed on %s', async (_name, frame) => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child, 30_000, 30_000, undefined, {
      maxFrameBytes: 64,
      closeTimeoutMs: 10,
      forceKillTimeoutMs: 10,
    });

    child.stdout.write(frame);
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
    await expect(session.initialize()).rejects.toThrow('not running');
    await session.close();
  });

  it('fails closed when the notification queue reaches its bound', async () => {
    const child = fakeChild();
    const session = new StdioCodexAppServerSession(child, 30_000, 30_000, undefined, {
      maxBufferedNotifications: 1,
      closeTimeoutMs: 10,
      forceKillTimeoutMs: 10,
    });

    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turnId: 'one' } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turnId: 'two' } })}\n`);

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'));
    await session.close();
  });

  it('forwards and drops more than 1024 observed deltas without starving turn/completed', async () => {
    const child = fakeChild();
    const onNotification = vi.fn();
    const session = new StdioCodexAppServerSession(child, 30_000, 30_000, onNotification, {
      maxBufferedNotifications: 2,
      closeTimeoutMs: 10,
      forceKillTimeoutMs: 10,
    });
    const requestPromise = nextRequest(child);
    const running = session.runTurn({
      threadId: 'thread-1',
      text: 'long turn',
      clientUserMessageId: 'client-turn-long',
      execution: { kind: 'local', workspaceRoot: '/repo' },
    });
    const request = await requestPromise;

    for (let index = 0; index < 1_100; index += 1) {
      child.stdout.write(
        `${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: String(index) } })}\n`
      );
    }
    child.stdout.write(`${JSON.stringify({ id: request.id, result: { turnId: 'turn-long' } })}\n`);
    child.stdout.write(
      `${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-long' } })}\n`
    );

    await expect(running).resolves.toMatchObject({ turnId: 'turn-long' });
    expect(onNotification).toHaveBeenCalledTimes(1_101);
    expect(child.kill).not.toHaveBeenCalled();
    await session.close();
  });

  it('waits for exit and escalates to SIGKILL before allowing replacement', async () => {
    const child = fakeChild();
    vi.mocked(child.kill).mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        queueMicrotask(() => {
          (child as unknown as { exitCode: number | null }).exitCode = 137;
          child.emit('exit', null, 'SIGKILL');
        });
      }
      return true;
    });
    const session = new StdioCodexAppServerSession(child, 30_000, 30_000, undefined, {
      closeTimeoutMs: 1,
      forceKillTimeoutMs: 20,
    });

    await session.close();

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });
});
