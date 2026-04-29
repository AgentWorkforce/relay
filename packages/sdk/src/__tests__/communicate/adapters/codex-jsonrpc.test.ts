import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'vitest';

const jsonRpcModulePath = '../../../communicate/adapters/codex-jsonrpc.js';

async function loadJsonRpcModule(): Promise<any> {
  return import(jsonRpcModulePath);
}

function createFakeTransport() {
  const clientStdin = new PassThrough();
  const clientStdout = new PassThrough();
  const clientStderr = new PassThrough();
  const exitCallbacks: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  return {
    peerInput: clientStdin,
    peerOutput: clientStdout,
    transport: {
      stdin: clientStdin,
      stdout: clientStdout,
      stderr: clientStderr,
      kill() {
        return true;
      },
      onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void) {
        exitCallbacks.push(callback);
      },
    },
    emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      for (const callback of exitCallbacks) {
        callback(code, signal);
      }
    },
  };
}

async function readJsonLine(input: PassThrough): Promise<any> {
  const [chunk] = await once(input, 'data');
  const line = chunk.toString().trim();
  return JSON.parse(line);
}

function writeJsonLine(output: PassThrough, message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}

test('CodexJsonRpcClient performs initialize handshake and initialized notification', async () => {
  const { CodexJsonRpcClient } = await loadJsonRpcModule();
  const fake = createFakeTransport();
  const client = new CodexJsonRpcClient(fake.transport);

  const initializePromise = client.initialize({
    clientInfo: {
      version: '6.0.3',
    },
    capabilities: {
      experimentalApi: false,
    },
  });

  const initializeRequest = await readJsonLine(fake.peerInput);
  assert.equal(initializeRequest.jsonrpc, '2.0');
  assert.equal(initializeRequest.method, 'initialize');
  assert.deepEqual(initializeRequest.params.clientInfo, {
    name: 'agent_relay',
    title: 'Agent Relay',
    version: '6.0.3',
  });
  assert.deepEqual(initializeRequest.params.capabilities, {
    experimentalApi: false,
  });

  writeJsonLine(fake.peerOutput, {
    jsonrpc: '2.0',
    id: initializeRequest.id,
    result: {
      userAgent: 'codex-cli 0.124.0',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
    },
  });

  const initializedNotification = await readJsonLine(fake.peerInput);
  assert.deepEqual(initializedNotification, {
    jsonrpc: '2.0',
    method: 'initialized',
  });

  const response = await initializePromise;
  assert.equal(response.userAgent, 'codex-cli 0.124.0');
});

test('CodexJsonRpcClient resolves requests and dispatches server notifications', async () => {
  const { CodexJsonRpcClient } = await loadJsonRpcModule();
  const fake = createFakeTransport();
  const client = new CodexJsonRpcClient(fake.transport);
  const seenNotifications: any[] = [];
  let resolveNotification!: () => void;
  const notificationPromise = new Promise<void>((resolve) => {
    resolveNotification = resolve;
  });

  client.onNotification((notification: any) => {
    seenNotifications.push(notification);
    resolveNotification();
  });

  const requestPromise = client.request('thread/start', { cwd: '/repo' });
  const request = await readJsonLine(fake.peerInput);
  assert.equal(request.method, 'thread/start');
  assert.deepEqual(request.params, { cwd: '/repo' });

  writeJsonLine(fake.peerOutput, {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      thread: {
        id: 'thread-1',
      },
    },
  });
  writeJsonLine(fake.peerOutput, {
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
      },
    },
  });

  assert.deepEqual(await requestPromise, { thread: { id: 'thread-1' } });
  await notificationPromise;
  assert.deepEqual(seenNotifications, [
    {
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
        },
      },
    },
  ]);
});

test('CodexJsonRpcClient rejects JSON-RPC error responses', async () => {
  const { CodexJsonRpcClient, CodexJsonRpcError } = await loadJsonRpcModule();
  const fake = createFakeTransport();
  const client = new CodexJsonRpcClient(fake.transport);

  const requestPromise = client.request('turn/steer', { threadId: 'thread-1' });
  const request = await readJsonLine(fake.peerInput);

  writeJsonLine(fake.peerOutput, {
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32602,
      message: 'Invalid params',
    },
  });

  await assert.rejects(requestPromise, CodexJsonRpcError);
});
